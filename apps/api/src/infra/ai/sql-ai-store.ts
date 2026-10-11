import type { DatabaseConnection } from '../database/connection.js';
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
  VersionStatus,
  WhatsAppMappingRecord,
  WhatsAppWebhookRecord,
} from '../../modules/ai/index.js';

interface RawConvRow {
  id: string;
  tenant_id: string;
  channel: string;
  external_user_id: string;
  customer_id: string | null;
  title: string | null;
  status: string;
  metadata: Record<string, unknown>;
  created_at: Date | string;
  updated_at: Date | string;
}

interface RawMsgRow {
  id: string;
  conversation_id: string;
  tenant_id: string;
  role: string;
  content: string;
  tool_calls: unknown;
  tool_call_id: string | null;
  metadata: Record<string, unknown>;
  created_at: Date | string;
}

interface RawDocRow {
  id: string;
  tenant_id: string;
  title: string;
  category: string;
  source_type: string;
  source_id: string | null;
  current_version: number;
  status: string;
  metadata: Record<string, unknown>;
  created_at: Date | string;
  updated_at: Date | string;
}

interface RawVersionRow {
  id: string;
  document_id: string;
  tenant_id: string;
  version: number;
  raw_content: string;
  cleaned_content: string;
  chunk_count: number;
  status: string;
  error_message: string | null;
  created_at: Date | string;
}

interface RawChunkRow {
  id: string;
  document_id: string;
  version_id: string;
  tenant_id: string;
  chunk_index: number;
  content: string;
  embedding: number[] | null;
  metadata: Record<string, unknown>;
  is_active: boolean;
  created_at: Date | string;
}

interface RawMappingRow {
  id: string;
  phone_number: string;
  tenant_id: string;
  customer_id: string;
  is_verified: boolean;
  verification_code: string | null;
  verified_at: Date | string | null;
  metadata: Record<string, unknown>;
  created_at: Date | string;
  updated_at: Date | string;
}

interface RawAuditRow {
  id: string;
  tenant_id: string;
  conversation_id: string | null;
  channel: string;
  actor_role: string;
  actor_id: string;
  action_type: string;
  tool_name: string | null;
  auth_status: string | null;
  document_ids: string[] | null;
  details: Record<string, unknown>;
  created_at: Date | string;
}

interface RawWebhookRow {
  id: string;
  provider_message_id: string;
  tenant_id: string;
  phone_number: string;
  status: WhatsAppWebhookRecord['status'];
  payload_hash: string;
  processed_at: Date | string;
}

export class SqlAiStore implements IAiStore {
  constructor(private readonly db: DatabaseConnection) {}

  // --- Conversations ---

  async createConversation(conv: ConversationRecord): Promise<void> {
    const sql = `
      INSERT INTO ai_conversations (
        id, tenant_id, channel, external_user_id, customer_id, title, status, metadata, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10)
    `;
    await this.db.query(sql, [
      conv.id,
      conv.tenantId,
      conv.channel,
      conv.externalUserId,
      conv.customerId ?? null,
      conv.title ?? null,
      conv.status,
      JSON.stringify(conv.metadata ?? {}),
      conv.createdAt,
      conv.updatedAt,
    ]);
  }

  async getConversationById(tenantId: string, id: string): Promise<ConversationRecord | null> {
    const sql = 'SELECT * FROM ai_conversations WHERE tenant_id = $1 AND id = $2';
    const res = await this.db.query<RawConvRow>(sql, [tenantId, id]);
    if (res.rows.length === 0) return null;
    return this.mapConvRow(res.rows[0]!);
  }

  async findConversationByUser(
    tenantId: string,
    channel: ChannelType,
    externalUserId: string,
  ): Promise<ConversationRecord | null> {
    const sql = `
      SELECT * FROM ai_conversations
      WHERE tenant_id = $1 AND channel = $2 AND external_user_id = $3 AND status = 'ACTIVE'
      ORDER BY updated_at DESC
      LIMIT 1
    `;
    const res = await this.db.query<RawConvRow>(sql, [tenantId, channel, externalUserId]);
    if (res.rows.length === 0) return null;
    return this.mapConvRow(res.rows[0]!);
  }

