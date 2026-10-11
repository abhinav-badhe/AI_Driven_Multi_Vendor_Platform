/**
 * BOUNDED CONTEXT: AI Capability Layer
 * Ownership: Typed commerce tool orchestration, RAG knowledge retrieval, prompt security, WhatsApp channel adapter.
 *
 * Invariant: AI is an application capability using authorized tools, NOT a replacement
 * for domain ownership or transactional truth.
 *
 * Architecture Boundary:
 * - AI code MUST NOT import database connection pools or repositories directly.
 * - AI code MUST interact with commerce capabilities exclusively through authorized,
 *   typed tool interfaces exposed by domain module public interfaces.
 */

import type { Logger } from '../../observability/logger.js';
import {
  AiOrchestrator,
  type SendMessageInput,
  type OrchestratorResponse,
} from './internal/ai-orchestrator.js';
import {
  ToolRegistry,
  type ToolRegistryDependencies,
} from './internal/tool-registry.js';
import {
  RagService,
  type IngestDocumentInput,
  type RetrievalResult,
} from './internal/rag-service.js';
import {
  WhatsAppAdapter,
  MockWhatsAppProvider,
  type InboundWebhookInput,
} from './internal/whatsapp-adapter.js';
import { MetaWhatsAppCloudProvider } from './internal/meta-whatsapp-provider.js';
import { InMemoryAiStore } from './internal/in-memory-ai-store.js';
import { InMemoryVectorStore } from './internal/in-memory-vector-store.js';
import { MockLLMProvider } from './internal/mock-llm-provider.js';
import { MockEmbeddingProvider } from './internal/mock-embedding-provider.js';
import { type IAiService, LocalAiService } from './internal/ai-models.js';
import { HttpAiClient, type HttpAiClientOptions } from './internal/http-ai-client.js';
import type {
  AiAuditRecord,
  AiTool,
  ChannelType,
  ChatMessage,
  ConversationRecord,
  ConversationStatus,
  DocumentCategory,
  DocumentStatus,
  IAiStore,
  IEmbeddingProvider,
  ILLMProvider,
  IVectorStore,
  IWhatsAppProvider,
  KnowledgeChunkRecord,
  KnowledgeDocumentRecord,
  KnowledgeVersionRecord,
  LLMOptions,
  LLMResponse,
  MessageRecord,
  MessageRole,
  ToolCall,
  ToolCallResult,
  ToolDefinition,
  ToolExecutionContext,
  VectorSearchFilter,
  VectorSearchResult,
  VersionStatus,
  WhatsAppInboundMessage,
  WhatsAppMappingRecord,
  WhatsAppWebhookRecord,
  WhatsAppSendResult,
} from './internal/ai-types.js';

export type {
  AiAuditRecord,
  AiTool,
  ChannelType,
  ChatMessage,
  ConversationRecord,
  ConversationStatus,
  DocumentCategory,
  DocumentStatus,
  IAiStore,
  IEmbeddingProvider,
  ILLMProvider,
  IVectorStore,
  IWhatsAppProvider,
  KnowledgeChunkRecord,
  KnowledgeDocumentRecord,
  KnowledgeVersionRecord,
  LLMOptions,
  LLMResponse,
  MessageRecord,
  MessageRole,
  ToolCall,
  ToolCallResult,
  ToolDefinition,
  ToolExecutionContext,
  VectorSearchFilter,
  VectorSearchResult,
  VersionStatus,
  WhatsAppInboundMessage,
  WhatsAppMappingRecord,
  WhatsAppWebhookRecord,
  WhatsAppSendResult,
  SendMessageInput,
  OrchestratorResponse,
  ToolRegistryDependencies,
  IngestDocumentInput,
  RetrievalResult,
  InboundWebhookInput,
  IAiService,
  HttpAiClientOptions,
};

export {
  AiOrchestrator,
  ToolRegistry,
  RagService,
  WhatsAppAdapter,
  MockWhatsAppProvider,
  MetaWhatsAppCloudProvider,
  InMemoryAiStore,
  InMemoryVectorStore,
  MockLLMProvider,
  MockEmbeddingProvider,
  LocalAiService,
  HttpAiClient,
};

export interface AiModule {
  readonly contextName: 'ai';
  createOrchestrator(
    store: IAiStore,
    toolRegistry: ToolRegistry,
    ragService: RagService,
    llmProvider: ILLMProvider,
    logger: Logger,
  ): AiOrchestrator;
  createRagService(
    store: IAiStore,
    vectorStore: IVectorStore,
    embeddingProvider: IEmbeddingProvider,
    logger: Logger,
  ): RagService;
  createWhatsAppAdapter(
    store: IAiStore,
    orchestrator: AiOrchestrator,
    provider: IWhatsAppProvider,
    logger: Logger,
  ): WhatsAppAdapter;
  createToolRegistry(deps: ToolRegistryDependencies): ToolRegistry;
  createHttpClient(
    serviceUrl: string,
    options?: HttpAiClientOptions,
  ): HttpAiClient;
  createLocalService(
    orchestrator: AiOrchestrator,
    ragService: RagService,
    store: IAiStore,
  ): LocalAiService;
}

export const aiModule: AiModule = {
  contextName: 'ai',
  createOrchestrator(store, toolRegistry, ragService, llmProvider, logger) {
    return new AiOrchestrator(store, toolRegistry, ragService, llmProvider, logger);
  },
  createRagService(store, vectorStore, embeddingProvider, logger) {
    return new RagService(store, vectorStore, embeddingProvider, logger);
  },
  createWhatsAppAdapter(store, orchestrator, provider, logger) {
    return new WhatsAppAdapter(store, orchestrator, provider, logger);
  },
  createToolRegistry(deps) {
    return new ToolRegistry(deps);
  },
  createHttpClient(serviceUrl, options) {
    return new HttpAiClient(serviceUrl, options);
  },
  createLocalService(orchestrator, ragService, store) {
    return new LocalAiService(orchestrator, ragService, store);
  },
};
