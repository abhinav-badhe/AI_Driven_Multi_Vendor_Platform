# ADR 0022: Recommendations Bounded Context & Deterministic Ranking Architecture

## Status

Accepted

## Context

Phase 12 introduces the platform's **Recommendations** bounded context and capability. The goal of this capability is to generate personalized, similar-product, trending, and frequently-bought-together suggestions for shoppers, with deterministic scoring, explainable reason codes, robust cold-start handling, and multi-vendor offer isolation, all while ensuring recommendations remain strictly a derived read model and never a source of transactional truth.

> **Explicit Phase Boundary Statement:**
> Phase 12 uses deterministic/rule-based recommendation logic and analytical order signals from Phase 11. ML-based recommendation/ranking models and training pipelines belong to Phase 13. Embeddings, vector databases, WhatsApp AI, and RAG belong to Phase 14.

---

## Architectural Principles & Boundary Guarantees

### 1. Derived Read Capability Invariant

Recommendations are fundamentally a **derived read capability**, never transactional truth:

```text
Transactional Domains (Catalog, Marketplace, Inventory, Orders, Payments, Settlement)
        ↓
   Phase 10 Events
        ↓
   Phase 11 Analytics / Catalog / Marketplace Authorized Read Interfaces
        ↓
 Recommendations Candidate Generation & Deterministic Ranking
        ↓
 Recommendations Derived Storage (derived_recommendations)
        ↓
 Recommendation APIs
```

Recommendations must **NEVER** become the source of truth for:

- product identity (owned by Catalog)
- SKU identity (owned by Catalog)
- seller identity (owned by Merchant/Identity)
- price (owned by Marketplace merchant listings)
- inventory (owned by Inventory)
- orders (owned by Orders)
- payments (owned by Payment)
- settlement (owned by Settlement & Ledger)
- customer ownership (owned by Identity/Customer)

At recommendation display time, price and availability are derived information. The authoritative checkout and order placement flows revalidate current prices and reserve physical stock authoritatively before purchase.

### 2. Multi-Vendor Model Preservation

Recommendations strictly preserve the platform's multi-vendor hierarchy:

```text
Canonical Product
      ↓
   Variant / SKU
      ↓
Merchant Listing / Seller Offer
```

- Recommendations recommend **canonical Products/SKUs**, not arbitrary seller records.
- Multiple sellers offering the same canonical SKU remain distinct seller offers under `activeOffers`.
- Inactive or suspended seller listings are excluded from active offers.
- Recommendations never merge different sellers into one authoritative record or imply guaranteed price or inventory.

### 3. Tenant Isolation & Privacy Enforcement

- **Customer Privacy**: Personalized recommendations derive customer identity strictly from the authenticated actor context (`actor.userId`, `actor.tenantId`). A customer can never pass an arbitrary customer ID to read another customer's recommendation profile.
- **Tenant Isolation**: Recommendations are partitioned strictly by `tenant_id`. No tenant can query or observe another tenant's private customer purchase behavior or derived recommendations.
- **Merchant Boundary**: Merchant APIs expose authorized aggregate data only and cannot access raw customer purchase profiles.

---

## Decisions

### 1. Recommendation Types & Signals

Phase 12 implements four distinct recommendation types:

1. **Personalized (`PERSONALIZED`)**:
   - Analyzes customer order history from Phase 11 `analytics_order_facts` scoped to `tenant_id` and `customer_id`.
   - Identifies category and brand affinities, recommending unbought items in preferred categories.
   - Reason Code: `PERSONALIZED_HISTORY`.
2. **Similar Products (`SIMILAR`)**:
   - Evaluates category, brand, and catalog attributes for a given active `sourceProductId`.
   - Recommends active products in the same category or brand, excluding the source product.
   - Reason Codes: `SIMILAR_PRODUCT`, `CATEGORY_MATCH`.
3. **Trending (`TRENDING`)**:
   - Aggregates recent purchase volume (units sold and distinct orders) from Phase 11 `analytics_order_facts` over a configurable recency window.
   - Ranks popular products across the tenant deterministically.
   - Reason Codes: `TRENDING`, `POPULAR_IN_CATEGORY`.
4. **Frequently Bought Together (`FREQUENTLY_BOUGHT_TOGETHER`)**:
   - Computes co-purchase frequency in `analytics_order_facts` (other products purchased in the same `order_id` in the tenant).
   - Reason Code: `FREQUENTLY_BOUGHT_TOGETHER`.

### 2. Cold-Start Strategy

To prevent non-deterministic or random recommendations, a deterministic fallback cascade is enforced:

