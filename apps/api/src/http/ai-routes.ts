import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { ForbiddenError } from '../errors/app-error.js';
import type { IdentityService } from '../modules/identity/index.js';
import { RbacPolicy } from '../modules/identity/rbac/policy.js';
import { createAuthMiddleware, requireActor } from './auth-middleware.js';
import type {
  AiOrchestrator,
  RagService,
  WhatsAppAdapter,
  IAiStore,
  IAiService,
  DocumentCategory,
} from '../modules/ai/index.js';

export interface AiRoutesOptions {
  orchestrator: AiOrchestrator;
  ragService: RagService;
  whatsAppAdapter: WhatsAppAdapter;
  store: IAiStore;
  aiService?: IAiService | undefined;
  whatsAppWebhookSecret?: string | undefined;
  whatsAppVerifyToken?: string | undefined;
}

const chatBodySchema = z.object({
  message: z.string().min(1, 'Message cannot be empty'),
  conversationId: z.string().optional(),
  channel: z.enum(['WEB', 'WHATSAPP', 'API']).optional().default('WEB'),
});

const ingestDocBodySchema = z.object({
  documentId: z.string().optional(),
  title: z.string().min(1, 'Title is required'),
  category: z.enum([
    'PRODUCT_INFO',
    'SPECIFICATION',
    'POLICY',
    'FAQ',
    'SHIPPING',
    'RETURNS',
    'WARRANTY',
    'MERCHANT_DOC',
    'GENERAL',
  ]),
  content: z.string().min(1, 'Content is required'),
  sourceType: z.string().optional().default('MANUAL'),
  sourceId: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
});

const ragQueryBodySchema = z.object({
  query: z.string().min(1, 'Query is required'),
  category: z
    .enum([
      'PRODUCT_INFO',
      'SPECIFICATION',
      'POLICY',
      'FAQ',
      'SHIPPING',
      'RETURNS',
      'WARRANTY',
      'MERCHANT_DOC',
      'GENERAL',
    ])
    .optional(),
  topK: z.number().int().positive().optional().default(3),
});

const waWebhookBodySchema = z.object({
  messageId: z.string().min(1),
  from: z.string().min(1),
  to: z.string().min(1),
  text: z.string().min(1),
  tenantId: z.string().optional().default('default-tenant'),
});

const waLinkBodySchema = z.object({
  phoneNumber: z.string().min(5),
});

