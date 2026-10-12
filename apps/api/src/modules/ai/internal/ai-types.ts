import { z } from 'zod';
import type { AuthorizedActor, Permission } from '../../identity/index.js';

export type ChannelType = 'WEB' | 'WHATSAPP' | 'API';
export type ConversationStatus = 'ACTIVE' | 'CLOSED' | 'ARCHIVED';
export type MessageRole = 'SYSTEM' | 'USER' | 'ASSISTANT' | 'TOOL';

export type DocumentCategory =
  | 'PRODUCT_INFO'
  | 'SPECIFICATION'
  | 'POLICY'
  | 'FAQ'
  | 'SHIPPING'
  | 'RETURNS'
  | 'WARRANTY'
  | 'MERCHANT_DOC'
  | 'GENERAL';

export type DocumentStatus = 'PENDING' | 'PROCESSING' | 'INDEXED' | 'ARCHIVED' | 'FAILED';
export type VersionStatus = 'PENDING' | 'PROCESSING' | 'INDEXED' | 'SUPERSEDED' | 'FAILED';

export interface ToolExecutionContext {
  readonly actor: AuthorizedActor;
  readonly tenantId: string;
  readonly correlationId: string;
  readonly conversationId?: string | undefined;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ToolCallResult {
  toolCallId: string;
  name: string;
  output: unknown;
  error?: string;
}

export interface AiTool<TInput = unknown, TOutput = unknown> {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: z.ZodType<TInput>;
  readonly outputSchema: z.ZodType<TOutput>;
  readonly requiredPermission: Permission;
  readonly owningContext: string;
  readonly auditClassification: 'READ_PUBLIC' | 'READ_SENSITIVE' | 'MUTATE';
  execute(context: ToolExecutionContext, input: TInput): Promise<TOutput>;
}

export interface ConversationRecord {
  id: string;
  tenantId: string;
  channel: ChannelType;
  externalUserId: string;
  customerId?: string | null | undefined;
  title?: string | null | undefined;
  status: ConversationStatus;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface MessageRecord {
  id: string;
  conversationId: string;
  tenantId: string;
  role: MessageRole;
  content: string;
  toolCalls?: ToolCall[] | undefined;
  toolCallId?: string | null | undefined;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface KnowledgeDocumentRecord {
  id: string;
  tenantId: string;
  title: string;
  category: DocumentCategory;
  sourceType: string;
  sourceId?: string | null | undefined;
  currentVersion: number;
  status: DocumentStatus;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface KnowledgeVersionRecord {
  id: string;
  documentId: string;
  tenantId: string;
  version: number;
  rawContent: string;
  cleanedContent: string;
  chunkCount: number;
  status: VersionStatus;
  errorMessage?: string | null | undefined;
  createdAt: string;
}

export interface KnowledgeChunkRecord {
  id: string;
  documentId: string;
  versionId: string;
  tenantId: string;
  chunkIndex: number;
  content: string;
  embedding?: number[] | undefined;
  metadata: Record<string, unknown>;
  isActive: boolean;
  createdAt: string;
}

export interface VectorSearchFilter {
  category?: DocumentCategory | undefined;
  documentId?: string | undefined;
  version?: number | undefined;
}

export interface VectorSearchResult {
  chunk: KnowledgeChunkRecord;
  score: number;
}

export interface WhatsAppMappingRecord {
  id: string;
  phoneNumber: string;
  tenantId: string;
  customerId: string;
  isVerified: boolean;
  verificationCode?: string | null | undefined;
  verifiedAt?: string | null | undefined;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface WhatsAppWebhookRecord {
  id: string;
  providerMessageId: string;
  tenantId: string;
  phoneNumber: string;
  status: 'RECEIVED' | 'PROCESSED' | 'FAILED' | 'DUPLICATE';
  payloadHash: string;
  processedAt: string;
}

export interface WhatsAppInboundMessage {
  messageId: string;
  fromNumber: string;
  toNumber: string;
  text: string;
  timestamp: string;
  tenantId: string;
}

export interface AiAuditRecord {
  id: string;
  tenantId: string;
  conversationId?: string | null | undefined;
  channel: ChannelType;
  actorRole: string;
  actorId: string;
  actionType:
    | 'MESSAGE_RECEIVED'
    | 'INTENT_CLASSIFIED'
    | 'TOOL_CALLED'
    | 'TOOL_AUTH_DENIED'
    | 'RAG_RETRIEVAL'
    | 'PROMPT_INJECTION_DETECTED'
    | 'RESPONSE_GENERATED'
    | 'ERROR';
  toolName?: string | null | undefined;
  authStatus?: 'AUTHORIZED' | 'DENIED' | null | undefined;
  documentIds?: string[] | undefined;
  details: Record<string, unknown>;
  createdAt: string;
}

export interface ChatMessage {
  role: MessageRole;
  content: string;
  toolCalls?: ToolCall[] | undefined;
  toolCallId?: string | undefined;
}

export interface LLMOptions {
  temperature?: number | undefined;
  maxTokens?: number | undefined;
  timeoutMs?: number | undefined;
}

export interface LLMResponse {
  content: string;
  toolCalls?: ToolCall[];
  tokenUsage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  modelId: string;
}

export interface ILLMProvider {
  generateChat(
    messages: ChatMessage[],
    tools?: ToolDefinition[],
    options?: LLMOptions,
  ): Promise<LLMResponse>;
}

export interface IEmbeddingProvider {
  readonly dimensions: number;
  readonly modelId: string;
  embed(text: string): Promise<number[]>;
  embedBatch(texts: string[]): Promise<number[][]>;
}

export interface IVectorStore {
  upsertChunks(chunks: KnowledgeChunkRecord[]): Promise<void>;
  search(
    tenantId: string,
    queryEmbedding: number[],
    filter?: VectorSearchFilter,
    topK?: number,
  ): Promise<VectorSearchResult[]>;
  deactivateDocumentChunks(documentId: string): Promise<void>;
}

export interface WhatsAppSendResult {
  success: boolean;
  messageId?: string | undefined;
  error?: string | undefined;
}

export interface IWhatsAppProvider {
  readonly providerName: string;
  verifyWebhookSignature(rawPayload: string, signature: string, secret: string): boolean;
  sendTextMessage(to: string, text: string): Promise<boolean | WhatsAppSendResult>;
}

export interface IAiStore {
  // Conversations
  createConversation(conv: ConversationRecord): Promise<void>;
  getConversationById(tenantId: string, id: string): Promise<ConversationRecord | null>;
  findConversationByUser(
    tenantId: string,
    channel: ChannelType,
    externalUserId: string,
  ): Promise<ConversationRecord | null>;
  listConversations(
    tenantId: string,
    channel?: ChannelType,
    limit?: number,
  ): Promise<ConversationRecord[]>;
  updateConversation(
    tenantId: string,
    id: string,
    updates: Partial<ConversationRecord>,
  ): Promise<void>;

  // Messages
  addMessage(msg: MessageRecord): Promise<void>;
  listMessages(conversationId: string, limit?: number): Promise<MessageRecord[]>;

  // Knowledge Documents
  saveDocument(doc: KnowledgeDocumentRecord): Promise<void>;
  getDocumentById(tenantId: string, id: string): Promise<KnowledgeDocumentRecord | null>;
  listDocuments(tenantId: string, category?: DocumentCategory): Promise<KnowledgeDocumentRecord[]>;
  updateDocumentStatus(
    tenantId: string,
    id: string,
    status: DocumentStatus,
    currentVersion?: number,
  ): Promise<void>;

  // Document Versions
  saveVersion(ver: KnowledgeVersionRecord): Promise<void>;
  getVersion(documentId: string, version: number): Promise<KnowledgeVersionRecord | null>;
  listVersions(documentId: string): Promise<KnowledgeVersionRecord[]>;

  // Chunks
  saveChunks(chunks: KnowledgeChunkRecord[]): Promise<void>;
  listChunksByDocument(documentId: string): Promise<KnowledgeChunkRecord[]>;
  deactivateChunks(documentId: string): Promise<void>;

  // WhatsApp Identity
  saveWhatsAppMapping(mapping: WhatsAppMappingRecord): Promise<void>;
  getWhatsAppMappingByPhone(phoneNumber: string): Promise<WhatsAppMappingRecord | null>;

  // Webhook Deduplication
  recordWebhook(webhook: WhatsAppWebhookRecord): Promise<boolean>; // returns false if duplicate
  getWebhook(tenantId: string, messageId: string): Promise<WhatsAppWebhookRecord | null>;
  listWebhooks(tenantId: string, limit?: number): Promise<WhatsAppWebhookRecord[]>;
  updateWebhookStatus(
    tenantId: string,
    messageId: string,
    status: WhatsAppWebhookRecord['status'],
  ): Promise<void>;

  // Audit Logs
  recordAudit(audit: AiAuditRecord): Promise<void>;
  listAuditLogs(tenantId: string, limit?: number): Promise<AiAuditRecord[]>;
}