  async listConversations(
    tenantId: string,
    channel?: ChannelType,
    limit = 50,
  ): Promise<ConversationRecord[]> {
    let sql = "SELECT * FROM ai_conversations WHERE ($1 = 'tenant-platform' OR tenant_id = $1)";
    const params: unknown[] = [tenantId];
    if (channel) {
      sql += ' AND channel = $2';
      params.push(channel);
    }
    sql += ` ORDER BY updated_at DESC LIMIT $${params.length + 1}`;
    params.push(limit);
    const res = await this.db.query<RawConvRow>(sql, params);
    return res.rows.map((r) => this.mapConvRow(r));
  }

  async updateConversation(
    tenantId: string,
    id: string,
    updates: Partial<ConversationRecord>,
  ): Promise<void> {
    const fields: string[] = ['updated_at = NOW()'];
    const params: unknown[] = [tenantId, id];
    let idx = 3;

    if (updates.status !== undefined) {
      fields.push(`status = $${idx++}`);
      params.push(updates.status);
    }
    if (updates.customerId !== undefined) {
      fields.push(`customer_id = $${idx++}`);
      params.push(updates.customerId);
    }
    if (updates.title !== undefined) {
      fields.push(`title = $${idx++}`);
      params.push(updates.title);
    }
    if (updates.metadata !== undefined) {
      fields.push(`metadata = $${idx++}::jsonb`);
      params.push(JSON.stringify(updates.metadata));
    }

    const sql = `UPDATE ai_conversations SET ${fields.join(', ')} WHERE tenant_id = $1 AND id = $2`;
    await this.db.query(sql, params);
  }

  // --- Messages ---

  async addMessage(msg: MessageRecord): Promise<void> {
    const sql = `
      INSERT INTO ai_messages (
        id, conversation_id, tenant_id, role, content, tool_calls, tool_call_id, metadata, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8::jsonb, $9)
    `;
    await this.db.query(sql, [
      msg.id,
      msg.conversationId,
      msg.tenantId,
      msg.role,
      msg.content,
      JSON.stringify(msg.toolCalls ?? []),
      msg.toolCallId ?? null,
      JSON.stringify(msg.metadata ?? {}),
      msg.createdAt,
    ]);
  }

  async listMessages(conversationId: string, limit = 50): Promise<MessageRecord[]> {
    const sql = `
      SELECT * FROM ai_messages
      WHERE conversation_id = $1
      ORDER BY created_at ASC
      LIMIT $2
    `;
    const res = await this.db.query<RawMsgRow>(sql, [conversationId, limit]);
    return res.rows.map((row) => this.mapMsgRow(row));
  }

  // --- Knowledge Documents ---

  async saveDocument(doc: KnowledgeDocumentRecord): Promise<void> {
    const sql = `
      INSERT INTO ai_knowledge_documents (
        id, tenant_id, title, category, source_type, source_id, current_version, status, metadata, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11)
      ON CONFLICT (id) DO UPDATE SET
        title = EXCLUDED.title,
        category = EXCLUDED.category,
        current_version = EXCLUDED.current_version,
        status = EXCLUDED.status,
        metadata = EXCLUDED.metadata,
        updated_at = NOW()
    `;
    await this.db.query(sql, [
      doc.id,
      doc.tenantId,
      doc.title,
      doc.category,
      doc.sourceType,
      doc.sourceId ?? null,
      doc.currentVersion,
      doc.status,
      JSON.stringify(doc.metadata ?? {}),
      doc.createdAt,
      doc.updatedAt,
    ]);
  }

  async getDocumentById(tenantId: string, id: string): Promise<KnowledgeDocumentRecord | null> {
    const sql = 'SELECT * FROM ai_knowledge_documents WHERE tenant_id = $1 AND id = $2';
    const res = await this.db.query<RawDocRow>(sql, [tenantId, id]);
    if (res.rows.length === 0) return null;
    return this.mapDocRow(res.rows[0]!);
  }

  async listDocuments(tenantId: string, category?: DocumentCategory): Promise<KnowledgeDocumentRecord[]> {
    let sql = 'SELECT * FROM ai_knowledge_documents WHERE tenant_id = $1';
    const params: unknown[] = [tenantId];
    if (category) {
      sql += ' AND category = $2';
      params.push(category);
    }
    sql += ' ORDER BY updated_at DESC';

    const res = await this.db.query<RawDocRow>(sql, params);
    return res.rows.map((row) => this.mapDocRow(row));
  }