export function registerAiRoutes(
  app: FastifyInstance,
  identityService: IdentityService,
  options: AiRoutesOptions,
): void {
  const authenticate = createAuthMiddleware(identityService);
  const {
    orchestrator,
    ragService,
    whatsAppAdapter,
    store,
    aiService,
    whatsAppWebhookSecret,
    whatsAppVerifyToken,
  } = options;

  // 1. Interactive Chat Endpoint
  app.post(
    '/ai/chat',
    { preHandler: authenticate },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const actor = requireActor(req);
      RbacPolicy.requirePermission(actor, 'ai:chat');

      const body = chatBodySchema.parse(req.body);

      const runner = aiService ?? orchestrator;
      const response = await runner.processMessage({
        actor,
        tenantId: actor.tenantId,
        channel: body.channel,
        externalUserId: actor.userId,
        userText: body.message,
        conversationId: body.conversationId,
        customerId: actor.role === 'CUSTOMER' ? actor.userId : undefined,
      });

      return reply.status(200).send(response);
    },
  );

  // 2. Conversation & History Query Endpoint
  app.get(
    '/ai/conversations/:id',
    { preHandler: authenticate },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const actor = requireActor(req);
      RbacPolicy.requirePermission(actor, 'ai:chat');

      const { id } = req.params as { id: string };

      if (aiService) {
        const result = await aiService.getConversation(actor, id);
        if (!result) {
          return reply.status(404).send({ error: 'Conversation not found' });
        }
        if (actor.role === 'CUSTOMER' && result.conversation.customerId && result.conversation.customerId !== actor.userId) {
          throw new ForbiddenError('Cannot inspect another customer\'s conversation history');
        }
        return reply.status(200).send(result);
      }

      const conv = await store.getConversationById(actor.tenantId, id);
      if (!conv) {
        return reply.status(404).send({ error: 'Conversation not found' });
      }

      // Customer scoping: Customer can only inspect their own conversations
      if (actor.role === 'CUSTOMER' && conv.customerId && conv.customerId !== actor.userId) {
        throw new ForbiddenError('Cannot inspect another customer\'s conversation history');
      }

      const messages = await store.listMessages(conv.id, 50);

      return reply.status(200).send({
        conversation: conv,
        messages,
      });
    },
  );

  // 3. Document Ingestion Endpoint (Merchant / Admin only)
  app.post(
    '/ai/documents',
    { preHandler: authenticate },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const actor = requireActor(req);
      RbacPolicy.requirePermission(actor, 'ai:documents:manage');

      const body = ingestDocBodySchema.parse(req.body);

      const input = {
        tenantId: actor.tenantId,
        documentId: body.documentId,
        title: body.title,
        category: body.category as DocumentCategory,
        content: body.content,
        sourceType: body.sourceType,
        sourceId: body.sourceId,
        metadata: body.metadata,
      };

      const result = aiService
        ? await aiService.ingestDocument(actor, input)
        : await ragService.ingestDocument(input);

      return reply.status(201).send({
        document: result.document,
        version: result.version,
        chunkCount: result.chunkCount,
      });
    },
  );

  // 4. List Documents Endpoint
  app.get(
    '/ai/documents',
    { preHandler: authenticate },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const actor = requireActor(req);
      RbacPolicy.requirePermission(actor, 'ai:documents:read');

      const query = (req.query as { category?: DocumentCategory } | undefined) ?? {};
      const docs = aiService
        ? await aiService.listDocuments(actor, query.category)
        : await store.listDocuments(actor.tenantId, query.category);
      return reply.status(200).send({ documents: docs });
    },
  );

  // 5. Deactivate / Archive Document Endpoint
  app.delete(
    '/ai/documents/:id',
    { preHandler: authenticate },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const actor = requireActor(req);
      RbacPolicy.requirePermission(actor, 'ai:documents:manage');

      const { id } = req.params as { id: string };
      if (aiService) {
        await aiService.deleteDocument(actor, id);
      } else {
        await ragService.deleteDocument(actor.tenantId, id);
      }
      return reply.status(200).send({ message: 'Document archived and vectors deactivated' });
    },
  );

  // 6. Diagnostics RAG Retrieval Test Endpoint (Operator / Admin only)
  app.post(
    '/ai/rag/query',
    { preHandler: authenticate },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const actor = requireActor(req);
      RbacPolicy.requirePermission(actor, 'ai:diagnostics:read');

      const body = ragQueryBodySchema.parse(req.body);
      const result = aiService
        ? await aiService.queryRag(actor, body.query, body.category, body.topK)
        : await ragService.retrieveKnowledge(
            actor.tenantId,
            body.query,
            body.category,
            body.topK,
          );

      return reply.status(200).send(result);
    },
  );

  // 7. WhatsApp Webhook Verification Handshake (Meta GET Challenge)
  app.get('/ai/whatsapp/webhook', async (req: FastifyRequest, reply: FastifyReply) => {
    const query = req.query as {
      'hub.mode'?: string;
      'hub.verify_token'?: string;
      'hub.challenge'?: string;
    };

    const expectedToken = whatsAppVerifyToken ?? 'commerce_wa_verify_token_default';
    const verification = whatsAppAdapter.verifyWebhookSubscription(
      {
        mode: query['hub.mode'],
        verifyToken: query['hub.verify_token'],
        challenge: query['hub.challenge'],
      },
      expectedToken,
    );

    if (verification.valid && verification.challenge) {
      return reply.status(200).type('text/plain').send(verification.challenge);
    }

    return reply.status(403).send({ error: 'Forbidden: Invalid verify token' });
  });

  // 8. WhatsApp Inbound Webhook Endpoint (HMAC signature verification + dual payload support)
  app.post('/ai/whatsapp/webhook', async (req: FastifyRequest, reply: FastifyReply) => {
    const signature =
      (req.headers['x-hub-signature-256'] as string | undefined) ??
      (req.headers['x-whatsapp-signature'] as string | undefined) ??
      '';

    const secret = whatsAppWebhookSecret ?? 'default-wa-secret-123';
    const rawBody = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
    const parsedBody =
      typeof req.body === 'string'
        ? (JSON.parse(req.body) as Record<string, unknown>)
        : (req.body as Record<string, unknown>);

    const inboundMessages = whatsAppAdapter.parseWebhookPayload(parsedBody, 'default-tenant');

    if (inboundMessages.length === 0) {
      // Direct schema validation fallback for testing or manual invocations
      const body = waWebhookBodySchema.parse(parsedBody);
      inboundMessages.push({
        messageId: body.messageId,
        fromNumber: body.from,
        toNumber: body.to,
        text: body.text,
        timestamp: new Date().toISOString(),
        tenantId: body.tenantId,
      });
    }

    const results = [];
    for (const message of inboundMessages) {
      const result = await whatsAppAdapter.handleInboundWebhook({
        rawBody,
        signatureHeader: signature,
        webhookSecret: secret,
        tenantId: message.tenantId,
        message,
      });
      results.push(result);
    }

    const primaryResult = results[0] ?? { processed: false };
    return reply.status(200).send({
      success: true,
      processedCount: results.filter((r) => r.processed).length,
      ...primaryResult,
      results,
    });
  });

  // 9. WhatsApp Customer Phone Linking Endpoint
  // 9a. WhatsApp Customer Phone Linking Request (Dispatches 6-digit verification code)
  app.post(
    '/ai/whatsapp/link/request',
    { preHandler: authenticate },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const actor = requireActor(req);
      RbacPolicy.requirePermission(actor, 'ai:chat');

      const body = waLinkBodySchema.parse(req.body);
      const result = await whatsAppAdapter.requestPhoneLinking(
        actor.tenantId,
        actor.userId,
        body.phoneNumber,
      );

      return reply.status(200).send({
        success: true,
        message: 'Verification code sent to WhatsApp phone number',
        expiresAt: result.expiresAt,
      });
    },
  );

  // 9b. WhatsApp Customer Phone Linking Confirmation (Verifies 6-digit code)
  app.post(
    '/ai/whatsapp/link/verify',
    { preHandler: authenticate },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const actor = requireActor(req);
      RbacPolicy.requirePermission(actor, 'ai:chat');

      const body = z.object({
        phoneNumber: z.string().min(5),
        code: z.string().length(6),
      }).parse(req.body);

      const verified = await whatsAppAdapter.confirmPhoneLinking(
        actor.tenantId,
        actor.userId,
        body.phoneNumber,
        body.code,
      );

      return reply.status(200).send({
        success: verified,
        message: 'Phone number verified and linked successfully',
      });
    },
  );

  // 9c. Direct WhatsApp Phone Linking (Admin or test setup)
  app.post(
    '/ai/whatsapp/link',
    { preHandler: authenticate },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const actor = requireActor(req);
      RbacPolicy.requirePermission(actor, 'ai:chat');

      const body = waLinkBodySchema.parse(req.body);

      const mapping = await whatsAppAdapter.linkPhoneNumber(
        actor.tenantId,
        actor.userId,
        body.phoneNumber,
        true,
      );

      return reply.status(200).send({
        success: true,
        phoneNumber: mapping.phoneNumber,
        isVerified: mapping.isVerified,
      });
    },
  );

  // 10. Admin WhatsApp Integration & Status Endpoint
  app.get(
    '/ai/whatsapp/status',
    { preHandler: authenticate },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const actor = requireActor(req);
      RbacPolicy.requirePermission(actor, 'admin:manage-users');

      const provider = whatsAppAdapter.getProvider();
      const webhooks = await store.listWebhooks(actor.tenantId, 100);
      const conversations = await store.listConversations(actor.tenantId, 'WHATSAPP', 100);

      const processedCount = webhooks.filter((w) => w.status === 'PROCESSED').length;
      const duplicateCount = webhooks.filter((w) => w.status === 'DUPLICATE').length;
      const failedCount = webhooks.filter((w) => w.status === 'FAILED').length;

      return reply.status(200).send({
        provider: provider.providerName,
        status: 'ACTIVE',
        webhookEndpoint: '/ai/whatsapp/webhook',
        verifyTokenConfigured: Boolean(whatsAppVerifyToken),
        totalWebhooksReceived: webhooks.length,
        processedCount,
        duplicateCount,
        failedCount,
        activeConversationsCount: conversations.length,
      });
    },
  );

  // 11. Admin WhatsApp Recent Conversations
  app.get(
    '/ai/whatsapp/conversations',
    { preHandler: authenticate },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const actor = requireActor(req);
      RbacPolicy.requirePermission(actor, 'admin:manage-users');

      const limit = Number((req.query as { limit?: string } | undefined)?.limit ?? 50);
      const conversations = await store.listConversations(actor.tenantId, 'WHATSAPP', limit);
      return reply.status(200).send({ conversations });
    },
  );

  // 12. Admin WhatsApp Webhooks Activity Feed
  app.get(
    '/ai/whatsapp/webhooks',
    { preHandler: authenticate },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const actor = requireActor(req);
      RbacPolicy.requirePermission(actor, 'admin:manage-users');

      const limit = Number((req.query as { limit?: string } | undefined)?.limit ?? 50);
      const webhooks = await store.listWebhooks(actor.tenantId, limit);
      return reply.status(200).send({ webhooks });
    },
  );

  // 13. Admin AI Audit Logs
  app.get(
    '/ai/audit',
    { preHandler: authenticate },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const actor = requireActor(req);
      RbacPolicy.requirePermission(actor, 'admin:view-audit');

      const limit = Number((req.query as { limit?: string } | undefined)?.limit ?? 100);
      const logs = await store.listAuditLogs(actor.tenantId, limit);
      return reply.status(200).send({ logs, records: logs });
    },
  );
}
