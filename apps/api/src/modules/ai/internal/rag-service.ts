import { randomUUID } from 'node:crypto';
import type { Logger } from '../../../observability/logger.js';
import { NotFoundError, ValidationError } from '../../../errors/app-error.js';
import type {
  DocumentCategory,
  IAiStore,
  IEmbeddingProvider,
  IVectorStore,
  KnowledgeChunkRecord,
  KnowledgeDocumentRecord,
  KnowledgeVersionRecord,
  VectorSearchResult,
} from './ai-types.js';

export interface IngestDocumentInput {
  tenantId: string;
  documentId?: string | undefined;
  title: string;
  category: DocumentCategory;
  sourceType?: string | undefined;
  sourceId?: string | undefined;
  content: string;
  metadata?: Record<string, unknown> | undefined;
}

export interface RetrievalResult {
  query: string;
  chunks: Array<{
    documentId: string;
    tenantId: string;
    version: number;
    title: string;
    category: string;
    content: string;
    score: number;
  }>;
  groundedContext: string;
}

export class RagService {
  constructor(
    private readonly store: IAiStore,
    private readonly vectorStore: IVectorStore,
    private readonly embeddingProvider: IEmbeddingProvider,
    private readonly logger: Logger,
  ) {}

  /**
   * Ingests, sanitizes, versions, chunks, embeds, and indexes a knowledge document.
   */
  async ingestDocument(input: IngestDocumentInput): Promise<{
    document: KnowledgeDocumentRecord;
    version: KnowledgeVersionRecord;
    chunkCount: number;
  }> {
    if (!input.title || input.title.trim().length === 0) {
      throw new ValidationError('Document title is required');
    }
    if (!input.content || input.content.trim().length === 0) {
      throw new ValidationError('Document content cannot be empty');
    }

    const tenantId = input.tenantId;
    const documentId = input.documentId ?? `doc-${randomUUID().slice(0, 12)}`;
    const nowIso = new Date().toISOString();

    // 1. Ingestion-time PII and Secret Sanitization
    const cleanedContent = this.sanitizeContent(input.content);

    // 2. Check for existing document versioning
    const existing = await this.store.getDocumentById(tenantId, documentId);
    const nextVersion = existing ? existing.currentVersion + 1 : 1;

    const docRecord: KnowledgeDocumentRecord = {
      id: documentId,
      tenantId,
      title: input.title,
      category: input.category,
      sourceType: input.sourceType ?? 'MANUAL',
      sourceId: input.sourceId ?? null,
      currentVersion: nextVersion,
      status: 'PROCESSING',
      metadata: input.metadata ?? {},
      createdAt: existing ? existing.createdAt : nowIso,
      updatedAt: nowIso,
    };

    await this.store.saveDocument(docRecord);

    // 3. Deactivate previous version chunks if updating existing document
    if (existing) {
      await this.vectorStore.deactivateDocumentChunks(documentId);
      await this.store.deactivateChunks(documentId);
    }

    // 4. Chunk Content (approx 500 chars with 50 char overlap)
    const rawChunks = this.splitIntoChunks(cleanedContent, 500, 50);
    const versionId = `ver-${randomUUID().slice(0, 12)}`;

    // 5. Embed Chunks
    const embeddings = await this.embeddingProvider.embedBatch(rawChunks);

    const chunkRecords: KnowledgeChunkRecord[] = rawChunks.map((chunkText, idx) => ({
      id: `chk-${randomUUID().slice(0, 12)}`,
      documentId,
      versionId,
      tenantId,
      chunkIndex: idx,
      content: chunkText,
      embedding: embeddings[idx],
      metadata: {
        title: input.title,
        category: input.category,
        version: nextVersion,
      },
      isActive: true,
      createdAt: nowIso,
    }));

    // 6. Persist Chunks and Index in Vector Store
    await this.store.saveChunks(chunkRecords);
    await this.vectorStore.upsertChunks(chunkRecords);

    // 7. Persist Version Record
    const versionRecord: KnowledgeVersionRecord = {
      id: versionId,
      documentId,
      tenantId,
      version: nextVersion,
      rawContent: input.content,
      cleanedContent,
      chunkCount: chunkRecords.length,
      status: 'INDEXED',
      createdAt: nowIso,
    };
    await this.store.saveVersion(versionRecord);

    // 8. Update Document Status to INDEXED
    await this.store.updateDocumentStatus(tenantId, documentId, 'INDEXED', nextVersion);
    docRecord.status = 'INDEXED';

    this.logger.info('Knowledge document successfully ingested and indexed', {
      tenantId,
      documentId,
      version: nextVersion,
      chunkCount: chunkRecords.length,
    });

    return {
      document: docRecord,
      version: versionRecord,
      chunkCount: chunkRecords.length,
    };
  }

