import type { AuthorizedActor } from '../../identity/index.js';
import type {
  ChannelType,
  ConversationRecord,
  DocumentCategory,
  KnowledgeDocumentRecord,
  KnowledgeVersionRecord,
  MessageRecord,
  IAiStore,
} from './ai-types.js';
import type {
  AiOrchestrator,
  SendMessageInput,
  OrchestratorResponse,
} from './ai-orchestrator.js';
import type {
  RagService,
  IngestDocumentInput,
  RetrievalResult,
} from './rag-service.js';

/**
 * IAiService - Unified interface for AI Orchestration, RAG Knowledge, and Conversation History.
 * Decouples consumers from whether the AI subsystem runs in-process or as a standalone microservice.
 */
export interface IAiService {
  processMessage(input: SendMessageInput): Promise<OrchestratorResponse>;
  getConversation(
    actor: AuthorizedActor,
    conversationId: string,
  ): Promise<{ conversation: ConversationRecord; messages: MessageRecord[] } | null>;
  listConversations(
    actor: AuthorizedActor,
    channel?: ChannelType,
    limit?: number,
  ): Promise<ConversationRecord[]>;
  ingestDocument(
    actor: AuthorizedActor,
    input: IngestDocumentInput,
  ): Promise<{
    document: KnowledgeDocumentRecord;
    version: KnowledgeVersionRecord;
    chunkCount: number;
  }>;
  listDocuments(
    actor: AuthorizedActor,
    category?: DocumentCategory,
  ): Promise<KnowledgeDocumentRecord[]>;
  deleteDocument(actor: AuthorizedActor, documentId: string): Promise<void>;
  queryRag(
    actor: AuthorizedActor,
    query: string,
    category?: DocumentCategory,
    topK?: number,
  ): Promise<RetrievalResult>;
}

/**
 * LocalAiService - In-process implementation wrapping local AiOrchestrator, RagService, and IAiStore.
 */
export class LocalAiService implements IAiService {
  constructor(
    private readonly orchestrator: AiOrchestrator,
    private readonly ragService: RagService,
    private readonly store: IAiStore,
  ) {}

  async processMessage(input: SendMessageInput): Promise<OrchestratorResponse> {
    return this.orchestrator.processMessage(input);
  }

  async getConversation(
    actor: AuthorizedActor,
    conversationId: string,
  ): Promise<{ conversation: ConversationRecord; messages: MessageRecord[] } | null> {
    const conv = await this.store.getConversationById(actor.tenantId, conversationId);
    if (!conv) return null;
    const messages = await this.store.listMessages(conv.id, 50);
    return { conversation: conv, messages };
  }

  async listConversations(
    actor: AuthorizedActor,
    channel?: ChannelType,
    limit?: number,
  ): Promise<ConversationRecord[]> {
    return this.store.listConversations(actor.tenantId, channel, limit);
  }

  async ingestDocument(
    actor: AuthorizedActor,
    input: IngestDocumentInput,
  ): Promise<{
    document: KnowledgeDocumentRecord;
    version: KnowledgeVersionRecord;
    chunkCount: number;
  }> {
    return this.ragService.ingestDocument({
      ...input,
      tenantId: actor.tenantId,
    });
  }

  async listDocuments(
    actor: AuthorizedActor,
    category?: DocumentCategory,
  ): Promise<KnowledgeDocumentRecord[]> {
    return this.store.listDocuments(actor.tenantId, category);
  }

  async deleteDocument(actor: AuthorizedActor, documentId: string): Promise<void> {
    return this.ragService.deleteDocument(actor.tenantId, documentId);
  }

  async queryRag(
    actor: AuthorizedActor,
    query: string,
    category?: DocumentCategory,
    topK?: number,
  ): Promise<RetrievalResult> {
    return this.ragService.retrieveKnowledge(actor.tenantId, query, category, topK);
  }
}
