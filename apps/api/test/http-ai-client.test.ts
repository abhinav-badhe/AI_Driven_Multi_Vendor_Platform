import { describe, it, expect, vi } from 'vitest';
import {
  HttpAiClient,
  type IAiService,
  type SendMessageInput,
  type OrchestratorResponse,
  type ConversationRecord,
  type MessageRecord,
  type KnowledgeDocumentRecord,
  type KnowledgeVersionRecord,
  type RetrievalResult,
} from '../src/modules/ai/index.js';
import type { AuthorizedActor } from '../src/modules/identity/rbac/policy.js';
import { ValidationError, ForbiddenError, UnauthorizedError } from '../src/errors/app-error.js';

const mockCustomerActor: AuthorizedActor = {
  userId: 'usr-cust-1',
  tenantId: 'tenant-1',
  role: 'CUSTOMER',
};

const mockAdminActor: AuthorizedActor = {
  userId: 'usr-admin-1',
  tenantId: 'tenant-1',
  role: 'ADMINISTRATOR',
};

const mockConversation: ConversationRecord = {
  id: 'conv-123',
  tenantId: 'tenant-1',
  channel: 'WEB',
  externalUserId: 'usr-cust-1',
  customerId: 'usr-cust-1',
  title: 'Shipping question',
  status: 'ACTIVE',
  metadata: {},
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

const mockMessage: MessageRecord = {
  id: 'msg-123',
  conversationId: 'conv-123',
  tenantId: 'tenant-1',
  role: 'USER',
  content: 'Where is my order?',
  metadata: {},
  createdAt: new Date().toISOString(),
};

const mockDocument: KnowledgeDocumentRecord = {
  id: 'doc-123',
  tenantId: 'tenant-1',
  title: 'Return Policy',
  category: 'RETURNS',
  sourceType: 'MANUAL',
  currentVersion: 1,
  status: 'INDEXED',
  metadata: {},
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

const mockVersion: KnowledgeVersionRecord = {
  id: 'ver-123',
  documentId: 'doc-123',
  tenantId: 'tenant-1',
  version: 1,
  rawContent: 'Items can be returned within 30 days.',
  cleanedContent: 'Items can be returned within 30 days.',
  chunkCount: 1,
  status: 'INDEXED',
  createdAt: new Date().toISOString(),
};

describe('HttpAiClient', () => {
  const baseUrl = 'http://ai-service.internal:4170';

  it('dispatches processMessage with propagated actor headers and returns orchestrator response', async () => {
    let capturedUrl = '';
    let capturedHeaders: Record<string, string> = {};
    let capturedBody: unknown;

    const mockResponse: OrchestratorResponse = {
      conversationId: 'conv-123',
      replyText: 'Your order ord-1 is out for delivery today!',
      channel: 'WEB',
      toolCallsExecuted: ['trackOrder'],
      sourcesRetrieved: [],
      status: 'COMPLETED',
    };

    const mockFetch = vi.fn().mockImplementation(async (url: string, opts: RequestInit) => {
      capturedUrl = url;
      capturedHeaders = opts.headers as Record<string, string>;
      capturedBody = JSON.parse(opts.body as string);
      return new Response(JSON.stringify(mockResponse), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    const client = new HttpAiClient(baseUrl, {
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    const input: SendMessageInput = {
      actor: mockCustomerActor,
      tenantId: 'tenant-1',
      channel: 'WEB',
      externalUserId: mockCustomerActor.userId,
      userText: 'Where is my order ord-1?',
      conversationId: 'conv-123',
    };

    const result = await client.processMessage(input);

    expect(capturedUrl).toBe(`${baseUrl}/ai/chat`);
    expect(capturedHeaders['x-user-id']).toBe(mockCustomerActor.userId);
    expect(capturedHeaders['x-tenant-id']).toBe(mockCustomerActor.tenantId);
    expect(capturedHeaders['x-user-role']).toBe(mockCustomerActor.role);
    expect(capturedBody).toEqual({
      message: 'Where is my order ord-1?',
      conversationId: 'conv-123',
      channel: 'WEB',
    });
    expect(result.replyText).toContain('out for delivery today');
    expect(result.toolCallsExecuted).toContain('trackOrder');
  });

  it('retrieves conversation and message history by ID', async () => {
    let capturedUrl = '';
    const mockFetch = vi.fn().mockImplementation(async (url: string) => {
      capturedUrl = url;
      return new Response(
        JSON.stringify({
          conversation: mockConversation,
          messages: [mockMessage],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });

    const client = new HttpAiClient(baseUrl, {
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    const result = await client.getConversation(mockCustomerActor, 'conv-123');
    expect(capturedUrl).toBe(`${baseUrl}/ai/conversations/conv-123`);
    expect(result?.conversation.id).toBe('conv-123');
    expect(result?.messages).toHaveLength(1);
  });

  it('returns null when conversation is not found (404)', async () => {
    const mockFetch = vi.fn().mockImplementation(async () => {
      return new Response(JSON.stringify({ error: 'Conversation not found' }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      });
    });

    const client = new HttpAiClient(baseUrl, {
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    const result = await client.getConversation(mockCustomerActor, 'nonexistent-id');
    expect(result).toBeNull();
  });

  it('lists conversations with channel and limit filters', async () => {
    let capturedUrl = '';
    const mockFetch = vi.fn().mockImplementation(async (url: string) => {
      capturedUrl = url;
      return new Response(JSON.stringify({ conversations: [mockConversation] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    const client = new HttpAiClient(baseUrl, {
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    const result = await client.listConversations(mockAdminActor, 'WEB', 10);
    expect(capturedUrl).toContain('/ai/whatsapp/conversations?channel=WEB&limit=10');
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe('conv-123');
  });

  it('ingests knowledge document into RAG pipeline', async () => {
    let capturedBody: unknown;
    const mockFetch = vi.fn().mockImplementation(async (_url: string, opts: RequestInit) => {
      capturedBody = JSON.parse(opts.body as string);
      return new Response(
        JSON.stringify({
          document: mockDocument,
          version: mockVersion,
          chunkCount: 1,
        }),
        { status: 201, headers: { 'content-type': 'application/json' } },
      );
    });

    const client = new HttpAiClient(baseUrl, {
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    const result = await client.ingestDocument(mockAdminActor, {
      tenantId: 'tenant-1',
      title: 'Return Policy',
      category: 'RETURNS',
      content: 'Items can be returned within 30 days.',
      sourceType: 'MANUAL',
    });

    expect(result.document.id).toBe('doc-123');
    expect(result.chunkCount).toBe(1);
    expect((capturedBody as Record<string, unknown>).title).toBe('Return Policy');
  });

  it('lists documents with optional category filter', async () => {
    let capturedUrl = '';
    const mockFetch = vi.fn().mockImplementation(async (url: string) => {
      capturedUrl = url;
      return new Response(JSON.stringify({ documents: [mockDocument] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    const client = new HttpAiClient(baseUrl, {
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    const result = await client.listDocuments(mockAdminActor, 'RETURNS');
    expect(capturedUrl).toBe(`${baseUrl}/ai/documents?category=RETURNS`);
    expect(result).toHaveLength(1);
    expect(result[0]!.category).toBe('RETURNS');
  });

  it('deletes document and vector indexes', async () => {
    let capturedUrl = '';
    let capturedMethod = '';
    const mockFetch = vi.fn().mockImplementation(async (url: string, opts: RequestInit) => {
      capturedUrl = url;
      capturedMethod = opts.method!;
      return new Response(JSON.stringify({ message: 'Document archived' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    const client = new HttpAiClient(baseUrl, {
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    await client.deleteDocument(mockAdminActor, 'doc-123');
    expect(capturedUrl).toBe(`${baseUrl}/ai/documents/doc-123`);
    expect(capturedMethod).toBe('DELETE');
  });

  it('executes diagnostic RAG semantic query', async () => {
    const mockRagResult: RetrievalResult = {
      query: 'What is the return period?',
      groundedContext: 'Policies say return within 30 days.',
      chunks: [
        {
          documentId: 'doc-123',
          tenantId: 'tenant-1',
          version: 1,
          title: 'Return Policy',
          category: 'RETURNS',
          content: 'Policies say return within 30 days.',
          score: 0.95,
        },
      ],
    };

    const mockFetch = vi.fn().mockImplementation(async () => {
      return new Response(JSON.stringify(mockRagResult), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    const client = new HttpAiClient(baseUrl, {
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    const result = await client.queryRag(
      mockAdminActor,
      'What is the return period?',
      'RETURNS',
      3,
    );
    expect(result.groundedContext).toContain('30 days');
    expect(result.chunks[0]?.documentId).toBe('doc-123');
  });

  it('maps HTTP errors to ValidationError, UnauthorizedError, and ForbiddenError', async () => {
    const client400 = new HttpAiClient(baseUrl, {
      fetchFn: vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ error: 'Message empty' }), { status: 400 }),
        ),
    });
    await expect(
      client400.processMessage({
        actor: mockCustomerActor,
        tenantId: 'tenant-1',
        channel: 'WEB',
        externalUserId: 'usr-1',
        userText: '',
      }),
    ).rejects.toThrow(ValidationError);

    const client401 = new HttpAiClient(baseUrl, {
      fetchFn: vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 }),
        ),
    });
    await expect(
      client401.processMessage({
        actor: mockCustomerActor,
        tenantId: 'tenant-1',
        channel: 'WEB',
        externalUserId: 'usr-1',
        userText: 'Hello',
      }),
    ).rejects.toThrow(UnauthorizedError);

    const client403 = new HttpAiClient(baseUrl, {
      fetchFn: vi
        .fn()
        .mockResolvedValue(new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403 })),
    });
    await expect(client403.deleteDocument(mockCustomerActor, 'doc-1')).rejects.toThrow(
      ForbiddenError,
    );
  });

  it('falls back to fallbackService when remote AI service returns 500 error', async () => {
    const mockFallbackResponse: OrchestratorResponse = {
      conversationId: 'conv-fallback',
      replyText: 'Fallback response from local engine',
      channel: 'WEB',
      toolCallsExecuted: [],
      sourcesRetrieved: [],
      status: 'COMPLETED',
    };

    const mockFallbackService: IAiService = {
      processMessage: vi.fn().mockResolvedValue(mockFallbackResponse),
      getConversation: vi.fn().mockResolvedValue(null),
      listConversations: vi.fn().mockResolvedValue([]),
      ingestDocument: vi
        .fn()
        .mockResolvedValue({ document: mockDocument, version: mockVersion, chunkCount: 1 }),
      listDocuments: vi.fn().mockResolvedValue([mockDocument]),
      deleteDocument: vi.fn().mockResolvedValue(undefined),
      queryRag: vi.fn().mockResolvedValue({
        groundedContext: '',
        chunks: [],
        documentsUsed: [],
        queryEmbeddingGenerated: true,
      }),
    };

    const client = new HttpAiClient(baseUrl, {
      fetchFn: vi.fn().mockResolvedValue(new Response('Internal server error', { status: 500 })),
      fallbackService: mockFallbackService,
    });

    const result = await client.processMessage({
      actor: mockCustomerActor,
      tenantId: 'tenant-1',
      channel: 'WEB',
      externalUserId: 'usr-1',
      userText: 'Help me',
    });

    expect(result.replyText).toBe('Fallback response from local engine');
    expect(mockFallbackService.processMessage).toHaveBeenCalled();
  });
});
