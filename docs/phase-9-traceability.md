# Phase 9 Traceability Matrix: Derived Read-Model Search

## 1. Executive Summary & Objective

Phase 9 implements the **Search** bounded context as an independent, **derived read model** within the AI-Driven Multi-Vendor Predictive Commerce Platform.

The implementation preserves the platform's core architectural principle:

> **Transactional systems own facts → events distribute facts → analytics explains → ML predicts → AI assists using authorized facts.**

Search acts strictly as a derived discovery layer:

```text
Catalog / Marketplace / Inventory / Pricing
              ↓
       Search Projection
              ↓
        Search Queries
```

Search NEVER becomes transactional truth.

---

## 2. Bounded-Context Ownership

- **Search owns**:
  - `SearchProductDocument` & `SearchSellerOffer`: Read-optimized derived projections.
  - `ISearchStore` / `InMemorySearchStore`: Storage and inverted index abstraction.
  - Full-text token matching, multi-criteria filtering, ranking, and facet aggregations.
  - Projection versioning (`sourceVersion`, `projectionVersion`) and stale-write rejection.
  - Public search API (`GET /search`, `GET /search/documents/:id`) and administrative rebuild/sync endpoints.

- **Catalog owns**:
  - `products`, `product_skus`, `categories`.
  - Search reads product/sku details exclusively via public `CatalogService` methods.

- **Marketplace owns**:
  - `merchant_listings`.
  - Search reads listing prices and statuses exclusively via public `ListingService` methods.

- **Inventory owns**:
  - Real-time stock levels, reservations, and inventory movements.
  - Search reads derived stock flags exclusively via public `InventoryService.getAvailabilityByListingId`.

- **Search DOES NOT**:
  - Execute SQL or import `infra/database` directly.
  - Mutate transactional tables (`products`, `merchant_listings`, `inventory_items`, `orders`, `payments`, `settlements`).
  - Import private `internal/` repositories from other modules.
  - Depend on or import downstream modules (`orders`, `payment`, `settlement-ledger`).
  - Authorize transactions or guarantee stock reservation capability.

---

## 3. Requirement Traceability Matrix

| Requirement                                   | Implementation Artifacts                                                                     | Verification / Tests                                                                                                 | Status   |
| :-------------------------------------------- | :------------------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------- | :------- |
| **Derived Read Model Architecture**           | `SearchService`, `InMemorySearchStore`, Rule 3 in `boundary-rules.ts`                        | `test/architecture.test.ts` (Rule 3 & Rule 5 tests)                                                                  | **PASS** |
| **Provider-Neutral Storage Abstraction**      | `ISearchStore` interface in `search-store.ts`                                                | `test/search.test.ts` (all query, filter, and facet tests)                                                           | **PASS** |
| **Multi-Vendor Canonical Aggregation**        | `SearchProductDocument.offers: SearchSellerOffer[]`                                          | `indexes canonical product and preserves multiple distinct seller offers without collapsing sellers`                 | **PASS** |
| **Merchant Filter & Matched Offer**           | `matchedOffer` attachment on `merchantId` query                                              | `attaches matchedOffer when filtered specifically by merchantId`                                                     | **PASS** |
| **Text Search & Multi-Field Relevance**       | Inverted tokenization + weighted field scoring (title, brand, category, sku, description)    | `supports text matching, category filter, brand filter, price range, and inStock filter`                             | **PASS** |
| **Faceted Filtering**                         | Category, Brand, Merchant, InStock, Price Range, and Attributes                              | `supports text matching, category filter, brand filter, price range, and inStock filter`                             | **PASS** |
| **Dynamic Facet Aggregation**                 | Candidate set facet calculation before pagination                                            | `supports text matching, category filter, brand filter, price range, and inStock filter`                             | **PASS** |
| **Deterministic Sorting & Pagination**        | `relevance`, `price_asc`, `price_desc`, `newest` with secondary `id` tie-breaker             | `enforces deterministic pagination with secondary tie-breaker`                                                       | **PASS** |
| **Stale-Write Protection**                    | `sourceVersion` comparison rejecting older/duplicate versions                                | `accepts higher source version and deterministically drops older/duplicate versions`                                 | **PASS** |
| **Concurrency Safeguards**                    | In-process per-product mutex locks                                                           | `handles concurrent projection updates safely without data corruption`                                               | **PASS** |
| **Delete & Deactivation Semantics**           | Deleting derived projections leaves transactional tables untouched                           | `removes listing offer and product projection without modifying or deleting transactional source records`            | **PASS** |
| **Projection Rebuild Capability**             | `SearchService.rebuildProjection` consuming public domain services                           | `indexes canonical product and preserves multiple distinct seller offers without collapsing sellers`                 | **PASS** |
| **Tenant Isolation & Public Visibility**      | Inactive/unverified listings and draft products hidden from public search                    | `prevents customers from inspecting inactive products via includeInactive flag`                                      | **PASS** |
| **Administrative Authorization**              | Rebuild and projection sync require `ADMINISTRATOR` role (`search:reindex`, `search:manage`) | `prevents non-administrators from triggering rebuild or mutating projections`                                        | **PASS** |
| **Query DSL Injection Protection**            | Sanitization stripping control characters (`{}[]()*+?~\"\\/^`)                               | `sanitizes query parameters and neutralizes search DSL control characters`                                           | **PASS** |
| **Request Bounds Validation**                 | Validation on page, pageSize, minPrice, maxPrice, sortBy                                     | `validates request bounds and rejects negative or inverted parameters with 400 Bad Request`                          | **PASS** |
| **Storage Failure Resilience**                | Storage outage returns 500 without impacting transactional DB                                | `Scenario F: search store outage fails gracefully without corrupting transactional database`                         | **PASS** |
| **Eventual Consistency / Checkout Safeguard** | Checkout authoritatively validates listing price & stock at transaction time                 | `Scenario I & J: search eventual consistency does not bypass authoritative checkout pricing or inventory validation` | **PASS** |
| **Acyclic Module Graph & Boundary Rules**     | `boundary-rules.ts` Rules 1, 3, 4, and 5                                                     | `test/architecture.test.ts` (19 tests)                                                                               | **PASS** |
