import type { AuthorizedActor } from '../../identity/index.js';
import type {
  ChannelType,
  ConversationRecord,
  DocumentCategory,
  KnowledgeDocumentRecord,
  KnowledgeVersionRecord,
  MessageRecord,
} from './ai-types.js';
import type { SendMessageInput, OrchestratorResponse } from './ai-orchestrator.js';
import type { IngestDocumentInput, RetrievalResult } from './rag-service.js';
import type { IAiService } from './ai-models.js';
import type { Logger } from '../../../observability/logger.js';
import {
  ExternalServiceError,
  NotFoundError,
  ForbiddenError,
  UnauthorizedError,
  ValidationError,
} from '../../../errors/app-error.js';

export interface HttpAiClientOptions {
  timeoutMs?: number | undefined;
  fetchFn?: typeof fetch | undefined;
  fallbackService?: IAiService | undefined;
  logger?: Logger | undefined;
}

/**
 * HttpAiClient - Remote AI & RAG Microservice HTTP Client.
 *
 * Implements IAiService to dispatch multi-turn chat messages, knowledge ingestion,
 * and semantic retrieval over HTTP against a standalone AI microservice.
 */
export class HttpAiClient implements IAiService {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchFn: typeof fetch;
  private readonly fallbackService?: IAiService | undefined;
  private readonly logger?: Logger | undefined;

  constructor(serviceUrl: string, options: HttpAiClientOptions = {}) {
    this.baseUrl = serviceUrl.replace(/\/+$/, '');
    this.timeoutMs = options.timeoutMs ?? 15000;
    this.fetchFn = options.fetchFn ?? globalThis.fetch.bind(globalThis);
    this.fallbackService = options.fallbackService;
    this.logger = options.logger;
  }

  getFallbackService(): IAiService | undefined {
    return this.fallbackService;
  }

  async processMessage(input: SendMessageInput): Promise<OrchestratorResponse> {
    try {
      return await this.request<OrchestratorResponse>(
        'POST',
        '/ai/chat',
        input.actor,
        {
          message: input.userText,
          conversationId: input.conversationId,
          channel: input.channel,
        },
      );
    } catch (err) {
      if (this.fallbackService && this.isFallbackEligible(err)) {
        this.logger?.warn('Remote AI service failed; falling back to local orchestrator', {
          error: (err as Error).message,
        });
        return this.fallbackService.processMessage(input);
      }
      throw err;
    }
  }

  async getConversation(
    actor: AuthorizedActor,
    conversationId: string,
  ): Promise<{ conversation: ConversationRecord; messages: MessageRecord[] } | null> {
    try {
      return await this.request<{ conversation: ConversationRecord; messages: MessageRecord[] }>(
        'GET',
        `/ai/conversations/${encodeURIComponent(conversationId)}`,
        actor,
      );
    } catch (err) {
      if (err instanceof NotFoundError) {
        return null;
      }
      if (this.fallbackService && this.isFallbackEligible(err)) {
        this.logger?.warn('Remote AI service failed; falling back to local service', {
          error: (err as Error).message,
        });
        return this.fallbackService.getConversation(actor, conversationId);
      }
      throw err;
    }
  }

  async listConversations(
    actor: AuthorizedActor,
    channel?: ChannelType,
    limit?: number,
  ): Promise<ConversationRecord[]> {
    const params = new URLSearchParams();
    if (channel) params.set('channel', channel);
    if (limit !== undefined) params.set('limit', String(limit));
    const query = params.toString() ? `?${params.toString()}` : '';

    try {
      const res = await this.request<{ conversations: ConversationRecord[] }>(
        'GET',
        `/ai/whatsapp/conversations${query}`,
        actor,
      );
      return res.conversations;
    } catch (err) {
      if (this.fallbackService && this.isFallbackEligible(err)) {
        this.logger?.warn('Remote AI service failed; falling back to local service', {
          error: (err as Error).message,
        });
        return this.fallbackService.listConversations(actor, channel, limit);
      }
      throw err;
    }
  }

  async ingestDocument(
    actor: AuthorizedActor,
    input: IngestDocumentInput,
  ): Promise<{
    document: KnowledgeDocumentRecord;
    version: KnowledgeVersionRecord;
    chunkCount: number;
  }> {
    try {
      return await this.request<{
        document: KnowledgeDocumentRecord;
        version: KnowledgeVersionRecord;
        chunkCount: number;
      }>('POST', '/ai/documents', actor, {
        documentId: input.documentId,
        title: input.title,
        category: input.category,
        content: input.content,
        sourceType: input.sourceType,
        sourceId: input.sourceId,
        metadata: input.metadata,
      });
    } catch (err) {
      if (this.fallbackService && this.isFallbackEligible(err)) {
        this.logger?.warn('Remote AI service failed; falling back to local service', {
          error: (err as Error).message,
        });
        return this.fallbackService.ingestDocument(actor, input);
      }
      throw err;
    }
  }

