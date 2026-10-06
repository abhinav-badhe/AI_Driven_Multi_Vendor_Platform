# AI-Driven Multi-Vendor Predictive Commerce Platform

> **Complete Project Proposal, End-to-End Workflow & Corrected Production Architecture**
> Stack: **React.js • Node.js • PostgreSQL • Event-Driven Architecture • Analytics • ML/DL • LLM • WhatsApp**

---

## 0. How to Use This README (Read First — Especially If You Are an AI/Implementation Agent)

This README consolidates **two source documents**:

1. **Original Proposal** – "AI-Driven Multi-Vendor Predictive Commerce Platform: Complete Project Proposal, End-to-End Workflow & Production Architecture" (43 sections, includes a WhatsApp reference implementation based on Node.js + Express + MongoDB + Meta WhatsApp Business Platform).
2. **Corrected Production Architecture** – the revised version that preserves the same 43-section structure and project intent but adds architectural corrections. **This is the authoritative, synchronized architecture baseline.**

**Precedence rule:** Where the two documents differ, the **Corrected Production Architecture wins**. The original's WhatsApp reference-implementation details (§19.1–19.9) are preserved in this README (see **Section 19 and Appendix A**) as *operational knowledge and platform constraints*, but any part of them that conflicts with the corrected baseline (e.g. MongoDB, boolean-only inventory, self-reported UPI payment as "truth", independent chat order schema) is **not** the target architecture. Those conflicts are listed explicitly in **Appendix B**.

