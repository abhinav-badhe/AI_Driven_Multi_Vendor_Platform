import type { DatabaseConnection } from '../database/connection.js';
import type {
  ISearchStore,
  SearchStoreQueryResult,
  SearchProductDocument,
  SearchSellerOffer,
  SearchQueryParams,
} from '../../modules/search/index.js';
import { filterAndRankDocuments } from '../../modules/search/index.js';

interface RawProductRow {
  id: string;
  generation: number;
  title: string;
  slug: string;
  description: string | null;
  brand: string | null;
  category_id: string | null;
  category_name: string | null;
  status: string;
  min_price: number;
  max_price: number;
  currency: string;
  has_in_stock_offer: boolean | string;
  total_offers_count: number;
  attributes: Record<string, unknown> | string;
  source_version: number | string;
  projection_version: number | string;
  created_at: Date | string;
  updated_at: Date | string;
}

interface RawOfferRow {
  listing_id: string;
  generation: number;
  product_id: string;
  merchant_id: string;
  merchant_name: string | null;
  sku_id: string;
  sku_code: string;
  price_amount: number | string;
  currency: string;
  compare_at_price: number | string | null;
  status: string;
  in_stock: boolean | string;
  available_quantity: number | string;
  attributes: Record<string, unknown> | string;
  source_version: number | string;
  updated_at: Date | string;
}

function parseJsonField(val: unknown): Record<string, unknown> {
  if (!val) return {};
  if (typeof val === 'string') {
    try {
      return JSON.parse(val);
    } catch {
      return {};
    }
  }
  if (typeof val === 'object') return val as Record<string, unknown>;
  return {};
}

function parseBool(val: unknown): boolean {
  return val === true || val === 't' || val === 'true' || val === 1 || val === '1';
}

function toIsoString(val: unknown): string {
  if (val instanceof Date) return val.toISOString();
  if (typeof val === 'string') return new Date(val).toISOString();
  return new Date().toISOString();
}

/**
 * PostgreSQL-Backed Persistent and Shared Search Store Adapter.
 *
 * PRODUCTION-GRADE PERSISTENCE IMPLEMENTATION:
 * - Persists derived read models to PostgreSQL schema ('search_product_projections', 'search_seller_offers')
 * - Projection survives application restarts and process crashes
 * - Multi-instance / multi-replica nodes observe the identical shared search index
 * - Zero-downtime atomic rebuild via generation pointer table ('search_projection_state')
 * - Full concurrency & stale-write safety against in-flight domain events
 */
export class SqlSearchStore implements ISearchStore {
  constructor(private readonly db: DatabaseConnection) {}

  async getActiveGeneration(conn: DatabaseConnection = this.db): Promise<number> {
    const res = await conn.query<{ active_generation: number | string }>(
      `SELECT active_generation FROM search_projection_state WHERE id = 'active'`,
    );
    if (res.rows.length > 0 && res.rows[0]) {
      return Number(res.rows[0].active_generation);
    }
    // Initialize default active generation if absent
    await conn.query(
      `INSERT INTO search_projection_state (id, active_generation) VALUES ('active', 1)`,
    );
    return 1;
  }

  async indexDocument(doc: SearchProductDocument): Promise<void> {
    await this.db.withTransaction(async (tx) => {
      const gen = await this.getActiveGeneration(tx);
      await this.upsertSingleDoc(tx, doc, gen);
    });
  }

  async bulkIndex(docs: SearchProductDocument[]): Promise<void> {
    if (docs.length === 0) return;
    await this.db.withTransaction(async (tx) => {
      const gen = await this.getActiveGeneration(tx);
      for (const doc of docs) {
        await this.upsertSingleDoc(tx, doc, gen);
      }
    });
  }

