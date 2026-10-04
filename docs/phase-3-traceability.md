# Phase 3 Traceability Matrix: Catalog & Listings

## 1. Executive Summary
Phase 3 establishes the core e-commerce domain foundation by implementing the canonical catalog and multi-vendor marketplace listing architecture.

**Crucial Phase Boundary Assurance:**
* **Inventory is NOT implemented in Phase 3.** There are zero columns or logic for stock quantities, available/reserved quantities, warehouses, inventory movements, or stock reservations. Those belong exclusively to Phase 4.
* **No Search/AI/ML is implemented.** Elasticsearch, OpenSearch, vector embeddings, RAG, recommendations, and ML pipelines remain strictly excluded.
* **Preservation of Phase 1 & 2:** All existing authentication, token rotation, rate limiting, RBAC, tenant isolation, and logging foundations are fully preserved and reused.

---

## 2. Domain Ownership Model

| Bounded Context | Responsibilities & Owned Objects | Prohibited Scope |
| :--- | :--- | :--- |
| **Catalog** (`modules/catalog`) | Canonical Products (`products`), Product Categories (`categories`), SKU/Variants (`product_skus`), Master attributes (`attributes` JSONB), Catalog publication states. | Merchant pricing, merchant ownership, merchant-specific offers, stock quantities. |
| **Marketplace** (`modules/marketplace`) | Merchant Listings (`merchant_listings`), Merchant-specific price (`price_amount`, `currency`, `compare_at_price`), Listing lifecycle status, Merchant ownership of the listing. | Canonical product definitions, master SKU codes, inventory counts, warehouses. |
| **Merchant** (`modules/merchant`) | Merchant store profile, business/legal identity, onboarding, verification lifecycle (`DRAFT`, `SUBMITTED`, `VERIFIED`, `REJECTED`, `SUSPENDED`). | Products, SKUs, pricing offers. |
| **Identity & Access** (`modules/identity`) | Users, authentication, session tokens, refresh token rotation, RBAC, verified tenant context, security audit log. | Catalog details, commercial offers. |

---

## 3. Core Multi-Vendor Architectural Rule

The marketplace model enforces:
$$\text{Canonical Product} \longrightarrow \text{Variant / SKU} \longrightarrow \text{Merchant Listing(s)}$$

1. **Seller Independence**: Canonical Product and Variant/SKU entities are 100% seller-independent. Multiple merchants can sell the same physical or digital SKU without duplicating the product or SKU.
2. **Pricing Isolation**: `price_amount` and `currency` exist solely within `merchant_listings`. Neither `products` nor `product_skus` contain any pricing fields.
3. **No Duplicate Products**: A product is never duplicated because another merchant begins selling it.
4. **Merchant Uniqueness per SKU**: The composite unique constraint `UNIQUE (tenant_id, sku_id)` guarantees that a single merchant cannot create duplicate listings for the same SKU.

### Example Multi-Vendor Relationship
* **Product**: `Air Runner 2000` (`id: prod-1`, `brand: Nike`)
  * **SKU**: `PRS-BLK-09` (`id: sku-1`, `attributes: { color: "Black", size: "9" }`)
    * **Merchant Alpha Listing**: ₹8,999 (`tenant_id: tenant-alpha`, `status: ACTIVE`)
    * **Merchant Beta Listing**: ₹9,499 (`tenant_id: tenant-beta`, `status: ACTIVE`)
    * **Merchant Gamma Listing**: ₹8,799 (`tenant_id: tenant-gamma`, `status: ACTIVE`)

---

## 4. State Machines & Lifecycle Transitions

All state transitions are strictly governed by domain service business rules and rejected with `InvalidStateTransitionError` (HTTP 409) if an invalid transition is attempted.

### 4.1 Product Lifecycle
* **States**: `DRAFT`, `ACTIVE`, `INACTIVE`, `ARCHIVED`
* **Allowed Transitions**:
  * `DRAFT` $\longrightarrow$ `ACTIVE`, `ARCHIVED`
  * `ACTIVE` $\longrightarrow$ `INACTIVE`, `ARCHIVED`
  * `INACTIVE` $\longrightarrow$ `ACTIVE`, `ARCHIVED`
  * `ARCHIVED` $\longrightarrow$ (Terminal state; cannot be transitioned or modified)

### 4.2 Product SKU Lifecycle
* **States**: `DRAFT`, `ACTIVE`, `INACTIVE`
* **Allowed Transitions**:
  * `DRAFT` $\longrightarrow$ `ACTIVE`
  * `ACTIVE` $\longrightarrow$ `INACTIVE`
  * `INACTIVE` $\longrightarrow$ `ACTIVE`
* **Invariants**:
  * A SKU cannot be created on an `ARCHIVED` product.
  * A SKU cannot transition to `ACTIVE` if the parent product is `ARCHIVED`.

