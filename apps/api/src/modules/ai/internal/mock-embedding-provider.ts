import type { IEmbeddingProvider } from './ai-types.js';

export class MockEmbeddingProvider implements IEmbeddingProvider {
  readonly dimensions = 64;
  readonly modelId = 'mock-text-embedding-v1';

  private readonly semanticKeywords: Record<string, number> = {
    // Return & refund cluster
    return: 0,
    refund: 1,
    exchange: 2,
    cancel: 3,
    policy: 4,
    days: 5,
    condition: 6,
    // Shipping & delivery cluster
    shipping: 10,
    delivery: 11,
    carrier: 12,
    courier: 13,
    transit: 14,
    tracking: 15,
    dispatch: 16,
    // Warranty & specifications cluster
    warranty: 20,
    guarantee: 21,
    specification: 22,
    spec: 23,
    dimensions: 24,
    weight: 25,
    battery: 26,
    material: 27,
    // Product & catalog cluster
    product: 30,
    item: 31,
    price: 32,
    stock: 33,
    inventory: 34,
    listing: 35,
    seller: 36,
    merchant: 37,
    // Order & payment cluster
    order: 40,
    payment: 41,
    status: 42,
    paid: 43,
    customer: 44,
  };

  async embed(text: string): Promise<number[]> {
    const vector = new Array<number>(this.dimensions).fill(0.01);
    const tokens = text.toLowerCase().split(/[^a-z0-9]+/);

    for (const token of tokens) {
      if (!token) continue;
      const index = this.semanticKeywords[token];
      if (index !== undefined && index < this.dimensions) {
        vector[index] = (vector[index] ?? 0) + 1.0;
      } else {
        // Pseudo-hash distribution for non-keyword tokens
        let hash = 0;
        for (let i = 0; i < token.length; i++) {
          hash = (hash << 5) - hash + token.charCodeAt(i);
          hash |= 0;
        }
        const bucket = (Math.abs(hash) % (this.dimensions - 10)) + 10;
        vector[bucket] = (vector[bucket] ?? 0) + 0.2;
      }
    }

    // Normalize to unit length
    const norm = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));
    if (norm === 0) return vector;
    return vector.map((v) => v / norm);
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    return Promise.all(texts.map((t) => this.embed(t)));
  }
}