  async updateDocumentStatus(
    tenantId: string,
    id: string,
    status: DocumentStatus,
    currentVersion?: number,
  ): Promise<void> {
    const fields = ['status = $3', 'updated_at = NOW()'];
    const params: unknown[] = [tenantId, id, status];

    if (currentVersion !== undefined) {
      fields.push('current_version = $4');
      params.push(currentVersion);
    }

    const sql = `UPDATE ai_knowledge_documents SET ${fields.join(', ')} WHERE tenant_id = $1 AND id = $2`;
    await this.db.query(sql, params);
  }

  // --- Document Versions ---

  async saveVersion(ver: KnowledgeVersionRecord): Promise<void> {
    const sql = `
      INSERT INTO ai_knowledge_document_versions (
        id, document_id, tenant_id, version, raw_content, cleaned_content, chunk_count, status, error_message, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      ON CONFLICT (document_id, version) DO UPDATE SET
        cleaned_content = EXCLUDED.cleaned_content,
        chunk_count = EXCLUDED.chunk_count,
        status = EXCLUDED.status,
        error_message = EXCLUDED.error_message
    `;
    await this.db.query(sql, [
      ver.id,
      ver.documentId,
      ver.tenantId,
      ver.version,
      ver.rawContent,
      ver.cleanedContent,
      ver.chunkCount,
      ver.status,
      ver.errorMessage ?? null,
      ver.createdAt,
    ]);
  }

  async getVersion(documentId: string, version: number): Promise<KnowledgeVersionRecord | null> {
    const sql = 'SELECT * FROM ai_knowledge_document_versions WHERE document_id = $1 AND version = $2';
    const res = await this.db.query<RawVersionRow>(sql, [documentId, version]);
    if (res.rows.length === 0) return null;
    return this.mapVersionRow(res.rows[0]!);
  }

  async listVersions(documentId: string): Promise<KnowledgeVersionRecord[]> {
    const sql = 'SELECT * FROM ai_knowledge_document_versions WHERE document_id = $1 ORDER BY version DESC';
    const res = await this.db.query<RawVersionRow>(sql, [documentId]);
    return res.rows.map((row) => this.mapVersionRow(row));
  }

  // --- Chunks ---

  async saveChunks(chunks: KnowledgeChunkRecord[]): Promise<void> {
    if (chunks.length === 0) return;

    for (const chunk of chunks) {
      const sql = `
        INSERT INTO ai_knowledge_chunks (
          id, document_id, version_id, tenant_id, chunk_index, content, embedding, metadata, is_active, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, $10)
        ON CONFLICT (id) DO UPDATE SET
          content = EXCLUDED.content,
          embedding = EXCLUDED.embedding,
          metadata = EXCLUDED.metadata,
          is_active = EXCLUDED.is_active
      `;
      await this.db.query(sql, [
        chunk.id,
        chunk.documentId,
        chunk.versionId,
        chunk.tenantId,
        chunk.chunkIndex,
        chunk.content,
        JSON.stringify(chunk.embedding ?? []),
        JSON.stringify(chunk.metadata ?? {}),
        chunk.isActive,
        chunk.createdAt,
      ]);
    }
  }

  async listChunksByDocument(documentId: string): Promise<KnowledgeChunkRecord[]> {
    const sql = 'SELECT * FROM ai_knowledge_chunks WHERE document_id = $1 ORDER BY chunk_index ASC';
    const res = await this.db.query<RawChunkRow>(sql, [documentId]);
    return res.rows.map((row) => this.mapChunkRow(row));
  }

  async deactivateChunks(documentId: string): Promise<void> {
    const sql = 'UPDATE ai_knowledge_chunks SET is_active = FALSE WHERE document_id = $1';
    await this.db.query(sql, [documentId]);
  }

  // --- WhatsApp Identity Mappings ---

  async saveWhatsAppMapping(mapping: WhatsAppMappingRecord): Promise<void> {
    const sql = `
      INSERT INTO ai_whatsapp_mappings (
        id, phone_number, tenant_id, customer_id, is_verified, verification_code, verified_at, metadata, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10)
      ON CONFLICT (phone_number) DO UPDATE SET
        tenant_id = EXCLUDED.tenant_id,
        customer_id = EXCLUDED.customer_id,
        is_verified = EXCLUDED.is_verified,
        verification_code = EXCLUDED.verification_code,
        verified_at = EXCLUDED.verified_at,
        metadata = EXCLUDED.metadata,
        updated_at = NOW()
    `;
    await this.db.query(sql, [
      mapping.id,
      mapping.phoneNumber,
      mapping.tenantId,
      mapping.customerId,
      mapping.isVerified,
      mapping.verificationCode ?? null,
      mapping.verifiedAt ?? null,
      JSON.stringify(mapping.metadata ?? {}),
      mapping.createdAt,
      mapping.updatedAt,
    ]);
  }