  private async upsertSingleDoc(
    tx: DatabaseConnection,
    doc: SearchProductDocument,
    gen: number,
  ): Promise<void> {
    const existing = await tx.query<{ id: string }>(
      `SELECT id FROM search_product_projections WHERE id = $1 AND generation = $2`,
      [doc.id, gen],
    );

    const attributesJson = JSON.stringify(doc.attributes ?? {});
    const nowIso = new Date().toISOString();

    if (existing.rows.length > 0) {
      await tx.query(
        `UPDATE search_product_projections SET
          title = $1, slug = $2, description = $3, brand = $4, category_id = $5,
          category_name = $6, status = $7, min_price = $8, max_price = $9, currency = $10,
          has_in_stock_offer = $11, total_offers_count = $12, attributes = $13::jsonb,
          source_version = $14, projection_version = $15, updated_at = $16
        WHERE id = $17 AND generation = $18`,
        [
          doc.title,
          doc.slug,
          doc.description ?? null,
          doc.brand ?? null,
          doc.categoryId ?? null,
          doc.categoryName ?? null,
          doc.status,
          doc.minPrice,
          doc.maxPrice,
          doc.currency,
          doc.hasInStockOffer,
          doc.totalOffersCount,
          attributesJson,
          doc.sourceVersion,
          doc.projectionVersion,
          nowIso,
          doc.id,
          gen,
        ],
      );
    } else {
      await tx.query(
        `INSERT INTO search_product_projections (
          id, generation, title, slug, description, brand, category_id, category_name,
          status, min_price, max_price, currency, has_in_stock_offer, total_offers_count,
          attributes, source_version, projection_version, created_at, updated_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15::jsonb, $16, $17, $18, $19
        )`,
        [
          doc.id,
          gen,
          doc.title,
          doc.slug,
          doc.description ?? null,
          doc.brand ?? null,
          doc.categoryId ?? null,
          doc.categoryName ?? null,
          doc.status,
          doc.minPrice,
          doc.maxPrice,
          doc.currency,
          doc.hasInStockOffer,
          doc.totalOffersCount,
          attributesJson,
          doc.sourceVersion,
          doc.projectionVersion,
          doc.createdAt || nowIso,
          nowIso,
        ],
      );
    }

    // Refresh seller offers for this product in the active generation
    await tx.query(`DELETE FROM search_seller_offers WHERE product_id = $1 AND generation = $2`, [
      doc.id,
      gen,
    ]);

    for (const offer of doc.offers) {
      await tx.query(
        `INSERT INTO search_seller_offers (
          listing_id, generation, product_id, merchant_id, merchant_name, sku_id,
          sku_code, price_amount, currency, compare_at_price, status, in_stock,
          available_quantity, attributes, source_version, updated_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb, $15, $16
        )`,
        [
          offer.listingId,
          gen,
          doc.id,
          offer.merchantId,
          offer.merchantName ?? null,
          offer.skuId,
          offer.skuCode,
          offer.priceAmount,
          offer.currency,
          offer.compareAtPrice ?? null,
          offer.status,
          offer.inStock,
          offer.availableQuantity,
          JSON.stringify(offer.attributes ?? {}),
          offer.sourceVersion,
          offer.updatedAt || nowIso,
        ],
      );
    }
  }

