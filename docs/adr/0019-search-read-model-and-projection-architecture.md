# ADR 0019: Search Derived Read-Model and Projection Architecture

## Status
Accepted

## Context
Phase 9 introduces the Search bounded context for product discovery and faceted search across the multi-vendor marketplace platform.

Key requirements and constraints:
1. **Derived Read Model**: Search is strictly a derived read model. It does NOT own transactional truth.
2. **Authoritative Sources**:
   - Product and SKU identity are owned authoritatively by **Catalog**.
   - Merchant listing commercial terms (pricing, seller ownership, listing status) are owned authoritatively by **Marketplace**.
   - Real-time stock levels and reservations are owned authoritatively by **Inventory**.
   - Post-order and payment records are owned by **Orders** and **Payment**.
3. **Multi-Vendor Relationship**:
   ```text
   Canonical Product
         ↓
    Variant / SKU
         ↓
   Merchant Listing
   ```
   A single canonical product may have multiple seller listings (e.g. Product X with Seller A @ ₹100, Seller B @ ₹95). Search must preserve this relationship and not collapse multiple sellers into a single seller-owned record.
4. **Storage Abstraction**: The domain must not be coupled directly to an external search cluster (Elasticsearch, OpenSearch, etc.). A provider-neutral abstraction is required.
5. **No Event Bus Yet**: As Phase 10 will introduce event-driven distribution, Phase 9 must provide typed application-level projection synchronization contracts (`upsertProductProjection`, `upsertListingProjection`, `removeProductProjection`, `removeListingProjection`, `rebuildProjection`) that future event handlers will invoke.
6. **Stale Write Protection**: Stale or out-of-order projection updates must be deterministically rejected using source versioning.

## Decisions

### 1. Separation of Concerns: Transactional Truth vs. Derived Projection
* Search documents are read-optimized snapshots for discovery, filtering, and scoring.
* Search NEVER executes transactional writes to PostgreSQL tables (`products`, `product_skus`, `categories`, `merchant_listings`, `inventory_items`, `orders`, `payments`, `settlements`).
* Search pricing and inventory flags are advisory. The checkout and inventory reservation engines always revalidate authoritative pricing and availability at transaction time.

### 2. Provider-Neutral Search Store Abstraction (`ISearchStore`)
* Domain logic interacts exclusively with the typed `ISearchStore` interface:
  ```typescript
  export interface ISearchStore {
    indexDocument(doc: SearchProductDocument): Promise<void>;
    bulkIndex(docs: SearchProductDocument[]): Promise<void>;
    getDocument(id: string): Promise<SearchProductDocument | null>;
    deleteDocument(id: string): Promise<boolean>;
    search(params: SearchQueryParams): Promise<SearchStoreQueryResult>;
    clear(): Promise<void>;
    count(): Promise<number>;
    healthCheck(): Promise<{ status: string; count: number; engine: string }>;
  }
  ```
* For this development/test environment where external search clusters (Elasticsearch/OpenSearch) are not active (verified on ports 9200 and 7700), an `InMemorySearchStore` adapter is provided. It implements full-text keyword tokenization, multi-field weighted scoring, multi-vendor offer filtering, dynamic candidate facet aggregation, and deterministic pagination.

### 3. Canonical Product & Multi-Vendor Offer Schema
* `SearchProductDocument`:
  - `id`: Canonical product ID
  - `title`, `slug`, `brand`, `categoryId`, `categoryName`, `description`
  - `minPrice`, `maxPrice`, `currency`, `hasInStockOffer`, `totalOffersCount`
  - `offers`: Array of `SearchSellerOffer` preserving individual seller listings, merchant identity, price, stock status, and variant attributes
  - `sourceVersion`, `projectionVersion`, `updatedAt`
* When querying:
  - If searching generally, the lowest-priced active offer is highlighted as `bestOffer`, while all active offers are preserved in `offers`.
  - If filtering by `merchantId`, the targeted merchant's offer is attached as `matchedOffer`.

### 4. Projection Versioning & Stale Write Guard
* Every projection update provides a `sourceVersion`.
* When an update arrives:
  - If `input.sourceVersion <= existing.sourceVersion`, the update is ignored with reason `STALE_OR_DUPLICATE_VERSION`.
  - If `input.sourceVersion > existing.sourceVersion`, the document is merged, `projectionVersion` is incremented, and prices/offers are recalculated.
* Per-product asynchronous mutex locks serialize concurrent in-flight updates to prevent lost updates or document corruption.

### 5. Architectural Dependency Boundaries
* Search depends only on public interfaces of `CatalogService`, `ListingService`, `InventoryService`, and `MerchantService`.
* Search NEVER imports `internal/` implementation files from other modules.
* Search NEVER imports `infra/database` (enforced by `boundary-rules.ts` Rule 3).
* Search NEVER imports downstream transactional modules (`Orders`, `Payment`, `Settlement`) (enforced by `boundary-rules.ts` Rule 5).

## Consequences
* Clean, decoupled product discovery with sub-millisecond query execution.
* Seamless future transition to distributed search engines (Elasticsearch, OpenSearch) by swapping the `ISearchStore` implementation without touching domain services or HTTP routes.
* Guaranteed checkout integrity: no stale search price or stock flag can compromise financial or inventory truth.