  async listDocuments(
    actor: AuthorizedActor,
    category?: DocumentCategory,
  ): Promise<KnowledgeDocumentRecord[]> {
    const query = category ? `?category=${encodeURIComponent(category)}` : '';
    try {
      const res = await this.request<{ documents: KnowledgeDocumentRecord[] }>(
        'GET',
        `/ai/documents${query}`,
        actor,
      );
      return res.documents;
    } catch (err) {
      if (this.fallbackService && this.isFallbackEligible(err)) {
        this.logger?.warn('Remote AI service failed; falling back to local service', {
          error: (err as Error).message,
        });
        return this.fallbackService.listDocuments(actor, category);
      }
      throw err;
    }
  }

  async deleteDocument(actor: AuthorizedActor, documentId: string): Promise<void> {
    try {
      await this.request<void>(
        'DELETE',
        `/ai/documents/${encodeURIComponent(documentId)}`,
        actor,
      );
    } catch (err) {
      if (this.fallbackService && this.isFallbackEligible(err)) {
        this.logger?.warn('Remote AI service failed; falling back to local service', {
          error: (err as Error).message,
        });
        return this.fallbackService.deleteDocument(actor, documentId);
      }
      throw err;
    }
  }

  async queryRag(
    actor: AuthorizedActor,
    query: string,
    category?: DocumentCategory,
    topK?: number,
  ): Promise<RetrievalResult> {
    try {
      return await this.request<RetrievalResult>(
        'POST',
        '/ai/rag/query',
        actor,
        {
          query,
          category,
          topK,
        },
      );
    } catch (err) {
      if (this.fallbackService && this.isFallbackEligible(err)) {
        this.logger?.warn('Remote AI service failed; falling back to local service', {
          error: (err as Error).message,
        });
        return this.fallbackService.queryRag(actor, query, category, topK);
      }
      throw err;
    }
  }

  private async request<T>(
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    path: string,
    actor?: AuthorizedActor,
    body?: unknown,
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    const headers: Record<string, string> = {};
    if (body !== undefined) {
      headers['content-type'] = 'application/json';
    }
    if (actor) {
      headers['x-user-id'] = actor.userId;
      headers['x-tenant-id'] = actor.tenantId;
      headers['x-user-role'] = actor.role;
    }

    const init: RequestInit = {
      method,
      headers,
      signal: controller.signal,
    };
    if (body !== undefined) {
      init.body = JSON.stringify(body);
    }

    try {
      const response = await this.fetchFn(url, init);

      if (!response.ok) {
        const errorText = await response.text();
        this.mapStatusToError(response.status, errorText, path);
      }

      if (response.status === 204) {
        return undefined as T;
      }

      const contentType = response.headers.get('content-type') ?? '';
      if (contentType.includes('application/json')) {
        return (await response.json()) as T;
      }
      return (await response.text()) as unknown as T;
    } catch (err) {
      if (
        err instanceof ValidationError ||
        err instanceof NotFoundError ||
        err instanceof ForbiddenError ||
        err instanceof UnauthorizedError ||
        err instanceof ExternalServiceError
      ) {
        throw err;
      }

      if (err instanceof Error && err.name === 'AbortError') {
        throw new ExternalServiceError(
          `AI service request timed out after ${this.timeoutMs}ms: ${method} ${path}`,
          'AI_SERVICE_TIMEOUT',
        );
      }

      throw new ExternalServiceError(
        `Failed to reach AI service at ${url}: ${(err as Error).message}`,
        'AI_SERVICE_UNAVAILABLE',
      );
    } finally {
      clearTimeout(timer);
    }
  }

  private mapStatusToError(status: number, message: string, path: string): never {
    let parsedMessage = message;
    try {
      const parsed = JSON.parse(message);
      if (parsed.message) parsedMessage = parsed.message;
      else if (parsed.error) parsedMessage = parsed.error;
    } catch {
      // Keep original text
    }

    switch (status) {
      case 400:
        throw new ValidationError(`AI service validation error on ${path}: ${parsedMessage}`);
      case 401:
        throw new UnauthorizedError(`AI service unauthorized on ${path}: ${parsedMessage}`);
      case 403:
        throw new ForbiddenError(`AI service forbidden on ${path}: ${parsedMessage}`);
      case 404:
        throw new NotFoundError(`AI service resource not found on ${path}: ${parsedMessage}`);
      default:
        throw new ExternalServiceError(
          `AI service responded with HTTP ${status} on ${path}: ${parsedMessage}`,
          'AI_SERVICE_HTTP_ERROR',
        );
    }
  }

  private isFallbackEligible(err: unknown): boolean {
    if (err instanceof ExternalServiceError) return true;
    if (err instanceof Error && err.name === 'AbortError') return true;
    return false;
  }
}