  async getWhatsAppMappingByPhone(phoneNumber: string): Promise<WhatsAppMappingRecord | null> {
    const sql = 'SELECT * FROM ai_whatsapp_mappings WHERE phone_number = $1';
    const res = await this.db.query<RawMappingRow>(sql, [phoneNumber]);
    if (res.rows.length === 0) return null;
    return this.mapMappingRow(res.rows[0]!);
  }

  // --- WhatsApp Webhook Deduplication ---

  async recordWebhook(webhook: WhatsAppWebhookRecord): Promise<boolean> {
    try {
      const sql = `
        INSERT INTO ai_whatsapp_webhooks (
          id, provider_message_id, tenant_id, phone_number, status, payload_hash, processed_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7)
      `;
      await this.db.query(sql, [
        webhook.id,
        webhook.providerMessageId,
        webhook.tenantId,
        webhook.phoneNumber,
        webhook.status,
        webhook.payloadHash,
        webhook.processedAt,
      ]);
      return true; // First time recorded
    } catch (err: unknown) {
      const msg = String(err);
      if (msg.includes('unique') || msg.includes('duplicate') || msg.includes('uq_')) {
        return false; // Duplicate
      }
      throw err;
    }
  }

  async getWebhook(tenantId: string, messageId: string): Promise<WhatsAppWebhookRecord | null> {
    const sql = `
      SELECT * FROM ai_whatsapp_webhooks
      WHERE tenant_id = $1 AND provider_message_id = $2
    `;
    const res = await this.db.query<RawWebhookRow>(sql, [tenantId, messageId]);
    const r = res.rows[0];
    if (!r) return null;
    return {
      id: r.id,
      providerMessageId: r.provider_message_id,
      tenantId: r.tenant_id,
      phoneNumber: r.phone_number,
      status: r.status,
      payloadHash: r.payload_hash,
      processedAt: typeof r.processed_at === 'string' ? r.processed_at : r.processed_at.toISOString(),
    };
  }

  async listWebhooks(tenantId: string, limit = 50): Promise<WhatsAppWebhookRecord[]> {
    const sql = `
      SELECT * FROM ai_whatsapp_webhooks
      WHERE ($1 = 'tenant-platform' OR tenant_id = $1)
      ORDER BY processed_at DESC
      LIMIT $2
    `;
    const res = await this.db.query<RawWebhookRow>(sql, [tenantId, limit]);
    return res.rows.map((r) => ({
      id: r.id,
      providerMessageId: r.provider_message_id,
      tenantId: r.tenant_id,
      phoneNumber: r.phone_number,
      status: r.status,
      payloadHash: r.payload_hash,
      processedAt: typeof r.processed_at === 'string' ? r.processed_at : r.processed_at.toISOString(),
    }));
  }

  async updateWebhookStatus(
    tenantId: string,
    messageId: string,
    status: WhatsAppWebhookRecord['status'],
  ): Promise<void> {
    const sql = `
      UPDATE ai_whatsapp_webhooks
      SET status = $1, processed_at = NOW()
      WHERE tenant_id = $2 AND provider_message_id = $3
    `;
    await this.db.query(sql, [status, tenantId, messageId]);
  }

  // --- AI Audit Logs ---

  async recordAudit(audit: AiAuditRecord): Promise<void> {
    const sql = `
      INSERT INTO ai_audit_logs (
        id, tenant_id, conversation_id, channel, actor_role, actor_id, action_type,
        tool_name, auth_status, document_ids, details, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb, $12)
    `;
    await this.db.query(sql, [
      audit.id,
      audit.tenantId,
      audit.conversationId ?? null,
      audit.channel,
      audit.actorRole,
      audit.actorId,
      audit.actionType,
      audit.toolName ?? null,
      audit.authStatus ?? null,
      JSON.stringify(audit.documentIds ?? []),
      JSON.stringify(audit.details ?? {}),
      audit.createdAt,
    ]);
  }

  async listAuditLogs(tenantId: string, limit = 100): Promise<AiAuditRecord[]> {
    const sql = `
      SELECT * FROM ai_audit_logs
      WHERE ($1 = 'tenant-platform' OR tenant_id = $1)
      ORDER BY created_at DESC
      LIMIT $2
    `;
    const res = await this.db.query<RawAuditRow>(sql, [tenantId, limit]);
    return res.rows.map((row) => this.mapAuditRow(row));
  }

