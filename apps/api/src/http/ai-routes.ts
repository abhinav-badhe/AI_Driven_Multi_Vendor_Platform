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
  DocumentCategory,
} from '../modules/ai/index.js';

export interface AiRoutesOptions {
  orchestrator: AiOrchestrator;
  ragService: RagService;
  whatsAppAdapter: WhatsAppAdapter;
  store: IAiStore;
  whatsAppWebhookSecret?: string | undefined;
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
  const { orchestrator, ragService, whatsAppAdapter, store, whatsAppWebhookSecret } = options;

  // 1. Interactive Chat Endpoint
  app.post(
    '/ai/chat',
    { preHandler: authenticate },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const actor = requireActor(req);
      RbacPolicy.requirePermission(actor, 'ai:chat');

      const body = chatBodySchema.parse(req.body);

      const response = await orchestrator.processMessage({
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

      const result = await ragService.ingestDocument({
        tenantId: actor.tenantId,
        documentId: body.documentId,
        title: body.title,
        category: body.category as DocumentCategory,
        content: body.content,
        sourceType: body.sourceType,
        sourceId: body.sourceId,
        metadata: body.metadata,
      });

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
      const docs = await store.listDocuments(actor.tenantId, query.category);
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
      await ragService.deleteDocument(actor.tenantId, id);
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
      const result = await ragService.retrieveKnowledge(
        actor.tenantId,
        body.query,
        body.category,
        body.topK,
      );

      return reply.status(200).send(result);
    },
  );

  // 7. WhatsApp Inbound Webhook Endpoint (No JWT auth, HMAC signature verification)
  app.post('/ai/whatsapp/webhook', async (req: FastifyRequest, reply: FastifyReply) => {
    const signature =
      (req.headers['x-hub-signature-256'] as string | undefined) ??
      (req.headers['x-whatsapp-signature'] as string | undefined) ??
      '';

    const secret = whatsAppWebhookSecret ?? 'default-wa-secret-123';
    const rawBody = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
    const body = waWebhookBodySchema.parse(typeof req.body === 'string' ? JSON.parse(req.body) : req.body);

    const result = await whatsAppAdapter.handleInboundWebhook({
      rawBody,
      signatureHeader: signature,
      webhookSecret: secret,
      tenantId: body.tenantId,
      message: {
        messageId: body.messageId,
        fromNumber: body.from,
        toNumber: body.to,
        text: body.text,
        timestamp: new Date().toISOString(),
        tenantId: body.tenantId,
      },
    });

    return reply.status(200).send({ success: true, ...result });
  });

  // 8. WhatsApp Customer Phone Linking Endpoint
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
}
