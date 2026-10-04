import type {
  SearchProductDocument,
  SearchQueryParams,
  SearchFacets,
  SearchSellerOffer,
} from './search-models.js';

export interface SearchStoreQueryResult {
  items: SearchProductDocument[];
  scores: Map<string, number>;
  total: number;
  facets: SearchFacets;
}

export interface ISearchStore {
  indexDocument(doc: SearchProductDocument): Promise<void>;
  bulkIndex(docs: SearchProductDocument[]): Promise<void>;
  replaceProjection(docs: SearchProductDocument[]): Promise<void>;
  getDocument(id: string): Promise<SearchProductDocument | null>;
  deleteDocument(id: string): Promise<boolean>;
  search(params: SearchQueryParams): Promise<SearchStoreQueryResult>;
  clear(): Promise<void>;
  count(): Promise<number>;
  healthCheck(): Promise<{ status: string; count: number; engine: string }>;
  findProductIdByListingId?(listingId: string): Promise<string | null>;
}

export function calculateRelevance(
  doc: SearchProductDocument,
  offers: SearchSellerOffer[],
  tokens: string[],
  rawQuery: string,
): number {
  const rawLower = rawQuery.toLowerCase().trim();
  const titleLower = doc.title.toLowerCase();
  const brandLower = (doc.brand ?? '').toLowerCase();
  const catLower = (doc.categoryName ?? '').toLowerCase();
  const descLower = (doc.description ?? '').toLowerCase();
  const skuCodes = offers.map((o) => o.skuCode.toLowerCase()).join(' ');

  let score = 0;

  // Exact title match boost
  if (titleLower === rawLower) {
    score += 100;
  } else if (titleLower.startsWith(rawLower)) {
    score += 60;
  } else if (titleLower.includes(rawLower)) {
    score += 40;
  }

  let matchedTokensCount = 0;
  for (const token of tokens) {
    let tokenFound = false;

    if (titleLower.includes(token)) {
      score += 25;
      tokenFound = true;
    }
    if (brandLower.includes(token)) {
      score += 15;
      tokenFound = true;
    }
    if (catLower.includes(token)) {
      score += 12;
      tokenFound = true;
    }
    if (skuCodes.includes(token)) {
      score += 15;
      tokenFound = true;
    }
    if (descLower.includes(token)) {
      score += 5;
      tokenFound = true;
    }

    if (tokenFound) {
      matchedTokensCount += 1;
    }
  }

  if (matchedTokensCount === 0) {
    return 0;
  }

  // Boost if all tokens matched
  if (matchedTokensCount === tokens.length) {
    score += 50;
  }

  return score;
}

export function getEffectiveMinPrice(doc: SearchProductDocument, includeInactive: boolean): number {
  const offers = includeInactive ? doc.offers : doc.offers.filter((o) => o.status === 'ACTIVE');
  if (offers.length === 0) return doc.minPrice || 0;
  return Math.min(...offers.map((o) => o.priceAmount));
}

export function getEffectiveMaxPrice(doc: SearchProductDocument, includeInactive: boolean): number {
  const offers = includeInactive ? doc.offers : doc.offers.filter((o) => o.status === 'ACTIVE');
  if (offers.length === 0) return doc.maxPrice || 0;
  return Math.max(...offers.map((o) => o.priceAmount));
}

export function aggregateFacets(docs: SearchProductDocument[], includeInactive: boolean): SearchFacets {
  const categoryMap = new Map<string, { id: string; name: string; count: number }>();
  const brandMap = new Map<string, { name: string; count: number }>();
  const merchantMap = new Map<string, { id: string; name: string; count: number }>();

  let minPrice = Number.MAX_SAFE_INTEGER;
  let maxPrice = 0;

  for (const doc of docs) {
    // Category facet
    if (doc.categoryId) {
      const existing = categoryMap.get(doc.categoryId) ?? {
        id: doc.categoryId,
        name: doc.categoryName ?? doc.categoryId,
        count: 0,
      };
      existing.count += 1;
      categoryMap.set(doc.categoryId, existing);
    }

    // Brand facet
    if (doc.brand) {
      const brandKey = doc.brand.trim();
      const existing = brandMap.get(brandKey) ?? { name: brandKey, count: 0 };
      existing.count += 1;
      brandMap.set(brandKey, existing);
    }

    // Offers: merchants and prices
    const offers = includeInactive
      ? doc.offers
      : doc.offers.filter((o) => o.status === 'ACTIVE');

    for (const offer of offers) {
      const mKey = offer.merchantId;
      const existingM = merchantMap.get(mKey) ?? {
        id: mKey,
        name: offer.merchantName ?? mKey,
        count: 0,
      };
      existingM.count += 1;
      merchantMap.set(mKey, existingM);

      if (offer.priceAmount < minPrice) minPrice = offer.priceAmount;
      if (offer.priceAmount > maxPrice) maxPrice = offer.priceAmount;
    }
  }

  return {
    categories: Array.from(categoryMap.values()).sort((a, b) => b.count - a.count),
    brands: Array.from(brandMap.values()).sort((a, b) => b.count - a.count),
    merchants: Array.from(merchantMap.values()).sort((a, b) => b.count - a.count),
    priceRange: {
      min: minPrice === Number.MAX_SAFE_INTEGER ? 0 : minPrice,
      max: maxPrice,
    },
  };
}