### 4.3 Merchant Listing Lifecycle
* **States**: `DRAFT`, `ACTIVE`, `INACTIVE`, `SUSPENDED`
* **Allowed Transitions**:
  * `DRAFT` $\longrightarrow$ `ACTIVE`, `INACTIVE`
  * `ACTIVE` $\longrightarrow$ `INACTIVE`, `SUSPENDED`
  * `INACTIVE` $\longrightarrow$ `ACTIVE`, `SUSPENDED`
  * `SUSPENDED` $\longrightarrow$ `ACTIVE`, `INACTIVE` (Administrator only)
* **Preconditions for `ACTIVE` State**:
  1. The referenced canonical SKU must exist and have `status = 'ACTIVE'`.
  2. The merchant tenant must be verified (`verification_status = 'VERIFIED'`).
* **Suspension Governance**:
  * Merchants cannot transition a listing to `SUSPENDED` or self-lift `SUSPENDED`.
  * Only `ADMINISTRATOR` actors have permission (`listing:manage-any`) to suspend or restore suspended listings.
  * Suspended listings cannot have their prices modified by merchants.

---

## 5. Security, RBAC & Tenant Isolation

1. **Verified Security Context**:
   * Tenant and merchant identity are never accepted from client headers or request bodies.
   * `actor.tenantId` is derived exclusively from verified Phase 2 JWT credentials after real-time verification in the database.
2. **Strict Multi-Tenant Isolation**:
   * A merchant can only create listings for their own tenant (`actor.tenantId`).
   * A merchant can only view and update their own draft/inactive listings (`GET /listings/me`, `PATCH /listings/:id`).
   * Cross-tenant listing modification attempts are rejected with `ForbiddenError` (HTTP 403).
   * Cross-tenant viewing of non-active listings is rejected with `ForbiddenError` (HTTP 403).
3. **Role & Permission Mapping**:
   * `catalog:create`, `catalog:update`, `catalog:status`: Platform `ADMINISTRATOR` only.
   * `catalog:read`: `ADMINISTRATOR`, `MERCHANT`, `CUSTOMER`, and public.
   * `listing:create`, `listing:read-own`, `listing:update-own`, `listing:status-own`: `MERCHANT`.
   * `listing:manage-any`: Platform `ADMINISTRATOR`.
   * `listing:read-any`: Public marketplace views for active listings.

---

## 6. Database Schema & Migration Implementation

**Migration File**: `apps/api/src/infra/database/migrations/0003_catalog_and_listings_schema.sql`

```sql
-- Categories
CREATE TABLE categories (
  id VARCHAR(64) PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  slug VARCHAR(255) NOT NULL UNIQUE,
  parent_id VARCHAR(64) REFERENCES categories(id) ON DELETE SET NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Canonical Products
CREATE TABLE products (
  id VARCHAR(64) PRIMARY KEY,
  title VARCHAR(255) NOT NULL,
  slug VARCHAR(255) NOT NULL UNIQUE,
  description TEXT,
  brand VARCHAR(255),
  category_id VARCHAR(64) REFERENCES categories(id) ON DELETE SET NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'DRAFT'
    CHECK (status IN ('DRAFT', 'ACTIVE', 'INACTIVE', 'ARCHIVED')),
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Canonical SKUs
CREATE TABLE product_skus (
  id VARCHAR(64) PRIMARY KEY,
  product_id VARCHAR(64) NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  sku_code VARCHAR(128) NOT NULL UNIQUE,
  barcode VARCHAR(128),
  attributes JSONB NOT NULL DEFAULT '{}'::jsonb,
  status VARCHAR(32) NOT NULL DEFAULT 'DRAFT'
    CHECK (status IN ('DRAFT', 'ACTIVE', 'INACTIVE')),
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Merchant Listings
CREATE TABLE merchant_listings (
  id VARCHAR(64) PRIMARY KEY,
  tenant_id VARCHAR(64) NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  sku_id VARCHAR(64) NOT NULL REFERENCES product_skus(id) ON DELETE RESTRICT,
  price_amount BIGINT NOT NULL CHECK (price_amount >= 0),
  currency VARCHAR(3) NOT NULL,
  compare_at_price BIGINT CHECK (compare_at_price IS NULL OR compare_at_price >= 0),
  status VARCHAR(32) NOT NULL DEFAULT 'DRAFT'
    CHECK (status IN ('DRAFT', 'ACTIVE', 'INACTIVE', 'SUSPENDED')),
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_merchant_sku UNIQUE (tenant_id, sku_id)
);
```

---

## 7. API Specification