  // --- Row Mappers ---

  private mapConvRow(r: RawConvRow): ConversationRecord {
    return {
      id: r.id,
      tenantId: r.tenant_id,
      channel: r.channel as ChannelType,
      externalUserId: r.external_user_id,
      customerId: r.customer_id,
      title: r.title,
      status: r.status as ConversationRecord['status'],
      metadata: r.metadata ?? {},
      createdAt: typeof r.created_at === 'string' ? r.created_at : r.created_at.toISOString(),
      updatedAt: typeof r.updated_at === 'string' ? r.updated_at : r.updated_at.toISOString(),
    };
  }

  private mapMsgRow(r: RawMsgRow): MessageRecord {
    return {
      id: r.id,
      conversationId: r.conversation_id,
      tenantId: r.tenant_id,
      role: r.role as MessageRecord['role'],
      content: r.content,
      toolCalls: Array.isArray(r.tool_calls) ? r.tool_calls : [],
      toolCallId: r.tool_call_id,
      metadata: r.metadata ?? {},
      createdAt: typeof r.created_at === 'string' ? r.created_at : r.created_at.toISOString(),
    };
  }

  private mapDocRow(r: RawDocRow): KnowledgeDocumentRecord {
    return {
      id: r.id,
      tenantId: r.tenant_id,
      title: r.title,
      category: r.category as DocumentCategory,
      sourceType: r.source_type,
      sourceId: r.source_id,
      currentVersion: r.current_version,
      status: r.status as DocumentStatus,
      metadata: r.metadata ?? {},
      createdAt: typeof r.created_at === 'string' ? r.created_at : r.created_at.toISOString(),
      updatedAt: typeof r.updated_at === 'string' ? r.updated_at : r.updated_at.toISOString(),
    };
  }

  private mapVersionRow(r: RawVersionRow): KnowledgeVersionRecord {
    return {
      id: r.id,
      documentId: r.document_id,
      tenantId: r.tenant_id,
      version: r.version,
      rawContent: r.raw_content,
      cleanedContent: r.cleaned_content,
      chunkCount: r.chunk_count,
      status: r.status as VersionStatus,
      errorMessage: r.error_message,
      createdAt: typeof r.created_at === 'string' ? r.created_at : r.created_at.toISOString(),
    };
  }

  private mapChunkRow(r: RawChunkRow): KnowledgeChunkRecord {
    return {
      id: r.id,
      documentId: r.document_id,
      versionId: r.version_id,
      tenantId: r.tenant_id,
      chunkIndex: r.chunk_index,
      content: r.content,
      embedding: Array.isArray(r.embedding) ? r.embedding : undefined,
      metadata: r.metadata ?? {},
      isActive: r.is_active,
      createdAt: typeof r.created_at === 'string' ? r.created_at : r.created_at.toISOString(),
    };
  }

  private mapMappingRow(r: RawMappingRow): WhatsAppMappingRecord {
    return {
      id: r.id,
      phoneNumber: r.phone_number,
      tenantId: r.tenant_id,
      customerId: r.customer_id,
      isVerified: r.is_verified,
      verificationCode: r.verification_code,
      verifiedAt: r.verified_at ? (typeof r.verified_at === 'string' ? r.verified_at : r.verified_at.toISOString()) : null,
      metadata: r.metadata ?? {},
      createdAt: typeof r.created_at === 'string' ? r.created_at : r.created_at.toISOString(),
      updatedAt: typeof r.updated_at === 'string' ? r.updated_at : r.updated_at.toISOString(),
    };
  }

  private mapAuditRow(r: RawAuditRow): AiAuditRecord {
    return {
      id: r.id,
      tenantId: r.tenant_id,
      conversationId: r.conversation_id,
      channel: r.channel as ChannelType,
      actorRole: r.actor_role,
      actorId: r.actor_id,
      actionType: r.action_type as AiAuditRecord['actionType'],
      toolName: r.tool_name,
      authStatus: r.auth_status as 'AUTHORIZED' | 'DENIED' | null,
      documentIds: Array.isArray(r.document_ids) ? r.document_ids : [],
      details: r.details ?? {},
      createdAt: typeof r.created_at === 'string' ? r.created_at : r.created_at.toISOString(),
    };
  }
}