  /**
   * Atomic, Zero-Downtime Rebuild:
   * 1. Next generation (currentGen + 1) is prepared independently.
   * 2. Reconciles with current generation to guarantee newer event versions (v150 vs v100) are never lost.
   * 3. Atomically switches active_generation pointer in search_projection_state.
   * 4. Cleans up old generations.
   * 5. If any failure occurs during preparation, active_generation remains unchanged.
   */
  async replaceProjection(docs: SearchProductDocument[]): Promise<void> {
    const currentGen = await this.getActiveGeneration();
    const nextGen = currentGen + 1;

    await this.db.withTransaction(async (tx) => {
      // 1. Clear any remnants of nextGen
      await tx.query(`DELETE FROM search_seller_offers WHERE generation = $1`, [nextGen]);
      await tx.query(`DELETE FROM search_product_projections WHERE generation = $1`, [nextGen]);

      const indexedProductIds = new Set<string>();

      // 2. Insert documents into nextGen with version reconciliation against currentGen
      for (const doc of docs) {
        indexedProductIds.add(doc.id);

        const existingProdRes = await tx.query<RawProductRow>(
          `SELECT * FROM search_product_projections WHERE id = $1 AND generation = $2`,
          [doc.id, currentGen],
        );
        const existingOffersRes = await tx.query<RawOfferRow>(
          `SELECT * FROM search_seller_offers WHERE product_id = $1 AND generation = $2`,
          [doc.id, currentGen],
        );

        let finalDoc = doc;

        if (existingProdRes.rows.length > 0 && existingProdRes.rows[0]) {
          const existingProd = existingProdRes.rows[0];
          const existingOffers = existingOffersRes.rows.map((r) => this.mapRawOffer(r));
          const existingProdVersion = Number(existingProd.source_version);

          // Preserve existing product if concurrent event arrived with newer version
          const preserveExistingProduct = existingProdVersion > doc.sourceVersion;
          const baseDoc = preserveExistingProduct ? this.mapRawProduct(existingProd, []) : doc;

          // Reconcile offers: compare sourceVersion per offer
          const mergedOffers = [...doc.offers];
          for (const existingOffer of existingOffers) {
            const incomingIdx = mergedOffers.findIndex(
              (o) => o.listingId === existingOffer.listingId,
            );
            if (incomingIdx >= 0) {
              if (existingOffer.sourceVersion > mergedOffers[incomingIdx]!.sourceVersion) {
                mergedOffers[incomingIdx] = existingOffer;
              }
            } else {
              mergedOffers.push(existingOffer);
            }
          }

          const activeOffers = mergedOffers.filter((o) => o.status === 'ACTIVE');
          const minPrice =
            activeOffers.length > 0
              ? Math.min(...activeOffers.map((o) => o.priceAmount))
              : baseDoc.minPrice;
          const maxPrice =
            activeOffers.length > 0
              ? Math.max(...activeOffers.map((o) => o.priceAmount))
              : baseDoc.maxPrice;
          const hasInStockOffer = activeOffers.some((o) => o.inStock && o.availableQuantity > 0);

          finalDoc = {
            ...baseDoc,
            offers: mergedOffers,
            minPrice,
            maxPrice,
            hasInStockOffer,
            totalOffersCount: activeOffers.length,
            sourceVersion: Math.max(doc.sourceVersion, existingProdVersion),
            projectionVersion:
              Math.max(doc.projectionVersion, Number(existingProd.projection_version)) + 1,
            updatedAt: new Date().toISOString(),
          };
        }

        await this.upsertSingleDoc(tx, finalDoc, nextGen);
      }

      // 3. Preserve any products created in currentGen during rebuild that were not part of docs snapshot
      const currentProdsRes = await tx.query<RawProductRow>(
        `SELECT * FROM search_product_projections WHERE generation = $1`,
        [currentGen],
      );
      for (const prodRow of currentProdsRes.rows) {
        if (!indexedProductIds.has(prodRow.id)) {
          const offersRes = await tx.query<RawOfferRow>(
            `SELECT * FROM search_seller_offers WHERE product_id = $1 AND generation = $2`,
            [prodRow.id, currentGen],
          );
          const offers = offersRes.rows.map((r) => this.mapRawOffer(r));
          const doc = this.mapRawProduct(prodRow, offers);
          await this.upsertSingleDoc(tx, doc, nextGen);
        }
      }

      // 4. Atomically activate nextGen
      await tx.query(
        `UPDATE search_projection_state SET active_generation = $1, updated_at = CURRENT_TIMESTAMP WHERE id = 'active'`,
        [nextGen],
      );

      // 5. Clean up old generations
      await tx.query(`DELETE FROM search_seller_offers WHERE generation < $1`, [nextGen]);
      await tx.query(`DELETE FROM search_product_projections WHERE generation < $1`, [nextGen]);
    });
  }

  async getDocument(id: string): Promise<SearchProductDocument | null> {
    const gen = await this.getActiveGeneration();
    const prodRes = await this.db.query<RawProductRow>(
      `SELECT * FROM search_product_projections WHERE id = $1 AND generation = $2`,
      [id, gen],
    );
    if (prodRes.rows.length === 0 || !prodRes.rows[0]) {
      return null;
    }

    const offersRes = await this.db.query<RawOfferRow>(
      `SELECT * FROM search_seller_offers WHERE product_id = $1 AND generation = $2`,
      [id, gen],
    );

    const offers = offersRes.rows.map((r) => this.mapRawOffer(r));
    return this.mapRawProduct(prodRes.rows[0], offers);
  }

  async findProductIdByListingId(listingId: string): Promise<string | null> {
    const gen = await this.getActiveGeneration();
    const res = await this.db.query<{ product_id: string }>(
      `SELECT product_id FROM search_seller_offers WHERE listing_id = $1 AND generation = $2`,
      [listingId, gen],
    );
    return res.rows.length > 0 && res.rows[0] ? res.rows[0].product_id : null;
  }

  async deleteDocument(id: string): Promise<boolean> {
    return this.db.withTransaction(async (tx) => {
      const gen = await this.getActiveGeneration(tx);
      await tx.query(`DELETE FROM search_seller_offers WHERE product_id = $1 AND generation = $2`, [
        id,
        gen,
      ]);
      const res = await tx.query(
        `DELETE FROM search_product_projections WHERE id = $1 AND generation = $2`,
        [id, gen],
      );
      return (res.rowCount ?? 0) > 0;
    });
  }