export function filterAndRankDocuments(
  documents: Iterable<SearchProductDocument>,
  params: SearchQueryParams,
): SearchStoreQueryResult {
  const includeInactive = params.includeInactive === true;
  const queryTokens = params.q
    ? params.q
        .toLowerCase()
        .trim()
        .split(/\s+/)
        .filter((t) => t.length > 0)
    : [];

  const candidates: Array<{ doc: SearchProductDocument; score: number }> = [];
  const scoreMap = new Map<string, number>();

  for (const doc of documents) {
    // 1. Product Lifecycle Filter
    if (!includeInactive && doc.status !== 'ACTIVE') {
      continue;
    }

    // Filter active offers for public search
    const visibleOffers = includeInactive
      ? doc.offers
      : doc.offers.filter((o) => o.status === 'ACTIVE');

    // For public discovery, products without any active seller offers are undiscoverable
    if (!includeInactive && visibleOffers.length === 0) {
      continue;
    }

    // 2. Category Filter
    if (params.categoryId && doc.categoryId !== params.categoryId) {
      continue;
    }

    // 3. Brand Filter
    if (params.brand && doc.brand?.toLowerCase() !== params.brand.toLowerCase()) {
      continue;
    }

    // 4. Merchant Filter (must have an offer from specified merchant)
    if (params.merchantId) {
      const hasMerchantOffer = visibleOffers.some((o) => o.merchantId === params.merchantId);
      if (!hasMerchantOffer) {
        continue;
      }
    }

    // 5. In-Stock Filter
    if (params.inStock === true) {
      const hasInStock = visibleOffers.some((o) => o.inStock && o.availableQuantity > 0);
      if (!hasInStock) {
        continue;
      }
    }

    // 6. Price Range Filters
    if (params.minPrice !== undefined) {
      const meetsMin = visibleOffers.some((o) => o.priceAmount >= params.minPrice!);
      if (!meetsMin) {
        continue;
      }
    }

    if (params.maxPrice !== undefined) {
      const meetsMax = visibleOffers.some((o) => o.priceAmount <= params.maxPrice!);
      if (!meetsMax) {
        continue;
      }
    }

    // 7. Custom Attribute Filter
    if (params.attributes && Object.keys(params.attributes).length > 0) {
      let attributesMatch = true;
      for (const [key, expectedVal] of Object.entries(params.attributes)) {
        const docVal = doc.attributes?.[key];
        const offerMatches = visibleOffers.some((o) => o.attributes?.[key] === expectedVal);
        if (docVal !== expectedVal && !offerMatches) {
          attributesMatch = false;
          break;
        }
      }
      if (!attributesMatch) {
        continue;
      }
    }

    // 8. Text Search & Scoring
    let score = 0;
    if (queryTokens.length > 0) {
      const textScore = calculateRelevance(doc, visibleOffers, queryTokens, params.q!);
      if (textScore <= 0) {
        continue;
      }
      score = textScore;
    }

    candidates.push({ doc: structuredClone(doc), score });
    scoreMap.set(doc.id, score);
  }

  // 9. Aggregate Facets across ALL matching candidates BEFORE pagination
  const facets = aggregateFacets(
    candidates.map((c) => c.doc),
    includeInactive,
  );

  // 10. Deterministic Sorting
  const sortBy = params.sortBy ?? 'relevance';
  candidates.sort((a, b) => {
    if (sortBy === 'relevance') {
      if (b.score !== a.score) {
        return b.score - a.score;
      }
    } else if (sortBy === 'price_asc') {
      const minA = getEffectiveMinPrice(a.doc, includeInactive);
      const minB = getEffectiveMinPrice(b.doc, includeInactive);
      if (minA !== minB) {
        return minA - minB;
      }
    } else if (sortBy === 'price_desc') {
      const maxA = getEffectiveMaxPrice(a.doc, includeInactive);
      const maxB = getEffectiveMaxPrice(b.doc, includeInactive);
      if (maxB !== maxA) {
        return maxB - maxA;
      }
    } else if (sortBy === 'newest') {
      const dateA = new Date(a.doc.createdAt).getTime();
      const dateB = new Date(b.doc.createdAt).getTime();
      if (dateB !== dateA) {
        return dateB - dateA;
      }
    }

    // Deterministic Fallback Tie-Breaker
    return a.doc.id.localeCompare(b.doc.id);
  });

  const total = candidates.length;
  const page = Math.max(1, params.page ?? 1);
  const pageSize = Math.min(100, Math.max(1, params.pageSize ?? 20));
  const offset = (page - 1) * pageSize;
  const pagedDocs = candidates.slice(offset, offset + pageSize).map((c) => c.doc);

  return {
    items: pagedDocs,
    scores: scoreMap,
    total,
    facets,
  };
}

