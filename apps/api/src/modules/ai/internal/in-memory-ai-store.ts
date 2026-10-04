import type {
  AiAuditRecord,
  ChannelType,
  ConversationRecord,
  DocumentCategory,
  DocumentStatus,
  IAiStore,
  KnowledgeChunkRecord,
  KnowledgeDocumentRecord,
  KnowledgeVersionRecord,
  MessageRecord,
  WhatsAppMappingRecord,
  WhatsAppWebhookRecord,
} from './ai-types.js';

export class InMemoryAiStore implements IAiStore {
  private readonly conversations = new Map<string, ConversationRecord>();
  private readonly messages = new Map<string, MessageRecord>();
  private readonly documents = new Map<string, KnowledgeDocumentRecord>();
  private readonly versions = new Map<string, KnowledgeVersionRecord>();
  private readonly chunks = new Map<string, KnowledgeChunkRecord>();
  private readonly whatsappMappings = new Map<string, WhatsAppMappingRecord>();
  private readonly processedWebhooks = new Map<string, WhatsAppWebhookRecord>();
  private readonly auditLogs: AiAuditRecord[] = [];

  // --- Conversations ---

  async createConversation(conv: ConversationRecord): Promise<void> {
    this.conversations.set(conv.id, { ...conv });
  }

  async getConversationById(tenantId: string, id: string): Promise<ConversationRecord | null> {
    const conv = this.conversations.get(id);
    if (!conv || conv.tenantId !== tenantId) return null;
    return { ...conv };
  }

  async findConversationByUser(
    tenantId: string,
    channel: ChannelType,
    externalUserId: string,
  ): Promise<ConversationRecord | null> {
    for (const conv of this.conversations.values()) {
      if (
        conv.tenantId === tenantId &&
        conv.channel === channel &&
        conv.externalUserId === externalUserId &&
        conv.status === 'ACTIVE'
      ) {
        return { ...conv };
      }
    }
    return null;
  }

  async updateConversation(
    tenantId: string,
    id: string,
    updates: Partial<ConversationRecord>,
  ): Promise<void> {
    const conv = this.conversations.get(id);
    if (!conv || conv.tenantId !== tenantId) return;
    this.conversations.set(id, {
      ...conv,
      ...updates,
      updatedAt: new Date().toISOString(),
    });
  }

  // --- Messages ---

  async addMessage(msg: MessageRecord): Promise<void> {
    this.messages.set(msg.id, { ...msg });
  }

  async listMessages(conversationId: string, limit = 50): Promise<MessageRecord[]> {
    const res: MessageRecord[] = [];
    for (const msg of this.messages.values()) {
      if (msg.conversationId === conversationId) {
        res.push({ ...msg });
      }
    }
    return res
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .slice(-limit);
  }

  // --- Knowledge Documents ---

  async saveDocument(doc: KnowledgeDocumentRecord): Promise<void> {
    this.documents.set(doc.id, { ...doc });
  }

  async getDocumentById(tenantId: string, id: string): Promise<KnowledgeDocumentRecord | null> {
    const doc = this.documents.get(id);
    if (!doc || doc.tenantId !== tenantId) return null;
    return { ...doc };
  }

  async listDocuments(tenantId: string, category?: DocumentCategory): Promise<KnowledgeDocumentRecord[]> {
    const res: KnowledgeDocumentRecord[] = [];
    for (const doc of this.documents.values()) {
      if (doc.tenantId === tenantId) {
        if (!category || doc.category === category) {
          res.push({ ...doc });
        }
      }
    }
    return res.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async updateDocumentStatus(
    tenantId: string,
    id: string,
    status: DocumentStatus,
    currentVersion?: number,
  ): Promise<void> {
    const doc = this.documents.get(id);
    if (!doc || doc.tenantId !== tenantId) return;
    this.documents.set(id, {
      ...doc,
      status,
      currentVersion: currentVersion ?? doc.currentVersion,
      updatedAt: new Date().toISOString(),
    });
  }

  // --- Document Versions ---

  async saveVersion(ver: KnowledgeVersionRecord): Promise<void> {
    const key = `${ver.documentId}:${ver.version}`;
    this.versions.set(key, { ...ver });
  }

  async getVersion(documentId: string, version: number): Promise<KnowledgeVersionRecord | null> {
    const key = `${documentId}:${version}`;
    const ver = this.versions.get(key);
    return ver ? { ...ver } : null;
  }

  async listVersions(documentId: string): Promise<KnowledgeVersionRecord[]> {
    const res: KnowledgeVersionRecord[] = [];
    for (const ver of this.versions.values()) {
      if (ver.documentId === documentId) {
        res.push({ ...ver });
      }
    }
    return res.sort((a, b) => b.version - a.version);
  }

  // --- Chunks ---

  async saveChunks(chunks: KnowledgeChunkRecord[]): Promise<void> {
    for (const chunk of chunks) {
      this.chunks.set(chunk.id, { ...chunk });
    }
  }

  async listChunksByDocument(documentId: string): Promise<KnowledgeChunkRecord[]> {
    const res: KnowledgeChunkRecord[] = [];
    for (const chunk of this.chunks.values()) {
      if (chunk.documentId === documentId) {
        res.push({ ...chunk });
      }
    }
    return res.sort((a, b) => a.chunkIndex - b.chunkIndex);
  }

  async deactivateChunks(documentId: string): Promise<void> {
    for (const [id, chunk] of this.chunks.entries()) {
      if (chunk.documentId === documentId) {
        this.chunks.set(id, { ...chunk, isActive: false });
      }
    }
  }

  // --- WhatsApp Identity Mappings ---

  async saveWhatsAppMapping(mapping: WhatsAppMappingRecord): Promise<void> {
    this.whatsappMappings.set(mapping.phoneNumber, { ...mapping });
  }

  async getWhatsAppMappingByPhone(phoneNumber: string): Promise<WhatsAppMappingRecord | null> {
    const mapping = this.whatsappMappings.get(phoneNumber);
    return mapping ? { ...mapping } : null;
  }

  // --- WhatsApp Webhook Deduplication ---

  async recordWebhook(webhook: WhatsAppWebhookRecord): Promise<boolean> {
    const key = `${webhook.tenantId}:${webhook.providerMessageId}`;
    if (this.processedWebhooks.has(key)) {
      return false; // Duplicate delivery
    }
    this.processedWebhooks.set(key, { ...webhook });
    return true; // First time processed
  }

  async getWebhook(tenantId: string, messageId: string): Promise<WhatsAppWebhookRecord | null> {
    const key = `${tenantId}:${messageId}`;
    const wh = this.processedWebhooks.get(key);
    return wh ? { ...wh } : null;
  }

  // --- AI Audit Logs ---

  async recordAudit(audit: AiAuditRecord): Promise<void> {
    this.auditLogs.push({ ...audit });
  }

  async listAuditLogs(tenantId: string, limit = 100): Promise<AiAuditRecord[]> {
    return this.auditLogs
      .filter((a) => a.tenantId === tenantId)
      .slice(-limit);
  }
}
