import type {
  IVectorStore,
  KnowledgeChunkRecord,
  VectorSearchFilter,
  VectorSearchResult,
} from './ai-types.js';

export class InMemoryVectorStore implements IVectorStore {
  private readonly chunks = new Map<string, KnowledgeChunkRecord>();

  async upsertChunks(chunks: KnowledgeChunkRecord[]): Promise<void> {
    for (const chunk of chunks) {
      this.chunks.set(chunk.id, { ...chunk });
    }
  }

  async search(
    tenantId: string,
    queryEmbedding: number[],
    filter?: VectorSearchFilter,
    topK = 5,
  ): Promise<VectorSearchResult[]> {
    const results: VectorSearchResult[] = [];

    for (const chunk of this.chunks.values()) {
      // Rule 1: Strict tenant isolation (chunks from another tenant are NEVER accessible)
      if (chunk.tenantId !== tenantId) continue;

      // Rule 2: Active chunks only (superseded or deleted chunks are excluded)
      if (!chunk.isActive) continue;

      // Rule 3: Category filter if specified
      if (filter?.category && chunk.metadata['category'] !== filter.category) continue;

      // Rule 4: Document filter if specified
      if (filter?.documentId && chunk.documentId !== filter.documentId) continue;

      if (!chunk.embedding || chunk.embedding.length === 0) continue;

      const score = this.cosineSimilarity(queryEmbedding, chunk.embedding);
      results.push({ chunk: { ...chunk }, score });
    }

    return results
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }

  async deactivateDocumentChunks(documentId: string): Promise<void> {
    for (const [id, chunk] of this.chunks.entries()) {
      if (chunk.documentId === documentId) {
        this.chunks.set(id, { ...chunk, isActive: false });
      }
    }
  }

  private cosineSimilarity(vecA: number[], vecB: number[]): number {
    if (vecA.length !== vecB.length || vecA.length === 0) return 0;

    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < vecA.length; i++) {
      const a = vecA[i] ?? 0;
      const b = vecB[i] ?? 0;
      dotProduct += a * b;
      normA += a * a;
      normB += b * b;
    }

    if (normA === 0 || normB === 0) return 0;
    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
  }
}