**Rules for any implementation agent:**
- Detailed DDL, OpenAPI contracts, event schemas, repository structure, environment configuration, deployment manifests and phase-specific prompts must be generated **from this baseline and must not contradict it**.
- Items listed under **Open Production Decisions (Section 44)** are *controlled project decisions*. **Do not silently guess them.** Record them as configuration/ADR decisions once approved.
- Build order matters: core commerce must be correct, observable and testable **before** advanced AI is introduced (Section 42).

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Problem Statement](#2-problem-statement)
3. [Project Objectives](#3-project-objectives)
4. [Users and Actors](#4-users-and-actors)
5. [High-Level Product Scope](#5-high-level-product-scope)
6. [Complete End-to-End Workflow](#6-complete-end-to-end-workflow)
7. [Customer Workflow](#7-customer-workflow)
8. [Multi-Vendor Workflow](#8-multi-vendor-workflow)
9. [Product and Catalog Model](#9-product-and-catalog-model)
10. [Inventory Architecture](#10-inventory-architecture)
11. [Database Architecture](#11-database-architecture)
12. [Database Engineering Concepts](#12-database-engineering-concepts)
13. [Transaction and Idempotency Design](#13-transaction-and-idempotency-design)
14. [Search and Discovery](#14-search-and-discovery)
15. [Recommendation Architecture](#15-recommendation-architecture)
16. [Predictive Analytics](#16-predictive-analytics)
17. [Predictive Customer Engagement Workflow](#17-predictive-customer-engagement-workflow)
18. [Analytics Architecture](#18-analytics-architecture)
19. [LLM + WhatsApp Architecture](#19-llm--whatsapp-architecture)
20. [LLM Security and Guardrails](#20-llm-security-and-guardrails)
21. [RAG Architecture](#21-rag-architecture)
22. [Security Architecture](#22-security-architecture)
23. [Threat Model](#23-threat-model)
24. [Event-Driven Architecture](#24-event-driven-architecture)
25. [Event Reliability](#25-event-reliability)
26. [Caching and Performance](#26-caching-and-performance)
27. [Failure and Recovery Workflows](#27-failure-and-recovery-workflows)
28. [Distributed-System Concepts](#28-distributed-system-concepts)
29. [ML and Deep Learning Strategy](#29-ml-and-deep-learning-strategy)
30. [AI/ML Evaluation](#30-aiml-evaluation)
31. [Observability and SRE](#31-observability-and-sre)
32. [DevOps and CI/CD](#32-devops-and-cicd)
33. [Testing Strategy](#33-testing-strategy)
34. [System Design Trade-offs](#34-system-design-trade-offs)
35. [Technology Stack and Responsibility](#35-technology-stack-and-responsibility)
36. [Why This Architecture Is Production-Oriented](#36-why-this-architecture-is-production-oriented)
37. [Implementation Roadmap](#37-implementation-roadmap)
38. [Proposed Project Deliverables](#38-proposed-project-deliverables)
39. [Definition of Done](#39-definition-of-done)
40. [Final Project Workflow — Manager View](#40-final-project-workflow--manager-view)
41. [Expected Business and Technical Outcomes](#41-expected-business-and-technical-outcomes)
42. [Scope Governance](#42-scope-governance)
43. [Conclusion](#43-conclusion)
44. [Architectural Invariants & Open Production Decisions](#44-architectural-invariants--open-production-decisions)
- [Appendix A – WhatsApp Reference Implementation Details (from Original Proposal)](#appendix-a--whatsapp-reference-implementation-details-from-original-proposal)
- [Appendix B – Original vs. Corrected: What Changed](#appendix-b--original-vs-corrected-what-changed)
- [Appendix C – Glossary](#appendix-c--glossary)

---

## 1. Executive Summary

The system is a **multi-vendor commerce platform** where:
- **Merchants** register, manage stores and listings, maintain inventory, fulfill seller orders, and receive operational intelligence.
- **Customers** discover products, compare merchant listings, purchase, manage post-order workflows, and interact through **web and WhatsApp**.
- A **separate intelligence layer** captures business events and uses analytics, predictive models and recommendation systems to improve discovery, inventory planning and customer engagement.
- A **conversational AI layer** connects WhatsApp to authorized backend tools so customers can ask about products, availability, alternatives, orders and eligible offers in natural language.
- It is designed as an **extensible production-grade system, not a basic online store**.

### Authoritative design principle

> **Transactional systems own facts; events distribute facts; analytics explains them; ML predicts; AI assists users using authorized facts.**
> Search, caches, vector stores and models are **derived or computational systems** and must **not** silently become sources of transactional truth.

### Key architectural commitments (corrected baseline)

- **Modular monolith first**, with explicit bounded contexts and transactional boundaries. Modules are independently testable and may later be extracted into services **only** when scale, ownership or deployment independence justifies the operational cost.
- **PostgreSQL** is the authoritative transactional source of truth. **Redis** is limited to cache, rate limiting and selected ephemeral session state. Search indexes, analytics stores, vector stores and ML features are **derived representations**.
- A **transactional outbox** publishes versioned domain events after successful DB commits. Consumers are **idempotent, retryable and observable**, with **dead-letter and replay** mechanisms.
- **Marketplace orders** explicitly support **one customer order containing multiple seller orders**, seller-specific fulfillment, partial cancellation/return/refund, and settlement.
- **Payment is a separate bounded context**: payment intents, attempts, provider transactions, verified webhooks, refunds, reconciliation. Payment confirmation **never** relies solely on a client or conversational message.
- **Conversational AI** accesses live commerce **only through authenticated, authorized, validated tools**. The model cannot issue SQL, select arbitrary records, bypass tenant boundaries, or invent live price, stock, payment or order facts.

The original proposal's core separation of transactional truth, asynchronous events, analytics, predictive intelligence and conversational AI is **retained**; the corrections make the boundaries **implementable rather than conceptual**.

---

## 2. Problem Statement

Traditional e-commerce systems often separate catalog, inventory, customer engagement and analytics. This platform integrates them while keeping responsibilities architecturally separated. Problems addressed:

- Multiple merchants must sell the **same canonical product/SKU** without duplicating product identity, while retaining **merchant-specific price, stock, fulfillment and commercial terms**.
- Customers need discovery, **vendor comparison**, availability, **alternatives**, checkout, payment, delivery, returns and refunds across **potentially multiple sellers in one cart**.
- Merchants need **tenant-isolated** operational visibility, inventory controls, seller-order workflows, settlement visibility, demand visibility and **predictive insights** (including potential stockouts).
- Customer behavior can be converted into analytics and predictive signals.
- Customers increasingly expect **conversational access** through messaging channels.
- Commerce workflows must remain **correct under concurrency, retries, duplicate webhooks, provider timeouts and partial failures**.
- AI responses about live commerce must be **grounded in authoritative backend facts** and must respect customer, merchant and administrator authorization.
- The system must support analytics and ML **without allowing analytical or AI workloads to compromise transactional correctness**.
- The platform must remain **secure, observable, scalable and resilient** as functionality grows.

---

## 3. Project Objectives

1. Build a **complete multi-vendor commerce workflow**: merchant onboarding → catalog → listing → inventory → cart → checkout → payment → seller order → fulfillment → return/refund → settlement (plus post-order lifecycle).
2. Define **explicit bounded contexts, ownership rules, module dependency rules and transactional boundaries** *before* implementation.
3. Design a **normalized, transactionally consistent PostgreSQL** data model with **immutable financial and inventory history**.
4. Implement **secure customer, merchant and administrator access** with tenant isolation and object-level authorization.
5. Provide **search and discovery as derived read models** with authoritative transactional filtering (fast discovery via structured filters and progressively enhanced semantic search).
6. Create a **reliable event platform**: transactional outbox, versioned contracts, idempotent consumers, retries, DLQ, replay (event-driven analytics pipeline).
7. Implement **analytics and ML** with measurable data quality, evaluation, lineage, model versioning and rollback; implement recommendations and predictive use cases with measurable evaluation.
8. Connect **WhatsApp** through a secure webhook and conversation gateway, with policy-controlled LLM tools and deterministic fallbacks. Ensure AI cannot access arbitrary DB operations or fabricate live commerce facts.
9. Demonstrate **production system-design concepts**: caching, queues, idempotency, concurrency, resilience, observability, CI/CD, backup/restore, disaster recovery.
10. Document **architecture trade-offs** and provide a path from an initial modular implementation to independently scalable components.

---

## 4. Users and Actors

| Actor | Responsibilities |
|---|---|
| **Customer** | Browse/search, compare listings, cart, checkout, payment, orders, returns, reviews, preferences, and conversational assistance (web + WhatsApp). |
| **Merchant** | Registration/verification, store management, listings, prices/offers, inventory, seller orders, fulfillment, returns, and merchant analytics. |
| **Administrator** | Merchant approval, catalog governance, moderation, disputes, refunds where authorized, platform configuration, security, audit, and analytics. |
| **AI/Automation** | Interpret requests, retrieve authorized facts, propose or execute **explicitly permitted** tools, generate grounded responses, trigger eligible workflows. |
| **System/Worker** | Process events, notifications, search indexing, analytics ingestion, reconciliation, scheduled jobs and ML pipelines. |

---

## 5. High-Level Product Scope

| Layer | Core capabilities |
|---|---|
| **Core Commerce** | Identity, merchants, catalog, variants/SKUs, listings, inventory, cart, checkout, orders, payments, fulfillment, returns and refunds. |
| **Marketplace** | Seller orders, commissions, seller earnings, settlement eligibility, payouts and financial ledger. |
| **Discovery** | Search, autocomplete, filters, vendor comparison, similar products, progressively enhanced semantic retrieval. |
| **Intelligence** | Analytics, dashboards, recommendations, demand forecasting, stockout prediction, propensity and anomaly detection. |
| **Conversational AI** | WhatsApp webhook, conversation management, intent understanding, policy-controlled tools, RAG where appropriate, grounded responses, alerts. |
| **Platform** | Security, observability, CI/CD, resilience, audit, backup/recovery, configuration and feature flags. |

---

## 6. Complete End-to-End Workflow

```
CUSTOMER / MERCHANT / ADMIN
        │
        ▼
React Web Apps  /  WhatsApp
        │
        ▼
CDN / WAF / API Gateway
        │
        ▼
Authentication + Authorization + Tenant Context
        │
        ▼
Node.js Modular Monolith
┌──────────────────────────────────────────────────────────────┐
│ Identity  Merchant  Catalog  Inventory  Commerce             │
│ Cart  Checkout  Order  Payment  Fulfillment  Returns         │
│ Promotion  Search  Notification  Customer  Admin  AI         │
└──────────────────────────────────────────────────────────────┘
        │
        ▼
PostgreSQL — Transactional Truth
        │
        ▼
Transactional Outbox
        │
        ▼
Event Bus / Queue
┌──────────────────────────────────────────────────────────────┐
│ Search  Analytics  Notifications  Reconciliation             │
│ ML/Features  Integrations  Background Workers                │
└──────────────────────────────────────────────────────────────┘
        │
        ▼
AI Orchestrator
Policy → Authorization → Tool Validation → Authorized Commerce API
        │
        ▼
Grounded Response / Action
```

**Service extraction is not assumed.** The initial implementation is a modular monolith with strict module boundaries. Independent services are an **evolution option, not a default deployment requirement**.

*(The original proposal's diagram showed: Node.js Backend → Catalog / Search / Inventory / Cart / Orders → PostgreSQL → Transactional Outbox → Event Bus → Analytics / ML / Notifications → Dashboards / Predictions / WhatsApp → Recommendation/Forecast → AI Orchestrator (LLM + RAG + Tools) → Authorized Commerce APIs. The corrected diagram above supersedes it.)*

---

## 7. Customer Workflow

### 7.1 Registration and discovery
Customer → Register/Login → Session → Home/Categories/Search → **search read model** → filters + **authorization-aware availability** + ranking → product/listing results.

### 7.2 Product selection
Canonical Product → Variant/SKU → Eligible Merchant Listings → compare price/stock/fulfillment → select listing → add to cart → **server-side cart validation**.

### 7.3 Checkout
```
Cart
 → Checkout Session
 → re-price / tax / shipping validation
 → promotion validation
 → inventory reservation
 → seller-order allocation
 → payment intent
 → payment provider
 → verified webhook
 → order confirmation
 → reservation allocation/commit
 → fulfillment
 → notification
```
**Failure handling is explicit:**
- Payment failure → **releases reservations**.
- Payment success with order-creation uncertainty → enters **reconciliation** (never charges again).
- Expired checkout sessions → **release reservations**.
- All transitions are **idempotent**.
- Checkout must be idempotent and concurrency-safe. Payment and order state transitions are validated by the backend, **never trusted from the client**.

### 7.4 Order lifecycle
- **Customer Order:** `CREATED → PAYMENT_PENDING → PAID → PARTIALLY_FULFILLED / FULFILLED → COMPLETED`, with `CANCELLED` / `RETURNED` / `REFUNDED` transitions constrained by policy.
- **Seller Orders** independently progress through seller fulfillment states (original doc's simple view: Created → Payment Confirmed → Processing → Packed → Shipped → Delivered → Review/Return/Refund where applicable).

### 7.5 Out-of-stock workflow
Requested listing unavailable
→ check **eligible merchant listings for the same SKU** (same canonical product at other merchants)
→ check **eligible variants**
→ retrieve **similar products** (semantically similar)
→ apply customer/business constraints
→ rank alternatives
→ present options.
**Inventory availability is revalidated before purchase.**

---

## 8. Multi-Vendor Workflow

```
Merchant Registration → Verification → Store → Canonical Product/SKU Mapping
→ Merchant Listing → Price/Offer → Inventory Location/Balance → Publish
→ Customer Discovery → Cart → Checkout → Customer Order → Seller Order Split
→ Seller Fulfillment → Shipment → Delivery → Review/Return → Settlement
```

- A **canonical product is distinct from a merchant listing**. A listing is a **seller-specific offer for a purchasable SKU** and is the **commercial/inventory boundary** for marketplace stock. This lets multiple merchants sell the same product while keeping merchant-specific price, stock, offer and fulfillment information.
- A **single customer order may contain multiple seller orders**. Each **seller order owns**: seller-specific items, fulfillment, shipment, cancellation eligibility, return handling and settlement calculations.

---

## 9. Product and Catalog Model

```
Category
 └── Subcategory
      └── Product                      (canonical identity)
           └── Variant / SKU           (purchasable configuration)
                ├── Merchant Listing A
                ├── Merchant Listing B
                └── Merchant Listing C
```

- **Categories** = taxonomy. **Products** = canonical identity. **Variants/SKUs** = purchasable configurations. **Merchant listings** = seller-specific commercial offers. **Attributes** support filtering and search.
- **Catalog governance** controls duplicates, incomplete/invalid data, moderation and publication state.
- **Listing publication is separate from product approval.** A seller cannot publish an unapproved or commercially invalid listing merely because the canonical product exists.

---

## 10. Inventory Architecture

Inventory is associated with a **sellable merchant listing/SKU** and, where applicable, an **inventory location**.

```
Available = On Hand − Reserved − NonSellable
```
(Original definitions: **On Hand** = physical sellable quantity after stock adjustments; **Reserved** = quantity temporarily held for active checkout/order workflows; **Available** = On Hand − Reserved − other non-sellable quantity; **Incoming** = expected replenishment quantity.)

**Lifecycle / state flow**
```
On Hand → Reserved → Allocated → Picked → Packed → Shipped → Delivered
Reserved → Released
Returned → Inspection → Restocked / Damaged
```
**Explicit inventory states** (where applicable): `AVAILABLE, RESERVED, ALLOCATED, PICKED, PACKED, SHIPPED, DELIVERED, RELEASED, RETURNED, INSPECTION, DAMAGED`.

**Rules**
- Maintain an **immutable inventory movement ledger**.
- Use **DB transactions with row/version locking** (or equivalent **atomic conditional updates**) for reservations.
- **Reservation expiry is mandatory** for abandoned checkout sessions.
- Use **idempotency keys** for reservation and order operations.
- **Redis and LLMs are never inventory truth.**
- **Reconciliation** periodically compares derived balances with authoritative movements and **flags discrepancies without silently overwriting history**.

---

## 11. Database Architecture

| Bounded context | Representative entities |
|---|---|
| **Identity & Access** | users, roles, permissions, user_roles, sessions, refresh_tokens, authentication_events |
| **Merchant** | merchants, stores, merchant_users, verification_records, merchant_settings |
| **Catalog** | categories, products, variants, attributes, brands, catalog_approvals |
| **Marketplace** | merchant_listings, listing_prices, listing_offers, listing_publications |
| **Inventory** | inventory_locations, inventory_balances, inventory_reservations, inventory_movements, stock_adjustments |
| **Cart & Checkout** | carts, cart_items, checkout_sessions, checkout_items, checkout_attempts |
| **Orders** | customer_orders, seller_orders, order_items, order_status_history, seller_order_status_history |
| **Fulfillment** | shipments, shipment_items, carriers, tracking_events, delivery_events |
| **Payment** | payment_intents, payment_attempts, payment_transactions, payment_webhooks, refunds, reconciliation_records |
| **Settlement** | seller_accounts, commission_rules, seller_earnings, settlement_batches, payouts, payout_transactions, financial_ledger |
| **Customer** | addresses, preferences, wishlists, reviews, consents |
| **Promotion & Pricing** | offers, coupons, campaigns, promotion_rules, eligibility, pricing_snapshots, tax_snapshots, shipping_fee_snapshots |
| **Events** | outbox_events, event_consumption, webhook_deliveries, event_replay_records |
| **Search** | index_jobs, index_versions, search_audit where required (the search engine itself remains **derived**) |
| **AI** | conversations, messages, tool_calls, ai_runs, ai_feedback, policy_decisions |
| **ML & Analytics** | features, datasets, model_versions, predictions, candidates, outcomes, fact/dimension stores |
| **Security & Audit** | audit_logs, login_events, security_events, access_decisions |

*(Original, simpler entity list for reference: Identity—users, roles, permissions, user_roles, sessions; Merchant—merchants, stores, merchant_users, verification_records; Catalog—categories, products, variants, attributes, brands; Marketplace—merchant_listings, listing_prices, listing_offers; Inventory—inventory, inventory_movements, reservations, stock_adjustments; Commerce—carts, cart_items, orders, order_items, shipments, returns; Payment—payment_intents, transactions, refunds, reconciliation; Customer—addresses, preferences, wishlists, reviews; Promotion—offers, coupons, campaigns, eligibility; Events—event_log, outbox_events, webhook_deliveries; AI—conversations, messages, tool_calls, ai_runs, ai_feedback; ML—features, model_versions, predictions, candidates, outcomes; Security—audit_logs, login_events, security_events.)*

**Ownership rule:** Inventory truth → Inventory context; payment truth → Payment context; financial settlement truth → Settlement/Ledger context.

---

## 12. Database Engineering Concepts

- Normalization and **controlled denormalization** with explicit ownership.
- Primary/foreign keys, unique/check/not-null constraints, and **state-validating constraints**.
- **Composite, partial, covering and expression indexes** based on *measured* query patterns.
- Transactions and appropriate **isolation levels**; **optimistic versioning** (version columns) and **row locking** for contention points.
- **Immutable** order financial snapshots, inventory movements, payment provider references and audit history (immutable order-price snapshots).
- **Soft deletion** only where historical references must survive; **never use deletion to rewrite financial truth**.
- **Partition** high-volume event/audit tables only after workload evidence.
- Use **read replicas or analytical stores** for reporting rather than burdening OLTP.
- All schema changes use **version-controlled migrations** with tested rollback/forward procedures; tested backup/restore.
- **Tenant keys** are explicit on tenant-scoped data and enforced at application boundaries **and**, where appropriate, **PostgreSQL Row-Level Security (RLS)**.

---

## 13. Transaction and Idempotency Design

| Operation | Protection |
|---|---|
| **Checkout** | Idempotency key + checkout state machine + transactional validation. |
| **Inventory reservation** | Atomic availability check + reservation row + expiry + idempotency. |
| **Payment callback** | Provider signature verification + provider event ID + idempotent state transition. |
| **Webhook** | Verified source + replay protection + durable event/message ID. |
| **Order cancellation** | State-machine validation + compensating inventory/payment actions. |
| **Order creation** | Unique checkout/idempotency reference; **never create a second order for the same successful checkout**. |
| **Settlement** | Immutable ledger entries + settlement batch idempotency + provider reference. |
| **Event publishing** | Transactional outbox; publish after commit; consumers remain idempotent. |

---

## 14. Search and Discovery

```
Customer Query → query understanding → lexical retrieval + semantic retrieval
→ candidate merge → authoritative filters → availability/business rules
→ ranking → results → search event
```

- **PostgreSQL remains authoritative** for product/listing state. Search engines are **derived read models** updated from committed changes/events. **Index lag must not be treated as license to report stale transactional stock or price.**
- **Begin with PostgreSQL search** where appropriate. Introduce **OpenSearch/Elasticsearch** only when measured relevance, scale or latency requires it.
- Progressively support: **autocomplete, typo tolerance, synonyms, facets, semantic retrieval** (embeddings for semantic similarity while retaining authoritative transactional filtering).
- Use **zero-result searches** as catalog/product-discovery signals.
- **Indexing pipeline:** Listing/Product Changed → outbox event → index job → versioned document → search engine. **Failed indexing retries and enters a DLQ; reindexing is replayable.**

---

## 15. Recommendation Architecture

```
Behavior/catalog data → candidate generation → hard eligibility filters
→ ranking → diversity/business rules → recommendation
→ impression / click / cart / purchase / ignore
→ feedback dataset → evaluation → next model version
```

**Candidate sources:** same-SKU alternatives (same product from another merchant), similar products/variants, frequently bought together, popularity, personalized history/ranking, trending products, price-sensitive alternatives, wishlist/recently-viewed items.

**Eligibility** must exclude unavailable, unauthorized, unpublished, restricted or otherwise invalid listings **before ranking**. Recommendation is **never allowed to bypass inventory or commerce authorization.**

---

## 16. Predictive Analytics

| Use case | Input signals | Output/action |
|---|---|---|
| Demand forecasting | Historical sales, seasonality, price, promotion, availability | Forecast → replenishment planning |
| Stockout prediction | Inventory, reservations, sales/reservation velocity, forecast | Risk/time-to-stockout → alert |
| Purchase propensity | Search, views, cart, purchase history | Intent score → personalization |
| Customer inactivity | Purchase intervals, engagement | Risk segment → eligible retention workflow |
| Offer response | Price/discount and historical response | Expected response → promotion analysis |
| Trend detection | Search/view/purchase velocity | Trend signal → merchant insight |
| Anomaly detection | Orders, payments, inventory and operational metrics | Anomaly score → review/alert |

---

## 17. Predictive Customer Engagement Workflow

```
Customer searches/views product → behavior event → feature generation
→ propensity/recommendation model → notification eligibility
→ consent + channel rules + frequency cap + quiet period + business rules
→ WhatsApp / email / push template
→ delivery / click / purchase outcome → analytics/ML feedback
```
- **A search event alone must not automatically trigger a message.**
- Every outbound workflow must verify: **consent, channel eligibility, suppression rules, frequency caps, quiet periods, business purpose, and provider requirements.**

---

## 18. Analytics Architecture

```
Web/API/Merchant/WhatsApp events → event validation → durable event stream
→ analytical ingestion → facts + dimensions → dashboards and governed feature datasets
→ feature engineering → ML training/evaluation
```
- **Example facts:** `fact_orders, fact_order_items, fact_product_views, fact_searches, fact_cart_events, fact_payments, fact_inventory_movements, fact_recommendation_impressions`.
- **Example dimensions:** `dim_customer, dim_product, dim_variant, dim_merchant, dim_category, dim_date, dim_location`.
- **Separate OLTP from heavy analytics.** Use an analytical store/warehouse where justified.
- Track **freshness, completeness, uniqueness, validity, consistency and lineage**.
- **Version event schemas**; maintain **source-to-feature lineage** for critical ML inputs.
- Create business **dashboards** for customer, merchant and administrator views.

---

## 19. LLM + WhatsApp Architecture

```
WhatsApp Provider → verified webhook → message normalization
→ tenant/channel resolution → authenticated conversation context
→ policy and intent layer → LLM → tool policy/authorization
→ argument validation → authorized backend tool → authoritative result
→ result validation → LLM response → output guardrails
→ WhatsApp response → delivery/outcome event
```

- **Selected transactional backend remains Node.js + PostgreSQL. MongoDB is NOT part of the chosen platform architecture.** Any WhatsApp reference implementation must use the **same transactional source of truth** rather than a competing order/catalog database.
- **WhatsApp is a channel adapter.** Redis may hold short-lived ephemeral conversation state; **durable conversations, messages, tool calls, audit info and commerce references are persisted in PostgreSQL** per retention policy.

> Detailed Meta/WhatsApp platform constraints, flow-engine model, UPI workflow, field guide and go-live checklist from the original reference implementation are preserved in **Appendix A**.

### 19.1 WhatsApp Business Platform Fundamentals
- WhatsApp Business Account (WABA) and phone number **identify the channel tenant**.
- **Webhook** receives inbound messages, interactive selections, and delivery/status events.
- **Catalog data is served from the authoritative commerce backend; chat is not a second catalog.**
- Flow/conversation state is **tenant-scoped** and persisted appropriately.
- **Orders are immutable commercial snapshots linked to the transactional order system.**
- Provider constraints (message formats, template requirements, delivery windows, payload limits) are **configuration/adapter concerns** and must not leak into core domain logic.

### 19.2 Channel Payload and Interaction Rules
- Interactive controls use **stable IDs, not merchant-editable display labels**.
- Lists and buttons are **paginated and validated against provider constraints** before sending.
- **Every interactive path has a text fallback** and an explicit error/recovery message.
- Outbound messages **outside provider-defined customer-care windows use approved templates** where required.
- Media uses provider-reachable URLs or approved media upload flows; inaccessible media **falls back safely to text**.
- **Provider webhook verification, replay protection and durable event IDs are mandatory.**

### 19.3 Catalog Data Model for Conversational Commerce
- Chat reads **canonical categories/products and eligible merchant listings through backend APIs**.
- **Price and stock shown in conversation are fetched from current authorized commerce tools**; cached values are labeled/validated per freshness policy.
- Portion/variant choices **map to real SKU/listing identifiers**.
- Conversation product availability is **not a substitute for checkout-time inventory reservation**.

### 19.4 Conversational Commerce Flow
- **Browse → Product → Variant/Listing → Cart → Checkout Session → payment/order workflow.**
- Empty results, unavailable products, invalid inputs and failed dependencies produce **recoverable responses, not dead ends**.
- Global commands (**STATUS, HELP, CANCEL**) are intercepted by a **controlled command layer**; **authorization is rechecked before action**.

### 19.5 Payments over WhatsApp
- Where a gateway is not yet integrated, a **UPI intent link may be used only as an explicitly lower-assurance/manual verification workflow**. The chat layer **does not move money** and **does not mark payment successful merely because the customer says it was paid**.
- For production automated payments, the **provider callback/webhook is the source of payment confirmation** after **signature verification, event deduplication and state validation**.
- Manual verification is a **transitional operating mode**, not the definition of payment truth.

### 19.6 Order Lifecycle in Chat Commerce
- Chat references the **core Customer Order / Seller Order model**. It does **not** create an independent order schema that can diverge from web checkout.
- **Payment and order status are separate state machines.** Customer-visible status is **derived from authoritative states and permission-filtered data**.

### 19.7 Inventory Model
- A lightweight availability flag may exist only as a **presentation optimization**. Production checkout uses **authoritative listing/SKU inventory balances and atomic reservations**. A boolean cannot guarantee stock correctness under concurrency.
- All stock-affecting operations use the **inventory bounded context and ledger**.

### 19.8 Multi-Tenancy, Sessions and Webhook Reliability
- Resolve tenant from **verified channel identity**; carry tenant context through **every** application/repository operation.
- **Reject / fail closed** on missing tenant context for tenant-scoped operations.
- Redis may hold short-lived session state, but **durable message/event IDs and important conversation records survive restarts**.
- **Duplicate inbound deliveries are deduplicated by durable provider message/event ID.**
- **Delivery/read status events update message telemetry only and never trigger conversational business actions.**

### 19.9 Operational Field Guide and Go-Live Checklist
- Webhook subscribed; signature/verification checks tested against the live endpoint.
- Secrets/tokens stored outside source control and rotated per policy.
- Interactive payloads validated against provider constraints and paginated.
- Merchant settings, payment configuration, serviceability, templates and notification preferences complete.
- Payment, order, inventory and notification **failure paths tested end-to-end**.
- Support and escalation paths exist inside the channel.
- Provider outage, duplicate delivery, stale session and webhook replay tests have passed.

### 19.10 Example
Customer: *"Is iPhone 15 available under my budget?"*
→ LLM identifies intent/constraints
→ `search_products(query, filters)`
→ backend retrieves **eligible listings**
→ inventory/price validation
→ LLM explains current options
→ **grounded response**.

### 19.11 Tool Examples
- `search_products(query, filters)`
- `get_product(product_id)`
- `compare_vendor_listings(product_id)`
- `check_inventory(listing_id)`
- `find_similar_products(product_id, constraints)`
- `get_order(order_id)`
- `subscribe_alert(customer_id, product_id, alert_type)`

---

## 20. LLM Security and Guardrails

- **Never** provide arbitrary SQL, arbitrary DB access, filesystem access or unrestricted internal APIs to the LLM.
- **Every tool enforces authentication, tenant authorization, object-level authorization and schema validation independently of model output.** Limit tool permissions to the minimum necessary operation.
- Introduce a **tool policy layer** between model selection and execution.
- Classify tools as **read-only, reversible, sensitive/destructive**. Sensitive actions need stronger authorization and **explicit confirmation** where appropriate.
- Validate tool arguments, enforce **allowlists**, and **validate tool results** before generation.
- Protect against **prompt injection** and instruction conflicts; prevent cross-customer and cross-merchant data leakage.
- **Never infer authorization from conversation text alone.**
- **Do not allow the model to invent** price, stock, payment, settlement or order state. Backend tools are the source of truth for live facts.
- Log tool calls/outcomes for audit and evaluation while **minimizing sensitive data retention**.
- Provide **deterministic fallback** when the LLM or model provider is unavailable.

```
AI TOOL EXECUTION
LLM proposal → Tool Policy → Authentication → Tenant/Object Authorization
→ Argument Validation → Backend Tool → Authoritative Result
→ Result Validation → LLM / Deterministic Response
```

---

## 21. RAG Architecture

```
Question → classify: live transactional request vs knowledge request

Knowledge request → approved documents → parse/chunk → metadata/effective dates
                  → embedding/index → retrieval → reranking → source-aware generation
Live commerce request → authorized backend tool → authoritative result
Mixed request → policy-controlled document retrieval + live commerce tool → grounded response
```
- **Vector retrieval never becomes the authoritative source** for current price, inventory, payment, order status, settlement or other mutable transactional facts.
- Version documents; track source identifiers and **effective dates**.
- Protect documents and retrieval against **prompt injection**.
- Measure **retrieval quality separately from generation quality**.
- Store citations/source references where UX and governance require.

---

## 22. Security Architecture

| Security domain | Controls |
|---|---|
| **Authentication** | Secure password hashing, secure sessions/tokens, refresh rotation, **MFA for privileged roles**, OTP where appropriate, session revocation. |
| **Authorization** | RBAC + **object-level authorization**, tenant context, seller/customer ownership checks, **deny-by-default**. |
| **Tenant isolation** | Application-layer enforcement + database **RLS** defense in depth where appropriate. |
| **API security** | Validation, rate limits, timeouts, pagination/request-size limits, idempotency, standardized errors. |
| **Web security** | CSP, XSS protections, secure cookies, CSRF where applicable, secure headers. |
| **Database** | Parameterized queries, least privilege, TLS, restricted network access, encrypted backups, controlled migrations. |
| **Webhook** | Signature verification, timestamp/replay protection, provider event ID deduplication, payload validation. |
| **Payment** | Provider-hosted/tokenized payment where appropriate; minimize sensitive payment data storage. |
| **AI** | Tool authorization, prompt-injection defenses, output validation, data minimization, tenant isolation. |
| **Secrets** | Secret manager, rotation, short-lived credentials where possible; **no secrets in repo or logs**. |
| **Audit** | Privileged actions, access decisions, configuration changes, payment/admin interventions, security events. |
| **Privacy** | Consent, preferences, retention, access/deletion processes, purpose limitation as applicable. |

---

## 23. Threat Model

Threats to cover:
- Broken access control / **IDOR / BOLA**.
- **Merchant-to-merchant data leakage**.
- SQL injection and malicious input.
- Credential stuffing, token theft and session abuse.
- **Webhook spoofing, replay and duplicate delivery**.
- **Inventory race conditions and overselling**.
- Coupon, promotion, refund and settlement abuse.
- Order/payment tampering and reconciliation errors.
- Malicious file upload.
- **Prompt injection, tool abuse and unauthorized AI actions**.
- Sensitive information leakage through logs, prompts or analytics.
- Denial-of-service and **AI-cost abuse**.
- Third-party/provider and dependency/supply-chain vulnerabilities.
- **Financial ledger inconsistency or duplicate settlement**.

Threat modelling maps **assets, trust boundaries, attack paths, mitigations and verification tests**. Security controls are accepted **only after automated/manual verification**, not merely because they appear in the architecture document.

---

## 24. Event-Driven Architecture

**Event naming convention:** single versioned format, e.g. `commerce.order.created.v1`. **Producers own event contracts; consumers validate versions and must remain idempotent.**

| Event | Typical consumers |
|---|---|
| `commerce.order.created.v1` | Inventory, fulfillment, analytics, notification, seller-order workflows |
| `commerce.payment.confirmed.v1` | Order confirmation, fulfillment, notification, analytics |
| `inventory.stock.updated.v1` | Search indexing, alerts, analytics, recommendations |
| `inventory.stock.low.v1` | Merchant alerts, forecasting, replenishment workflows |
| `catalog.listing.changed.v1` | Search indexing, recommendation candidates, analytics |
| `commerce.cart.item_added.v1` | Analytics, eligible abandonment workflows |
| `customer.product.viewed.v1` | Analytics, recommendation candidates |
| `commerce.return.requested.v1` | Returns workflow, seller operations, analytics |
| `settlement.earning.created.v1` | Settlement, merchant analytics, finance |
| `whatsapp.message.received.v1` | Conversation/AI channel |
| `ml.prediction.created.v1` | Analytics, dashboards, eligible business workflows |

**Standard event envelope:** `event_id, event_type, event_version, occurred_at, producer, tenant_id, actor_id (where applicable), aggregate_type, aggregate_id, correlation_id, causation_id, schema_version, payload`.

*(Original, legacy flat event names — superseded by the versioned convention above: SEARCH_PERFORMED, PRODUCT_VIEWED, CART_ITEM_ADDED, ORDER_CREATED, PAYMENT_CONFIRMED, INVENTORY_UPDATED, STOCK_LOW, PRODUCT_OUT_OF_STOCK, PRICE_CHANGED, WHATSAPP_MESSAGE_RECEIVED, MODEL_PREDICTION_CREATED. Search-performed, product-out-of-stock and price-changed events should be given proper versioned names following the same convention when defined.)*

---

## 25. Event Reliability

- **Transactional outbox** connects committed DB state to event publication.
- **At-least-once delivery** is assumed; **exactly-once business effects** come from idempotent consumers and unique business references.
- Retries use **exponential backoff and bounded attempts**.
- **Dead-letter queues** capture poison messages with reason metadata.
- **Event schema versioning** prevents silent contract breakage.
- **Correlation and causation IDs** support distributed tracing and workflow reconstruction.
- Monitor **consumer lag, retry counts, DLQ depth**.
- **Replay** supported from durable event records where business semantics permit.
- **Event consumers must not mutate source-of-truth facts without passing through the owning bounded context.**

---

## 26. Caching and Performance

- **Redis** for cache, rate limiting and selected ephemeral session state — **never** authoritative inventory/payment/order truth.
- **Cache-aside** with explicit TTL, invalidation and stale-read policy.
- Prevent **cache stampedes** with jitter/locking where justified.
- **CDN/object storage** for media.
- Measure hit ratio, stale-read tolerance, eviction behavior, dependency latency.
- Use **query plans and measured workload evidence** before adding indexes or caches.
- Define **performance budgets** for API, checkout, search and AI tools.
- **Do not optimize by weakening correctness of transactional state.**

---

## 27. Failure and Recovery Workflows

| Failure | Expected behavior |
|---|---|
| LLM unavailable | Fallback to deterministic search/order workflows or a safe unavailable response. |
| ML recommendation unavailable | Popularity/category/content fallback. |
| Search index stale | Use transactional backend for critical validation; communicate/handle stale discovery safely. |
| Queue consumer failure | Retry → DLQ → alert → operator/replay. |
| Payment timeout | Persist attempt, reconcile by provider reference, **do not duplicate charge/order**. |
| Payment success but order uncertain | Enter reconciliation workflow; **do not create a second charge**. |
| Inventory conflict | Atomic rejection/adjustment; **never confirm unavailable quantity**. |
| External API slow | Timeout + circuit breaker + fallback. |
| WhatsApp provider outage | Queue eligible notifications/retries and expose delivery status. |
| Bad model release | Evaluation gate + model version rollback. |
| Database outage | Fail safely for writes; use HA/backup/restore strategy. |
| Settlement provider failure | Preserve ledger state; retry payout **without duplicating financial entries**. |

---

## 28. Distributed-System Concepts

- Timeouts and retries with **bounded retry budgets**.
- **Circuit breakers and bulkheads** for external dependencies.
- Rate limiting and **backpressure**.
- **Idempotency and deduplication**.
- **Transactional outbox**.
- **Saga / compensating actions** for multi-step workflows.
- **Eventual consistency only where explicitly accepted by the owning domain.**
- Distributed tracing.
- Graceful degradation.
- **Reconciliation jobs** for financial, inventory and integration boundaries.

---

## 29. ML and Deep Learning Strategy

| Problem | Baseline | Advanced |
|---|---|---|
| Demand forecast | Moving average / exponential smoothing | Gradient boosting or neural time-series where justified |
| Purchase propensity | Logistic/tree model | Sequence/deep model where justified |
| Recommendation | Popularity / collaborative filtering | Two-tower retrieval / neural ranking |
| Product similarity | Structured attributes/rules | Transformer embeddings |
| Intent classification | Rules/classifier | Transformer/LLM |
| Catalog understanding | Structured metadata | Multimodal/vision embeddings if needed |

**Baseline-first engineering:** a complex model is promoted **only** when offline and, where safe, online evaluation demonstrates **meaningful improvement against a simpler baseline**.

**MLOps lifecycle:** dataset version → feature generation → training → evaluation → model registry → approval → deployment → monitoring → drift detection → retraining/rollback.

---

## 30. AI/ML Evaluation

| Component | Example metrics |
|---|---|
| Intent | Accuracy, precision, recall, F1 |
| Tool calling | Valid-tool rate, argument correctness, **authorization rejection rate**, execution success |
| Grounding | Supported-answer rate, source correctness, hallucination/error rate |
| Recommendations | CTR, add-to-cart, conversion, coverage, diversity |
| Forecasting | MAE, RMSE, WAPE (or context-appropriate) |
| Classification/prediction | Precision, recall, ROC-AUC/PR-AUC, calibration |
| Operations | Latency, cost, error, escalation and fallback rate |
| ML operations | Drift, data freshness, feature quality, model version health |

- **Version** models, prompts, retrieval configuration and datasets.
- Maintain an **evaluation suite before changing production AI behavior**.
- **Human review** for ambiguous/high-impact cases.
- Monitor feature/model drift and prediction quality over time.
- **Do not compare models on a different population/time period without explicitly documenting the difference.**

---

## 31. Observability and SRE

| Signal | Examples |
|---|---|
| Metrics | RPS, p95/p99 latency, error rate, DB latency, queue lag, cache hit rate, reservation conflicts, payment success rate |
| Logs | Structured logs with `request_id, trace_id, correlation_id, tenant_id, actor_id, event_id`; **sensitive-data redaction** |
| Traces | API → module → database → queue → provider → AI tool |
| Business telemetry | Conversion, stockout, order success, payment reconciliation, seller fulfillment, recommendation outcomes |
| AI telemetry | Intent, tool success, grounding, latency, fallback, token/cost usage |
| Alerts | Availability, latency, error spikes, queue backlog, payment/reconciliation anomalies, security anomalies |

- Define **SLIs/SLOs** for critical APIs, checkout, payment callbacks, search, notification delivery.
- Health/readiness checks and **operational runbooks**.
- **Backup restore drills.**
- **Business-approved RTO/RPO targets must be defined before production launch — do not invent values without owner approval.**
- Feature flags and controlled rollback.

---

## 32. DevOps and CI/CD

```
Developer → Pull Request → lint/typecheck → unit tests → integration tests
→ SAST → dependency scan → secret scan → container scan → build → staging
→ smoke / E2E / DAST as applicable → approval → production
→ monitor release health → rollback if required
```
- Containerized builds and **reproducible artifacts**.
- Secrets outside source control.
- **Versioned DB migrations.**
- Infrastructure as code where appropriate.
- Release traceability and rollback procedures.
- **Production promotion is gated** by automated quality/security checks and explicit environment configuration validation.

---

## 33. Testing Strategy

| Layer | Examples |
|---|---|
| Unit | Pricing, tax abstraction, promotion rules, validation, state transitions, domain rules, inventory calculations |
| Integration | PostgreSQL repositories, transactions, outbox, queues, payment adapters, search indexing |
| API | Authentication, authorization, tenant isolation, pagination, idempotency, standardized errors |
| E2E | Search → listing → cart → checkout → payment → customer order → seller order → fulfillment |
| Concurrency | Simultaneous reservation/checkout, duplicate payment callbacks, duplicate webhook delivery |
| Security | IDOR/BOLA, injection, auth abuse, webhook replay, prompt injection, tenant leakage |
| Performance | Load, stress, soak, queue backlog, dependency latency |
| AI | Intent, tool selection, authorization rejection, grounding, prompt injection, fallback |
| ML | Offline evaluation, drift, calibration, feature quality, rollback |
| Resilience | Dependency failures, retries, circuit breakers, queue outages, DB failover and recovery |

---

## 34. System Design Trade-offs

| Decision | Trade-off to document |
|---|---|
| Modular monolith vs microservices | Simplicity/operability vs independent scaling/deployment. **Initial default: modular monolith.** |
| PostgreSQL vs additional datastore | Strong transactional model vs specialized access patterns |
| Redis | Latency and scale vs consistency/staleness complexity |
| Search engine | Relevance/scale vs operational complexity; **derived read model only** |
| Real-time vs batch ML | Freshness vs cost/complexity |
| RAG vs fine-tuning | Knowledge freshness vs training/maintenance cost |
| LLM provider/model | Quality vs latency, cost, privacy, provider dependency |
| Deep model vs baseline | Complexity vs measured improvement |
| Strong vs eventual consistency | Correctness vs availability/throughput, per explicit domain |
| Build vs managed service | Control vs engineering/operational effort |
| Manual vs automated payment verification | Operational simplicity vs assurance/scale; **manual is transitional** |
| Ledger vs mutable balance | Auditability/reconciliation vs simplicity; **immutable ledger is authoritative for financial history** |

Architecture decisions are recorded as **ADRs**: context, options, decision, consequences, rejected alternatives, rollback/exit criteria.

---

## 35. Technology Stack and Responsibility

| Technology | Role |
|---|---|
| **React.js** | Customer, merchant and admin web interfaces |
| **Node.js** | Backend APIs, bounded-context application/domain logic, integrations |
| **PostgreSQL** | Transactional source of truth; durable domain/audit records |
| **Redis** | Cache, rate limiting, selected ephemeral session state |
| **Queue/Event Bus** | Async event processing, workers, integration decoupling |
| **Search Engine (as needed)** | High-scale/faceted/semantic discovery — derived read model |
| **Object Storage/CDN** | Product/media assets and distribution |
| **LLM** | NL understanding and response generation behind policy/tool boundaries |
| **Embeddings/vector retrieval** | Semantic similarity and RAG **only** |
| **ML/DL stack** | Forecasting, ranking, prediction, anomaly detection with MLOps controls |
| **Docker/CI-CD** | Reproducible builds, deployment, release controls |
| **Observability stack** | Metrics, logs, traces, alerts, business telemetry |

---

## 36. Why This Architecture Is Production-Oriented

- Business-critical facts remain in authoritative transactional systems.
- Asynchronous workloads do not block core checkout unnecessarily.
- AI is replaceable and cannot own business truth.
- Search and analytics evolve independently as derived systems.
- ML models are versioned and evaluated rather than treated as opaque logic.
- Marketplace financial flows have explicit seller-order and settlement boundaries.
- Failures have explicit fallback, reconciliation or compensation behavior.
- Security is enforced at authentication, authorization, tenant, tool and data boundaries.
- Observability covers technical **and** business health.
- The architecture can start as a modular monolith and evolve where justified.

---

## 37. Implementation Roadmap

| Phase | Scope | Exit condition |
|---|---|---|
| **1 — Architecture & Repository Foundation** | Monorepo/module conventions, environments, CI, coding standards, ADR process, base observability and configuration | Build/test pipeline works; module dependency rules enforced |
| **2 — Identity & Merchant** | Authentication, sessions, RBAC, tenant context, merchant onboarding and verification | Authorization/tenant tests pass |
| **3 — Catalog & Listings** | Categories, products, variants, canonical identity, merchant listings, media, publication | Catalog/listing invariants enforced |
| **4 — Inventory** | Locations, balances, ledger, reservations, concurrency, reconciliation | Concurrent reservation tests cannot oversell |
| **5 — Cart & Checkout** | Cart, checkout session, pricing/promotion/tax/shipping abstraction, idempotency | Checkout state machine and failure compensation pass |
| **6 — Orders & Payments** | Customer/seller orders, payment intents/attempts/transactions, webhooks, refunds, reconciliation | Payment/order reconciliation is idempotent |
| **7 — Fulfillment & Returns** | Shipments, tracking, delivery, return workflow, refund linkage | Partial seller fulfillment/returns work |
| **8 — Marketplace Finance** | Commission, seller earnings, financial ledger, settlement eligibility, payouts | Settlement is auditable and idempotent |
| **9 — Search** | Indexing, filters, autocomplete, relevance, derived read model | Search rebuild/replay works |
| **10 — Events & Notifications** | Outbox, event bus, workers, DLQ, replay, notification module and templates | Event reliability/observability tests pass |
| **11 — Analytics** | Facts, dimensions, ingestion, quality checks, dashboards | Data freshness/quality monitored |
| **12 — Recommendations** | Candidate generation, eligibility, ranking, feedback, evaluation | Baseline measurable and reproducible |
| **13 — Predictive ML** | Forecasting, stockout, propensity, anomaly detection, MLOps | Models versioned/evaluated/rollback-capable |
| **14 — WhatsApp AI** | Verified webhook, conversation gateway, policy, tools, LLM, RAG, guardrails | AI cannot bypass authorization; live facts grounded |
| **15 — Security & Production Hardening** | Threat model, security tests, load/resilience tests, observability, backup/restore, DR | Release gates and recovery drills pass |
| **16 — Advanced Intelligence** | Semantic search, advanced ranking, deep learning, model monitoring where justified | Advanced capability demonstrates measurable benefit |
| **17 — Controlled Service Extraction** | Extract only modules with proven scaling/ownership/deployment need | ADR, contract tests, observability and rollback exist per extraction |

*(Original 14-phase roadmap, superseded: 1 Foundation; 2 Identity & Merchant; 3 Catalog; 4 Inventory; 5 Commerce (cart, checkout, payments, orders, returns); 6 Search; 7 Events; 8 Analytics; 9 Recommendations; 10 Predictive ML; 11 WhatsApp AI; 12 Security hardening; 13 Production hardening; 14 Advanced intelligence. The corrected roadmap splits Commerce into Cart/Checkout, Orders/Payments, Fulfillment/Returns, and Marketplace Finance, and adds Controlled Service Extraction.)*

---

## 38. Proposed Project Deliverables

- PRD and business requirements.
- Complete SRS.
- **Bounded-context and module dependency specification.**
- End-to-end workflow diagrams **and state machines**.
- ER diagram and database design.
- UML use-case, activity, sequence, class, component and deployment diagrams.
- C4 architecture diagrams.
- API/OpenAPI specification **and error/idempotency conventions**.
- Event contracts and event-flow documentation.
- Security architecture, **tenant-isolation model** and threat model.
- **Payment, fulfillment, return/refund and marketplace settlement specifications.**
- AI/LLM tool authorization and RAG specification.
- ML experiment/evaluation and **MLOps** report.
- Test strategy and reports.
- Deployment and CI/CD architecture.
- Observability/SLO documentation.
- Disaster recovery and operational runbooks.
- **ADR set for major architectural decisions.**

---

## 39. Definition of Done

- Core business workflows have **documented state machines**.
- Bounded contexts have **explicit ownership and prohibited direct dependencies**.
- **Database constraints prevent invalid core states.**
- **Concurrent checkout cannot oversell** tested inventory.
- **Retries cannot create duplicate orders, payments, payouts or refunds.**
- External **webhooks are verified, durable and idempotent.**
- Customer orders can **split into seller orders** with independent fulfillment and financial attribution.
- **Seller earnings and settlement are traceable to immutable financial records.**
- **AI cannot execute arbitrary database operations.**
- **Live AI commerce answers are grounded in authorized tool results.**
- Events have **versioned schemas, quality checks and replay strategy.**
- Security threats have **mitigations and automated/manual tests.**
- Logs, metrics and traces provide operational visibility **with sensitive-data redaction.**
- **Backups have been restored successfully in a test.**
- Production deployment supports **safe rollback.**
- **Payment and inventory reconciliation procedures have been tested.**
- Major architecture decisions documented as **ADRs.**
- **Open production decisions are explicitly recorded rather than silently assumed.**
- *(Original also required: recommendations and predictions have measurable evaluation.)*

---

## 40. Final Project Workflow — Manager View

**MERCHANT SIDE**
```
Merchant → Registration/Verification → Store
→ Canonical Product/SKU → Merchant Listing
→ Price/Offer → Inventory Location/Balance → Publish
→ Customer Order → Seller Order → Fulfillment
→ Shipment → Delivery → Returns/Adjustments
→ Earnings → Settlement → Analytics/Predictions
```
**CUSTOMER SIDE**
```
Customer → Login → Search/Browse → Filters/Ranking
→ Product/Variant → Compare Vendors → Cart
→ Checkout Session → Price/Tax/Shipping/Promotion Validation
→ Inventory Reservation → Payment Intent
→ Verified Payment → Customer Order
→ Seller Order(s) → Fulfillment → Review/Return/Refund
```
**INTELLIGENCE SIDE**
```
Customer/Merchant Events → Transactional Outbox
→ Event Bus → Analytics
→ Recommendations / Forecasting / Propensity / Anomaly Detection
→ Business Rules → Personalization / Alerts / Merchant Insights
```
**WHATSAPP AI SIDE**
```
WhatsApp → Verified Webhook → Tenant Resolution
→ Conversation/Intent → Policy
→ LLM Tool Proposal → Authorization → Authorized Backend Tool
→ Live Product/Inventory/Order Data
→ Result Validation → Grounded Response
→ Outcome Event → Analytics/ML Feedback
```
**SECURITY/PLATFORM SIDE**
```
Every layer → Authentication → Authorization → Tenant Isolation
→ Validation → Rate Limiting → Audit → Encryption/Secrets
→ Monitoring → Failure Recovery → Backup/DR
→ Continuous Security Testing
```

---

## 41. Expected Business and Technical Outcomes

- Customers: richer product discovery, **transparent merchant comparison**, conversational assistance.
- Merchants: operational visibility, **seller-order controls, settlement visibility**, predictive inventory insights.
- Administrators: governance, security, platform analytics.
- Organization: **reusable APIs and versioned event contracts** for future integrations.
- Foundation for additional channels, vendors and AI capabilities.
- **Core commerce remains correct and testable even when search, AI, analytics, ML or third-party providers fail.**
- *(Original: the implementation demonstrates practical application of database engineering, system design, cybersecurity, analytics, ML/DL, LLM engineering and product design.)*

---

## 42. Scope Governance

Features are implemented in layers. **The core commerce system must become correct, observable and testable before advanced AI is introduced.** Advanced components are added only after underlying data, event contracts and security boundaries are stable.

| Priority | Scope |
|---|---|
| **Must-have foundation** | Identity, merchant, catalog, listings, inventory, cart, checkout, orders, payments, fulfillment, returns, security, tenant isolation |
| **Marketplace core** | Seller-order splitting, commissions, ledger, settlement, payouts |
| **Core intelligence** | Events, analytics, search, recommendations, merchant dashboards |
| **Advanced intelligence** | Forecasting, propensity, anomaly detection, semantic search |
| **Conversational AI** | WhatsApp, LLM tools, RAG, guardrails, AI evaluation |
| **Production hardening** | Observability, resilience, load testing, DR, security testing, backup/restore, release controls |
| **Future expansion** | Advanced deep learning, multimodal catalog, additional channels — only after measurable business/technical justification |

---

## 43. Conclusion

This is an **integrated commerce and intelligence platform**, not a conventional e-commerce app. It separates transactional truth, asynchronous events, analytics, predictive intelligence and conversational AI with explicit secure interfaces between them.

The corrected architecture adds the boundaries needed for a real multi-vendor system: explicit **bounded contexts, modular-monolith ownership, multi-seller order splitting, inventory and payment state machines, seller settlement, versioned event contracts, tenant isolation, search-as-derived-read-model, AI tool authorization, analytics/ML governance, and operational reconciliation.**

> The objective is **not** to use the maximum number of technologies; it is to use each architectural capability **where it solves a real system problem** while preserving **correctness, auditability, security and operability**.

This document is the **synchronized architecture baseline**. DDL, OpenAPI contracts, event schemas, repo structure, environment configuration, deployment manifests and phase-specific implementation prompts must be generated from it and **must not contradict it**.

---

## 44. Architectural Invariants & Open Production Decisions

### 44.1 Architectural invariants (non-negotiable)

1. PostgreSQL owns transactional commerce facts.
2. Inventory truth → Inventory context; payment truth → Payment context; financial settlement truth → Settlement/Ledger context.
3. **Canonical Product ≠ Merchant Listing.**
4. **Customer Order may contain multiple Seller Orders.**
5. Search, Redis, analytics stores, vector stores and ML predictions are **derived systems**.
6. All external callbacks/webhooks are **authenticated, verified and idempotent**.
7. All tenant-scoped access carries **verified tenant context**.
8. AI **never** receives arbitrary SQL or unrestricted backend access.
9. AI tools **enforce authorization independently of the model**.
10. Sensitive AI actions require explicit policy and confirmation where applicable.
11. Every domain event has a **versioned envelope and stable event ID**.
12. Consumers assume **at-least-once delivery** and implement idempotency.
13. Financial and inventory history is **append-oriented and auditable**.
14. **State transitions are validated by the owning domain**, not by clients or LLMs.
15. Service extraction requires an **ADR** and must preserve API/event/observability contracts.

### 44.2 Open production decisions (do NOT guess — require owner approval)

- Business-approved **RTO/RPO** targets.
- Final **payment provider(s)** and provider-specific production configuration.
- Final **tax jurisdiction/rules** and compliance configuration.
- Production **infrastructure sizing, regions and availability topology**.
- Exact **queue/event-bus product** selection.
- Exact **search-engine product** selection (after measured workload requirements).
- Exact **LLM/embedding providers** (subject to privacy, cost, latency requirements).
- **Commercial settlement timing and seller payout policy.**
- **Retention periods and jurisdiction-specific privacy obligations.**

> These are controlled project decisions, not architectural gaps to be silently guessed by an implementation agent. Once approved, record them as configuration/ADR decisions and reflect them consistently across API, database, infrastructure, testing and operational documents.

---

## Appendix A – WhatsApp Reference Implementation Details (from Original Proposal)

The original proposal grounded §19 in a **production-tested reference implementation** (Node.js + Express, MongoDB, Meta's WhatsApp Business Platform). Treat this appendix as **platform knowledge and operational behavior** the build must handle. **Do NOT adopt MongoDB, boolean-only inventory, a separate chat order store, or self-reported payment as truth** — see Appendix B.

### A.1 The six cooperating parts of a WhatsApp commerce integration
1. **WABA + phone number:** Meta issues a `phone_number_id` per business number; every outbound message is sent to `POST /{phone_number_id}/messages`.
2. **Webhook:** one endpoint receives every incoming text, button tap, list selection and delivery-status update. The number **must be subscribed** to this webhook, or replies are sent into a void and never returned.
3. **Catalog:** categories, subcategories, products held in the database. **The chat is a window into the catalog, not the catalog itself.**
4. **Flow engine:** a **per-organization graph of nodes** (message, buttons, list, product picker, portion picker, cart, checkout) connected by transitions, woken by trigger keywords such as `MENU` or `SHOP`, with session state tracking each phone number's position in the graph.
5. **Order record:** at checkout completion the cart's contents **freeze into an order document** (items, prices, address, totals, payment status). The chat keeps moving; the order is a fixed snapshot — important when prices change mid-conversation.
6. **Merchant dashboard:** human interface for confirming payments, advancing order status, toggling product availability and reading the inbox — the chat is only half of the product.

### A.2 Meta platform constraints (treat as functional requirements)
- **Interactive buttons:** max **3 per message**, **20 characters** per title → portion/quantity choices capped at three, with paging or "more options" for the rest.
- **Interactive lists:** max **10 rows per section**, **24 characters** per row title, **72** per description, **20** for the button label → truncate long names; **paginate large catalogs**.
- Lists render as **body text plus a single button**; the customer must tap it to see rows. A **text fallback** (numbered list answered by typing) must always exist for rejected or un-tapped interactive payloads.
- **24-hour customer-care window:** free-form messages are only permitted within 24 hours of the customer's last message. Anything later (order updates, abandoned-cart nudges) **requires a pre-approved message template**; design and submit template copy well ahead of go-live.
- **Stable identifiers:** the webhook returns the **id** tapped, not its label. Build ids from durable keys (category id, preset index, named constants), **never from merchant-editable display labels**.
- **Product images** must be **public HTTPS URLs Meta's servers can fetch**; expiring signed URLs, localhost addresses and network-restricted hosts **fail silently** and must fall back to a text-only caption.

### A.3 Conversational catalog data model (reference)
- Chat catalog is a **shallow tree**: category → subcategory → product → portion. Rule of thumb: **no single list should present more than ~8 rows**, even though 10 is allowed.
- **Categories** carry: stable id, display name, display order, `is_active` (soft delete — hides from chat immediately without breaking historical orders), recursive subcategories.
- **Products** carry pricing logic, not a flat price:
  - Price stored **per unit** (e.g. per kg); named portions (500g, 1kg, 5kg) are **multipliers**; displayed portion price is **computed at send time, never stored** — one price edit updates every portion.
  - `category_path` array (full leaf path, not just leaf id) disambiguates products when two branches share a leaf name.
  - `allow_custom_quantity` flag + `portion_presets` (**capped at three** per the button limit) drive quantity selection; products without presets fall back to generic quantity buttons rather than failing.
  - `is_available` boolean was the entire inventory signal in the reference build (see A.7 and Appendix B).
- *Corrected-baseline mapping:* portion/variant choices must map to real SKU/listing identifiers, and price/stock come from live authorized backend tools.

### A.4 Conversation flow — five node types, in order
1. **Browse:** shows category list, drills into subcategories, or at a leaf category shows available products. Matching is **case-insensitive** and accepts **either the tapped id or a typed name** (list taps return ids; typed replies return names).
2. **Product:** filters available products by the selected category path, **paginates**, sends as a list; **empty result is a plain message** ("No products currently available") with a next step ("Reply MENU to browse") — not a dead end.
3. **Portion:** sends the product **photo and description first**, then a **second message** with up to three portion buttons and computed prices (two sends read better on a phone than one crowded message).
4. **Cart:** held in **session state** (ephemeral) rather than its own collection in the reference build. Renders a text preview (line items, subtotal) with **Add more items, Checkout, Remove item** actions via stable button ids. *(In the corrected baseline, cart/checkout use the core Cart & Checkout bounded context.)*
5. **Checkout** (most stateful), in order:
   1. Reload an existing in-progress order if one exists.
   2. Collect and validate a **serviceable pincode before collecting the address** (no point gathering an address the store cannot serve).
   3. Calculate subtotal, delivery fee and any promotional offer.
   4. Persist the order.
   5. Generate the payment link.
   6. Send the order summary with a **"Pay via UPI"** action, followed by **"I have paid / Cancel order / View summary"**.

Every dead end and failure (unconfigured payments, uncalculable total, empty cart) must return a message stating **what happened and what to do next** — checkout is where customers are most anxious and likely to abandon.

### A.5 Payments over WhatsApp: UPI intent links + manual verification (transitional only)
- Honest about what is automated: **no code in the chat layer moves money.**
- At checkout the backend builds a **UPI intent URL** (`upi://pay?...`) from the merchant's stored UPI id and the order's **frozen total**, wrapped as a tappable action. The customer's UPI app opens with payee and amount prefilled; payment happens between customer and bank.
- Customer taps **"I have paid"** → order moves to **`VERIFYING`**, visible on the merchant dashboard. The merchant checks their bank notification and confirms/rejects. Merchant confirmation is the **only fraud control at this tier** — fine for small volumes, **doesn't scale to hundreds of orders/day**.
- Because the amount comes from the **frozen order total**, not customer input, a mismatch between expected and claimed amount is visible to the merchant.
- **Documented upgrade path:** a payment gateway with server-side verification, at which point "I have paid" becomes a **verified callback** and `VERIFYING` becomes a system-driven state. *(Corrected baseline: this is the target; the callback/webhook is the payment truth.)*

### A.6 Reference chat order document & states
- **Identity:** human-readable order id, tenant (organization) id, customer phone and name.
- **Fulfilment:** delivery address, delivery pincode, resolved service area.
- **Money:** line items (product, unit, quantity, rate, line total, portion label), subtotal, delivery fee, promotional offer, total payable.
- **State:** `payment_status`: `UNPAID → VERIFYING → PAID`; `order_status`: `RECEIVED → CONFIRMED → PREPARING → OUT_FOR_DELIVERY → DELIVERED`, with `CANCELLED` as the side exit; plus audit trail of the UPI id used and timestamps.
- Status advances from the dashboard, each optionally notifying the customer over chat.
- **Self-service keywords:** `STATUS`, `HISTORY`, `CANCEL`, `PAID`. These **must be intercepted before normal flow-node matching** (so e.g. `CANCEL` works mid-browse and is never swallowed by a product-name matcher). Any new global keyword belongs in that same early interception layer and **must be tested from every step of the flow**, not only the start.
- *(Corrected baseline: chat references the core Customer Order/Seller Order model; payment and order status are separate state machines; do not create a divergent chat order schema.)*

### A.7 Inventory: availability vs. stock (reference note)
- The lightweight build used a single `is_available` boolean toggled by the merchant and filtered from every query/listing — sufficient for a small store since the chat never shows what cannot be bought.
- **Explicit boundary:** nothing prevents two customers from ordering the last unit simultaneously, and nothing warns at a low-stock threshold.
- Where real counts are required: add `stock_quantity` and `low_stock_threshold`, **decrement atomically at order creation with a guard clause** (conditional update succeeding only while `stock_quantity >= requested quantity`), flip `is_available` off at zero, surface low-stock in the dashboard. **The atomic guard is what prevents overselling; without it a decrement is decorative, not load-bearing** — describe this accurately to stakeholders.
- *(Corrected baseline: always use the Inventory context — balances, ledger, atomic reservations with expiry.)*

### A.8 Multi-tenancy, sessions, webhook reliability (reference behavior)
- **Multi-tenancy:** one backend serves many merchants. Every incoming message resolves to an organization (by WABA id, phone number id, or channel-specific id) and **every query must carry that tenant id**; a query without it is a **defect until proven otherwise** (failure mode = cross-merchant leakage).
- **Sessions:** per-phone, per-organization state tracks active flow, current node, collected variables and cart; **expires on timeout** so abandoned carts don't resurface days later. When a merchant edits a live flow, **stale sessions for that flow must be purged**.
- **Duplicate deliveries:** Meta retries webhook delivery. Reference approach: fast in-memory set of processed message ids **plus** a durable DB check (memory first, DB backstop across restarts). *(Corrected baseline: dedupe by durable provider message/event ID.)*
- **Statuses vs. messages:** delivery receipts (sent, delivered, read) arrive on the same webhook in a different shape; they **only update stored message state and dashboard indicators — never trigger conversational automation.**

### A.9 Operational field guide — common failure patterns
- **Tapped button appears to do nothing:** usually the customer didn't notice the button under body text; confirm from send logs whether the list was accepted; check for rejected payload (row count, title length, empty section) before assuming client-side issues.
- **Same reply arrives twice:** duplicate webhook delivery racing dedup logic, typically around deployment/restart; check if message id appears twice in logs.
- **Typed category/product name ignored:** matching should be case/whitespace-tolerant but can't fix spelling; often a product decision (add keyword aliases or steer to tapping).
- **Product photo never arrives but caption does:** image URL unreachable from Meta's servers or media upload failed; text fallback correctly took over; verify the URL from an **external network**, not only an office connection.
- **Checkout loops on pincode step:** check whether the merchant's serviceable-pincode list is **unset (unrestricted)** vs **populated but missing the customer's area** — mostly data configuration, not logic.
- **Customer reports paying but merchant dashboard shows nothing:** order is correctly in `VERIFYING` awaiting merchant confirmation; a merchant-training gap, not a defect; the **pending-payments queue should be impossible for the merchant to miss**.
- **Notification template rejected:** usually inconsistent variable placement or marketing-style copy under a utility category; write the template exactly as it will read with sample values filled in; submit well ahead (approval isn't instant).

### A.10 Go-live checklist (reference)
- Webhook subscribed on the live number with verify token set, **tested against the deployed URL with a real phone**, not only the API console.
- Access token is a **long-lived system-user token** stored outside source control, with a **known, monitored expiry**.
- Every catalog level within **row and character limits on a real device**; product lists paginated; nothing relies on the technical maximum being the practical maximum.
- Store settings complete — merchant name, UPI id (**tested with a nominal amount**), delivery rules, serviceable pincodes — a missing UPI id must produce a **clear error**, not a broken payment link.
- **Templates for messages outside the 24-hour window** (at minimum order-status updates) are pre-approved.
- **Merchants trained and shadowed through several real orders** on confirming payments, advancing status, toggling availability, working the inbox.
- **Support path inside the chat** (a `HELP` keyword or support number surfaced in checkout errors).

---

## Appendix B – Original vs. Corrected: What Changed

| Area | Original proposal | Corrected baseline (authoritative) |
|---|---|---|
| Architecture style | Modular monolith mentioned as a start | Modular monolith with **explicit bounded contexts, ownership rules, module dependency rules**; extraction only via ADR |
| Orders | Single order lifecycle | **Customer Order → multiple Seller Orders**, separate state machines, partial cancel/return/refund |
| Marketplace finance | Not covered in detail | **Settlement context**: commissions, seller earnings, settlement batches, payouts, immutable **financial ledger** |
| Payment | Payment intents/transactions/refunds | Separate **Payment bounded context** with intents, attempts, provider transactions, webhooks, refunds, **reconciliation**; client/chat never confirms payment |
| Inventory | On Hand/Reserved/Available/Incoming | Adds explicit states (ALLOCATED, PICKED, PACKED, SHIPPED, …, INSPECTION, DAMAGED), locations, reconciliation without overwriting history |
| Catalog | Product vs. listing | Adds **listing publication separate from product approval** |
| Tenant isolation | RBAC + merchant isolation | Adds **RLS defense-in-depth**, fail-closed tenant context, deny-by-default |
| Events | Flat names (ORDER_CREATED …) | **Versioned names** (`commerce.order.created.v1`) + **standard envelope**; replay/DLQ monitoring |
| Search | Search engine in flow | **Derived read model**; authoritative filters; lag never licenses stale price/stock; replayable indexing |
| AI tool execution | Tool validation | Adds **tool policy layer**, tool classification (read-only/reversible/sensitive), result validation, output guardrails, confirmation for sensitive actions |
| WhatsApp backend | Reference impl used **MongoDB** | **MongoDB not part of architecture**; single PostgreSQL source of truth |
| WhatsApp inventory | `is_available` boolean | Boolean = presentation hint only; real **atomic reservations** |
| WhatsApp payment | UPI "I have paid" → VERIFYING → merchant confirms | Manual = **transitional, lower-assurance**; **verified provider webhook** is payment truth |
| WhatsApp order schema | Separate chat order document | Chat **references core Customer/Seller Orders**; no divergent schema |
| WhatsApp cart | Held in session state | Uses core Cart & Checkout context; Redis only for ephemeral state |
| Roadmap | 14 phases | **17 phases** with exit conditions; adds Fulfillment & Returns, Marketplace Finance, Controlled Service Extraction |
| Definition of Done | 14 items | Expanded (bounded contexts, seller-order split, ledger traceability, reconciliation tests, ADRs, open decisions recorded) |
| Deliverables | 15 items | Adds bounded-context spec, state machines, payment/fulfillment/settlement specs, tenant-isolation model, MLOps report, ADR set |
| Governance | — | Adds **Open Production Decisions** list and **architectural invariants** |

---

## Appendix C – Glossary

- **Bounded context:** a module with explicit ownership of its data and rules (e.g., Inventory, Payment, Settlement).
- **Canonical Product:** the platform-wide product identity; **Variant/SKU:** purchasable configuration; **Merchant Listing:** seller-specific offer for a SKU (price, stock, fulfillment).
- **Customer Order / Seller Order:** the customer's overall order vs. the per-seller sub-order that owns fulfillment, returns and settlement.
- **Transactional outbox:** events written in the same DB transaction as state changes, then published after commit.
- **Idempotent consumer:** processing the same event multiple times has the same effect as once.
- **DLQ:** dead-letter queue for poison messages (with reason metadata).
- **RLS:** PostgreSQL Row-Level Security.
- **IDOR/BOLA:** Insecure Direct Object Reference / Broken Object-Level Authorization.
- **RAG:** Retrieval-Augmented Generation (knowledge retrieval, never live transactional truth).
- **WABA:** WhatsApp Business Account.
- **ADR:** Architecture Decision Record.
- **RTO/RPO:** Recovery Time/Point Objective.
- **SLI/SLO:** Service Level Indicator/Objective.
- **WAPE/MAE/RMSE:** forecasting error metrics.
- **UPI intent link:** `upi://pay?...` deep link used for transitional manual payment flow.
- **Derived system:** search index, cache, vector store, analytics store, ML prediction — never the source of transactional truth.