| Endpoint | Method | Role / Auth | Description |
| :--- | :--- | :--- | :--- |
| `/categories` | `POST` | `ADMINISTRATOR` | Create category or subcategory |
| `/categories` | `GET` | Public / Any | List all catalog categories |
| `/categories/:id` | `GET` | Public / Any | Retrieve category details |
| `/products` | `POST` | `ADMINISTRATOR` | Create canonical product (starts in `DRAFT`) |
| `/products` | `GET` | Public / Any | List/filter canonical products (by category, status, search) |
| `/products/:id` | `GET` | Public / Any | Get product details |
| `/products/:id` | `PATCH` | `ADMINISTRATOR` | Update canonical product attributes |
| `/products/:id/status` | `POST` | `ADMINISTRATOR` | Execute product state machine transition |
| `/products/:id/skus` | `POST` | `ADMINISTRATOR` | Create canonical SKU under a product |
| `/products/:id/skus` | `GET` | Public / Any | List all SKUs for a product |
| `/skus/:id` | `GET` | Public / Any | Retrieve SKU details |
| `/skus/:id` | `PATCH` | `ADMINISTRATOR` | Update SKU attributes/barcode |
| `/skus/:id/status` | `POST` | `ADMINISTRATOR` | Execute SKU state machine transition |
| `/listings` | `POST` | `MERCHANT` | Create commercial listing for a canonical SKU |
| `/listings/me` | `GET` | `MERCHANT` | List merchant's own listings |
| `/listings/:id` | `GET` | Owner / Admin / Public | Get listing (own if draft, any if admin, active only if public) |
| `/listings/:id` | `PATCH` | `MERCHANT` (Owner) | Update listing price or compare-at price |
| `/listings/:id/status` | `POST` | `MERCHANT` / `ADMIN` | Transition listing state (`ACTIVE`, `INACTIVE`, `SUSPENDED`) |
| `/skus/:skuId/listings` | `GET` | Public / Any | Multi-vendor comparison: list all active merchant listings for SKU |

---

## 8. Requirements Traceability Matrix

| Requirement | Implementation File(s) | Database Object | Test File(s) | Status |
| :--- | :--- | :--- | :--- | :--- |
| **Inspect existing system & preserve boundaries** | `src/architecture/boundary-rules.ts` | All schemas | `test/architecture.test.ts` | **PASS** |
| **Canonical Product → Variant/SKU → Merchant Listing separation** | `src/modules/catalog/`, `src/modules/marketplace/` | `products`, `product_skus`, `merchant_listings` | `test/catalog.test.ts`, `test/listings.test.ts` | **PASS** |
| **Catalog owns Canonical Product, Categories, SKUs** | `src/modules/catalog/internal/catalog-service.ts` | `categories`, `products`, `product_skus` | `test/catalog.test.ts` | **PASS** |
| **Marketplace owns Listing, Price, Ownership** | `src/modules/marketplace/internal/listing-service.ts` | `merchant_listings` | `test/listings.test.ts` | **PASS** |
| **Multi-vendor rule: Multiple merchants list same SKU** | `src/modules/marketplace/internal/listing-service.ts` | `merchant_listings (sku_id)` | `test/listings.test.ts` | **PASS** |
| **No merchant pricing/ownership in Product or SKU** | `src/modules/catalog/internal/catalog-repository.ts` | `products`, `product_skus` | `test/catalog.test.ts` | **PASS** |
| **Listing uniqueness per merchant & SKU** | `src/modules/marketplace/internal/listing-repository.ts` | `uq_merchant_sku (tenant_id, sku_id)` | `test/migrations.test.ts`, `test/listings.test.ts` | **PASS** |
| **NO Inventory in Phase 3** | Domain models & schemas | Zero stock/warehouse columns | `test/listings.test.ts` | **PASS** |
| **Database Migrations** | `0003_catalog_and_listings_schema.sql` | 4 tables, FKs, CHECKs, UNIQUEs | `test/migrations.test.ts` | **PASS** |
| **Product State Machine** | `CatalogService.setProductStatus` | `CHECK (status IN ...)` | `test/catalog.test.ts` | **PASS** |
| **SKU State Machine** | `CatalogService.setSkuStatus` | `CHECK (status IN ...)` | `test/catalog.test.ts` | **PASS** |
| **Listing State Machine** | `ListingService.setListingStatus` | `CHECK (status IN ...)` | `test/listings.test.ts` | **PASS** |
| **Tenant Isolation & Security** | `auth-middleware.ts`, `RbacPolicy`, `ListingService` | `tenants(id)` references | `test/listings.test.ts` | **PASS** |
| **Cross-merchant modification rejection** | `ListingService.updateListing` | Tenant match check | `test/listings.test.ts` | **PASS** |
| **Thin HTTP handlers & clean service layers** | `catalog-routes.ts`, `listing-routes.ts` | - | `test/catalog.test.ts`, `test/listings.test.ts` | **PASS** |
| **Clean bounded-context dependency access** | `src/architecture/boundary-rules.ts` | - | `test/architecture.test.ts` | **PASS** |

---

## 9. Verification Summary

* **Lint (`eslint .`)**: PASS (0 errors, 0 warnings)
* **Typecheck (`tsc --noEmit`)**: PASS (0 errors in `@commerce/api` and `@commerce/web`)
* **Build (`tsc` + `vite build`)**: PASS (production build generated)
* **Test Suite (`vitest run`)**:
  * 14 test files in `@commerce/api` (92 tests passed)
  * 1 test file in `@commerce/web` (1 test passed)
  * Total: **93/93 tests passing** (100% pass rate)