  /**
   * Retrieves knowledge chunks relevant to a query strictly within the specified tenant.
   */
  async retrieveKnowledge(
    tenantId: string,
    query: string,
    category?: DocumentCategory,
    topK = 3,
  ): Promise<RetrievalResult> {
    const queryEmbedding = await this.embeddingProvider.embed(query);
    const filter = category ? { category } : undefined;

    // Strict tenant isolation enforced by vector store search
    const matches: VectorSearchResult[] = await this.vectorStore.search(
      tenantId,
      queryEmbedding,
      filter,
      topK,
    );

    const chunks = matches.map((m) => {
      const title = (m.chunk.metadata['title'] as string) ?? 'Document';
      const version = (m.chunk.metadata['version'] as number) ?? 1;
      const cat = (m.chunk.metadata['category'] as string) ?? 'GENERAL';
      return {
        documentId: m.chunk.documentId,
        tenantId: m.chunk.tenantId,
        version,
        title,
        category: cat,
        content: m.chunk.content,
        score: m.score,
      };
    });

    // Build grounded context snippet
    const groundedLines = chunks.map(
      (c) => `[Source: ${c.title} (Doc ID: ${c.documentId}, v${c.version})]\n${c.content}`,
    );

    const groundedContext =
      groundedLines.length > 0
        ? `RELEVANT KNOWLEDGE CONTEXT:\n${groundedLines.join('\n\n')}`
        : '';

    return {
      query,
      chunks,
      groundedContext,
    };
  }

  /**
   * Deactivates/archives a document and immediately purges its chunks from active retrieval.
   */
  async deleteDocument(tenantId: string, documentId: string): Promise<void> {
    const doc = await this.store.getDocumentById(tenantId, documentId);
    if (!doc) {
      throw new NotFoundError(`Knowledge document '${documentId}' not found`);
    }

    await this.store.updateDocumentStatus(tenantId, documentId, 'ARCHIVED');
    await this.store.deactivateChunks(documentId);
    await this.vectorStore.deactivateDocumentChunks(documentId);

    this.logger.info('Knowledge document archived and vectors deactivated', {
      tenantId,
      documentId,
    });
  }

  /**
   * Strips credit cards, bearer tokens, API keys, SSNs, and private credentials.
   */
  private sanitizeContent(raw: string): string {
    let sanitized = raw;
    // Strip 16-digit card numbers
    sanitized = sanitized.replace(/\b(?:\d{4}[-\s]?){3}\d{4}\b/g, '[REDACTED_CARD]');
    // Strip bearer tokens and API keys
    sanitized = sanitized.replace(/(?:Bearer\s+[A-Za-z0-9\-._~+/]+=*|api_key=[A-Za-z0-9]+)/gi, '[REDACTED_SECRET]');
    // Strip US SSN patterns
    sanitized = sanitized.replace(/\b\d{3}-\d{2}-\d{4}\b/g, '[REDACTED_SSN]');
    return sanitized;
  }

  /**
   * Simple sliding-window chunker with boundary overlap.
   */
  private splitIntoChunks(text: string, chunkSize: number, overlap: number): string[] {
    const chunks: string[] = [];
    let start = 0;

    while (start < text.length) {
      let end = start + chunkSize;
      if (end >= text.length) {
        chunks.push(text.slice(start).trim());
        break;
      }

      // Try breaking on a sentence or newline boundary
      const boundary = text.lastIndexOf('\n', end);
      if (boundary > start + chunkSize / 2) {
        end = boundary + 1;
      }

      chunks.push(text.slice(start, end).trim());
      start = end - overlap;
    }

    return chunks.filter((c) => c.length > 0);
  }
}
