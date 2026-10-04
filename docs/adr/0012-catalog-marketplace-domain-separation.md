# ADR 0012: Separation of Canonical Catalog and Multi-Vendor Marketplace Listings

## Status
Accepted

## Context
In a multi-vendor predictive commerce platform, multiple merchants sell the same physical or digital items. A naïve e-commerce data model often conflates products, variants, prices, and seller ownership into a single monolithic entity (e.g., each merchant creating their own duplicate "Nike Air Max 90" product with seller-specific pricing).

This conflation causes:
1. Catalog fragmentation and duplicate products across the marketplace.
2. Inability to provide unified search, aggregated reviews, or side-by-side merchant price comparison for the same canonical item.
3. Leaking merchant ownership and pricing invariants into the core catalog domain.
4. Premature coupling of commercial offers and future inventory management with master product data.

## Decision
We strictly enforce a three-tier canonical domain model:
**Canonical Product → Variant/SKU → Merchant Listing**

### 1. Bounded Context Separation
- **Catalog Context (`modules/catalog`)**:
  - Owns: `categories`, `products`, `product_skus`.
  - Invariants: Canonical items are seller-independent. Products and SKUs contain **zero** merchant pricing, zero merchant ownership, and zero inventory counts.
  - Lifecycle:
    - Product: `DRAFT` → `ACTIVE` | `ARCHIVED`; `ACTIVE` → `INACTIVE` | `ARCHIVED`; `INACTIVE` → `ACTIVE` | `ARCHIVED`; `ARCHIVED` is terminal.
    - SKU: `DRAFT` → `ACTIVE`; `ACTIVE` → `INACTIVE`; `INACTIVE` → `ACTIVE`. SKUs cannot be created on or transitioned to `ACTIVE` under an `ARCHIVED` product.

- **Marketplace Context (`modules/marketplace`)**:
  - Owns: `merchant_listings`.
  - Invariants: A listing represents a merchant's commercial offer for a canonical SKU. It contains `price_amount`, `currency`, `compare_at_price`, and `status`.
  - Multi-Vendor Rule: Multiple merchants may independently list the exact same canonical SKU at different price points.
  - Merchant Uniqueness: A composite unique constraint `(tenant_id, sku_id)` guarantees a single merchant cannot create duplicate listings for the same SKU.
  - Lifecycle: `DRAFT` → `ACTIVE` | `INACTIVE`; `ACTIVE` → `INACTIVE` | `SUSPENDED`; `INACTIVE` → `ACTIVE` | `SUSPENDED`; `SUSPENDED` → `ACTIVE` | `INACTIVE` (administrator only).
  - Listing activation precondition: A listing can only transition to `ACTIVE` if the referenced canonical SKU is `ACTIVE` and the merchant tenant is `VERIFIED`.

- **Exclusion of Inventory**:
  - Phase 3 strictly prohibits stock quantity, available/reserved quantity, warehouses, and deduction/movement logic. Inventory concerns belong exclusively to Phase 4.

## Consequences
- **Positive**: Clean multi-vendor capabilities, canonical product deduplication, robust tenant isolation, modular boundaries, and clean separation between catalog information and commercial offers.
- **Negative**: Creating an active listing requires multi-step validation (canonical SKU must exist and be active; merchant must be verified).