- **For a Customer with Insufficient History**:
  $$\text{Personalized} \longrightarrow \text{Trending} \longrightarrow \text{Category / Popularity Fallback} \longrightarrow \text{Deterministic Active Catalog Sorted by Title / ID}$$
- **For a New Product with Insufficient History**:
  $$\text{Category Similarity} \longrightarrow \text{Brand Match} \longrightarrow \text{Trending / Catalog Fallback}$$
- Identical inputs always yield identical deterministic fallback recommendations.

### 3. Candidate Generation and Ranking Provider Abstraction

Generation is decoupled from ranking via explicit interfaces:

- `IRecommendationCandidateSource`: Generates raw candidates with candidate-level base signals.
- `IRecommendationRanker`: Ranks candidates using composite weighting and deterministic tie-breaking.
- `IRecommendationStore`: Manages derived persistence in `derived_recommendations`.

The platform implements `DeterministicRuleBasedRanker` with centralized weights:

```typescript
export interface RankerWeights {
  eligibilityWeight: number; // 10.0
  categoryRelevanceWeight: number; // 25.0
  coPurchaseWeight: number; // 35.0
  popularityWeight: number; // 20.0
  affinityWeight: number; // 10.0
  stalenessPenaltyWeight: number; // 5.0
}
```

**Deterministic Tie-Breaking**:
$$\text{Score DESC} \quad \text{then} \quad \text{Product ID ASC (lexicographical)}$$

**Future Extensibility**: A future Phase 13 ML Ranker (e.g. XGBoost/deep learning scoring model) can implement `IRecommendationRanker` and be injected without changing API contracts, database schemas, or transactional domains.

### 4. Derived Recommendation Schema (`0011_recommendations_schema.sql`)

1. `derived_recommendations`:
   - `id VARCHAR(64) PRIMARY KEY`
   - `scope_key VARCHAR(255) NOT NULL UNIQUE` (composite deterministic surrogate key: `${tenantId}:${type}:${customerId || 'NONE'}:${sourceProductId || 'NONE'}:${recommendedProductId}`)
   - `tenant_id VARCHAR(64) NOT NULL`
   - `customer_id VARCHAR(64)` (nullable)
   - `recommendation_type VARCHAR(32) NOT NULL`
   - `source_product_id VARCHAR(64)` (nullable)
   - `recommended_product_id VARCHAR(64) NOT NULL`
   - `rank_position INT NOT NULL`
   - `score NUMERIC(10,4) NOT NULL`
   - `reason_code VARCHAR(64) NOT NULL`
   - `explanation TEXT NOT NULL`
   - `derived_metadata JSONB NOT NULL DEFAULT '{}'::jsonb`
   - `created_at`, `updated_at`, `expires_at TIMESTAMPTZ`
2. `recommendation_rebuild_audit`:
   - Tracks administrative rebuild operations with status (`STARTED`, `COMPLETED`, `FAILED`), timestamps, actor ID, and counts.

### 5. Event-Driven Invalidation & Idempotency

`RecommendationEventConsumer` extends `BaseEventConsumer` (`recommendations-ingestor`) and consumes Phase 10 events:

- `catalog.product.archived.v1`: Immediately invalidates derived recommendation rows referencing that product.
- `catalog.product.updated.v1` & `marketplace.listing.deactivated.v1`: Acknowledged and invalidates stale offer metadata.
- `order.created.v1`: Updates co-purchase and trending signals.
  Deduplication is guaranteed via `event_consumer_receipts`.

### 6. Administrative Rebuild Mechanism

- Endpoint: `POST /recommendations/rebuild` (protected by `recommendations:rebuild` for `ADMINISTRATOR` role).
- Clears derived recommendations for the tenant and reconstructs trending, similar, and frequently-bought-together models from scratch using active catalog and analytics facts.
- Rebuild does not depend on previous recommendation rows.
- Fails explicitly on error, recording a `FAILED` audit record with error details.

---

## Consequences

### Positive

- Fast, index-accelerated recommendation APIs serving pre-scored derived results.
- Full explainability on every recommendation item (`reasonCode` and `explanation`).
- Deterministic cold-start eliminates empty states without violating customer privacy or generating random junk.
- Complete decoupling from transactional mutation tables: Recommendations can be wiped and rebuilt at any time without affecting orders or stock.
- Clean provider interface ready for seamless Phase 13 ML integration.

### Limitations & Non-Goals in Phase 12

- No ML model training, neural networks, or vector embeddings (Phase 13 / Phase 14).
- No WhatsApp AI conversational recommendations (Phase 14).
- No microservice network extraction (Phase 17).