  async clear(): Promise<void> {
    const gen = await this.getActiveGeneration();
    await this.db.withTransaction(async (tx) => {
      await tx.query(`DELETE FROM search_seller_offers WHERE generation = $1`, [gen]);
      await tx.query(`DELETE FROM search_product_projections WHERE generation = $1`, [gen]);
    });
  }

  async count(): Promise<number> {
    const gen = await this.getActiveGeneration();
    const res = await this.db.query<{ cnt: number | string }>(
      `SELECT COUNT(*) as cnt FROM search_product_projections WHERE generation = $1`,
      [gen],
    );
    return res.rows.length > 0 && res.rows[0] ? Number(res.rows[0].cnt) : 0;
  }

  async healthCheck(): Promise<{ status: string; count: number; engine: string }> {
    try {
      const cnt = await this.count();
      return {
        status: 'healthy',
        count: cnt,
        engine: 'postgresql-shared-projection',
      };
    } catch {
      return {
        status: 'unhealthy',
        count: 0,
        engine: 'postgresql-shared-projection',
      };
    }
  }

  async search(params: SearchQueryParams): Promise<SearchStoreQueryResult> {
    const gen = await this.getActiveGeneration();
    const includeInactive = params.includeInactive === true;

    // Load candidate products for current generation
    const sql = includeInactive
      ? `SELECT * FROM search_product_projections WHERE generation = $1`
      : `SELECT * FROM search_product_projections WHERE generation = $1 AND status = 'ACTIVE'`;

    const prodsRes = await this.db.query<RawProductRow>(sql, [gen]);
    if (prodsRes.rows.length === 0) {
      return {
        items: [],
        scores: new Map(),
        total: 0,
        facets: {
          categories: [],
          brands: [],
          merchants: [],
          priceRange: { min: 0, max: 0 },
        },
      };
    }

    // Load all offers for active generation
    const offersRes = await this.db.query<RawOfferRow>(
      `SELECT * FROM search_seller_offers WHERE generation = $1`,
      [gen],
    );

    const offersByProduct = new Map<string, SearchSellerOffer[]>();
    for (const r of offersRes.rows) {
      const offer = this.mapRawOffer(r);
      const list = offersByProduct.get(r.product_id) ?? [];
      list.push(offer);
      offersByProduct.set(r.product_id, list);
    }

    const docs: SearchProductDocument[] = prodsRes.rows.map((p) => {
      const offers = offersByProduct.get(p.id) ?? [];
      return this.mapRawProduct(p, offers);
    });

    return filterAndRankDocuments(docs, params);
  }

  private mapRawProduct(r: RawProductRow, offers: SearchSellerOffer[]): SearchProductDocument {
    return {
      id: r.id,
      title: r.title,
      slug: r.slug,
      description: r.description ?? null,
      brand: r.brand ?? null,
      categoryId: r.category_id ?? null,
      categoryName: r.category_name ?? null,
      status: r.status as 'DRAFT' | 'ACTIVE' | 'INACTIVE' | 'ARCHIVED',
      minPrice: Number(r.min_price),
      maxPrice: Number(r.max_price),
      currency: r.currency,
      hasInStockOffer: parseBool(r.has_in_stock_offer),
      totalOffersCount: Number(r.total_offers_count),
      offers,
      attributes: parseJsonField(r.attributes),
      sourceVersion: Number(r.source_version),
      projectionVersion: Number(r.projection_version),
      createdAt: toIsoString(r.created_at),
      updatedAt: toIsoString(r.updated_at),
    };
  }

  private mapRawOffer(r: RawOfferRow): SearchSellerOffer {
    return {
      listingId: r.listing_id,
      merchantId: r.merchant_id,
      merchantName: r.merchant_name ?? undefined,
      skuId: r.sku_id,
      skuCode: r.sku_code,
      priceAmount: Number(r.price_amount),
      currency: r.currency,
      compareAtPrice: r.compare_at_price != null ? Number(r.compare_at_price) : null,
      status: r.status as 'DRAFT' | 'ACTIVE' | 'INACTIVE' | 'SUSPENDED',
      inStock: parseBool(r.in_stock),
      availableQuantity: Number(r.available_quantity),
      attributes: parseJsonField(r.attributes),
      sourceVersion: Number(r.source_version),
      updatedAt: toIsoString(r.updated_at),
    };
  }
}