/**
 * Provider-Neutral In-Memory Search Store Adapter.
 *
 * DEVELOPMENT & TESTING ADAPTER ONLY:
 * This in-memory implementation does NOT persist data across process restarts and is NOT
 * intended for production multi-replica environments.
 */
export class InMemorySearchStore implements ISearchStore {
  private documents = new Map<string, SearchProductDocument>();
  private isAvailable = true;

  // For testing failure scenarios
  setAvailability(available: boolean): void {
    this.isAvailable = available;
  }

  private checkAvailability(): void {
    if (!this.isAvailable) {
      throw new Error('Search storage adapter is temporarily unavailable');
    }
  }

  async indexDocument(doc: SearchProductDocument): Promise<void> {
    this.checkAvailability();
    this.documents.set(doc.id, structuredClone(doc));
  }

  async bulkIndex(docs: SearchProductDocument[]): Promise<void> {
    this.checkAvailability();
    for (const doc of docs) {
      this.documents.set(doc.id, structuredClone(doc));
    }
  }

  async replaceProjection(docs: SearchProductDocument[]): Promise<void> {
    this.checkAvailability();
    const nextMap = new Map<string, SearchProductDocument>();

    for (const doc of docs) {
      const existing = this.documents.get(doc.id);
      if (existing) {
        // Version-safe reconciliation against concurrent in-flight events
        const preserveExistingProduct = existing.sourceVersion > doc.sourceVersion;
        const baseDoc = preserveExistingProduct ? existing : doc;

        const mergedOffers = [...doc.offers];
        for (const existingOffer of existing.offers) {
          const incomingIdx = mergedOffers.findIndex((o) => o.listingId === existingOffer.listingId);
          if (incomingIdx >= 0) {
            if (existingOffer.sourceVersion > mergedOffers[incomingIdx]!.sourceVersion) {
              mergedOffers[incomingIdx] = structuredClone(existingOffer);
            }
          } else {
            mergedOffers.push(structuredClone(existingOffer));
          }
        }

        const activeOffers = mergedOffers.filter((o) => o.status === 'ACTIVE');
        const minPrice =
          activeOffers.length > 0 ? Math.min(...activeOffers.map((o) => o.priceAmount)) : baseDoc.minPrice;
        const maxPrice =
          activeOffers.length > 0 ? Math.max(...activeOffers.map((o) => o.priceAmount)) : baseDoc.maxPrice;
        const hasInStockOffer = activeOffers.some((o) => o.inStock && o.availableQuantity > 0);

        const reconciledDoc: SearchProductDocument = {
          ...baseDoc,
          offers: mergedOffers,
          minPrice,
          maxPrice,
          hasInStockOffer,
          totalOffersCount: activeOffers.length,
          sourceVersion: Math.max(doc.sourceVersion, existing.sourceVersion),
          projectionVersion: Math.max(doc.projectionVersion, existing.projectionVersion) + 1,
          updatedAt: new Date().toISOString(),
        };

        nextMap.set(doc.id, reconciledDoc);
      } else {
        nextMap.set(doc.id, structuredClone(doc));
      }
    }

    // Atomic pointer swap: readers never see an empty map or partial state!
    this.documents = nextMap;
  }

  async getDocument(id: string): Promise<SearchProductDocument | null> {
    this.checkAvailability();
    const doc = this.documents.get(id);
    return doc ? structuredClone(doc) : null;
  }

  async findProductIdByListingId(listingId: string): Promise<string | null> {
    this.checkAvailability();
    for (const doc of this.documents.values()) {
      if (doc.offers.some((o) => o.listingId === listingId)) {
        return doc.id;
      }
    }
    return null;
  }

  async deleteDocument(id: string): Promise<boolean> {
    this.checkAvailability();
    return this.documents.delete(id);
  }

  async clear(): Promise<void> {
    this.checkAvailability();
    this.documents.clear();
  }

  async count(): Promise<number> {
    this.checkAvailability();
    return this.documents.size;
  }

  async healthCheck(): Promise<{ status: string; count: number; engine: string }> {
    return {
      status: this.isAvailable ? 'healthy' : 'unhealthy',
      count: this.documents.size,
      engine: 'in-memory-derived-index',
    };
  }

  async search(params: SearchQueryParams): Promise<SearchStoreQueryResult> {
    this.checkAvailability();
    return filterAndRankDocuments(this.documents.values(), params);
  }
}
