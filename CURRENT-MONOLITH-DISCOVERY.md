# CURRENT-MONOLITH-DISCOVERY

## A. VERIFIED CURRENT STATE

This document reflects the actual verified state of the codebase. The application is a well-structured Modular Monolith built with Fastify, React, PostgreSQL, and Redis.

## 1. Executive Summary

The platform is an AI-driven multi-vendor predictive e-commerce application. It currently employs a strict **Modular Monolith** architecture. All business domains run in a single Node.js/Fastify process and share a single PostgreSQL database (`commerce_db`). Modules communicate synchronously via in-process Dependency Injection (DI) and asynchronously via a local PostgreSQL Transactional Outbox pattern.

## 2. Repository Structure

The repository is a monorepo utilizing a standard package manager workspace (npm).

```
/
├── apps/
│   ├── api/                 # Backend Node.js/Fastify Application
│   │   ├── src/
│   │   │   ├── config/      # Environment & Config
│   │   │   ├── errors/      # Global error handling
│   │   │   ├── http/        # API Routes (Controllers)
│   │   │   ├── infra/       # Database, Redis, Migrations, Seeds
│   │   │   ├── modules/     # Domain Modules (The core monolith boundaries)
│   │   │   └── observability/# Logging & Tracing
│   │   ├── test/            # Backend unit & integration tests
│   │   ├── .env.example
│   │   └── package.json
│   └── web/                 # Frontend React/Vite Application
│       ├── src/
│       │   ├── api/         # Global API client
│       │   ├── components/  # Shared UI
│       │   ├── features/    # Domain-aligned frontend slices
│       │   └── routes/      # Application routing
│       └── package.json
├── packages/                # Shared internal libraries (e.g. tsconfig, eslint)
└── package.json             # Root workspace configuration
```

## 3. Architecture Overview

- **Boundary Enforcement**: Modules reside in `apps/api/src/modules/*`. They expose a public `index.ts` file.
- **Synchronous Coupling**: Modules are composed in `apps/api/src/app.ts` using Dependency Injection. A module (e.g., Orders) will receive an instance of another module (e.g., Inventory) to call its methods directly in memory.
- **Asynchronous Coupling**: Cross-module side effects use a **Transactional Outbox**. A module writes an event to the DB inside its transaction. The `events` module polls this outbox and dispatches it to subscribed modules in the same Node.js process.
- **Shared Infrastructure**: All modules share the `DatabaseConnection` (pg pool) and `RedisService`.
- **Shared Auth**: Authentication is handled via a shared JWT mechanism. HTTP routes use `requireActor` middleware to extract user context.

## 4. Module Inventory

| Module               | Business Responsibility          | Internal/External Integrations         |
| -------------------- | -------------------------------- | -------------------------------------- |
| `identity`           | Users, Auth, JWTs, RBAC          | Generates tokens                       |
| `merchant`           | Vendor profiles, onboarding      | -                                      |
| `catalog`            | Products, SKUs, Reviews          | -                                      |
| `marketplace`        | Listings, Pricing                | Reads `catalog`                        |
| `inventory`          | Stock management, reservations   | -                                      |
| `customer`           | Profiles, Wishlist, Addresses    | -                                      |
| `cart-checkout`      | Shopping carts, pricing calc     | Reads `inventory`, `marketplace`       |
| `orders`             | Order creation, lifecycle        | Writes `fulfillment`, `payment` events |
| `payment`            | Payment intent, webhooks         | Stripe integration                     |
| `fulfillment`        | Shipping, Returns, Tracking      | Shippo integration                     |
| `settlement-ledger`  | Vendor payouts, commissions      | -                                      |
| `promotions-pricing` | Discounts, Coupons               | -                                      |
| `search`             | Indexing, Search Projection      | Rebuilds from `catalog`                |
| `analytics-ml`       | Predictive ML, Anomaly detection | -                                      |
| `recommendations`    | Trending, Similar products       | Reads `analytics`                      |
| `price-alerts`       | Watchlists, Drop notifications   | Writes `notifications`                 |
| `notifications`      | Email, SMS, Push dispatch        | Resend, Meta WhatsApp                  |
| `events`             | Outbox polling, Event Bus        | Connects all modules                   |
| `ai`                 | RAG, Embeddings                  | Mock LLM / OpenAI                      |
| `security-audit`     | Action logging                   | -                                      |

## 5. API Inventory

APIs are separated into `apps/api/src/http/*-routes.ts` files, injected into Fastify.

- **Customer APIs**: `/cart`, `/checkout`, `/orders`, `/wishlist`, `/recommendations/personalized` (Requires `CUSTOMER` role)
- **Merchant APIs**: `/merchant/me`, `/listings`, `/inventory`, `/seller/orders`, `/settlement/merchants` (Requires `MERCHANT` role)
- **Admin APIs**: `/events/outbox`, `/search/rebuild`, `/ml/*`, `/notifications` (Requires `ADMINISTRATOR` role)
- **Public APIs**: `/auth/login`, `/products`, `/categories`, `/search` (No auth required)

## 6. Database Inventory (PostgreSQL)

Migrations are defined in `apps/api/src/infra/database/migrations/*.sql`.

| TABLE                   | CURRENT OWNER | RELATED TABLES       | FUTURE SERVICE CANDIDATE |
| ----------------------- | ------------- | -------------------- | ------------------------ |
| `users`                 | `identity`    | -                    | Identity Service         |
| `merchants`             | `merchant`    | `users`              | Merchant/Vendor Service  |
| `products`, `skus`      | `catalog`     | `categories`         | Catalog Service          |
| `listings`              | `marketplace` | `merchants`, `skus`  | Marketplace Service      |
| `inventory_items`       | `inventory`   | `listings`           | Inventory Service        |
| `orders`, `order_items` | `orders`      | `users`, `merchants` | Order Service            |
| `payments`              | `payment`     | `orders`             | Payment Service          |
| `shipments`             | `fulfillment` | `orders`             | Fulfillment Service      |
| `ledger_entries`        | `settlement`  | `merchants`          | Settlement Service       |
| `outbox_events`         | `events`      | -                    | Platform/Event Service   |

## 7. Database Ownership Matrix & Coupling

**Coupling Risk**: While the schema is logically partitioned, foreign keys exist across module boundaries (e.g., `order_items.sku_id` references `skus.id`). A future microservice migration will require dropping these hard Foreign Key constraints and handling referential integrity at the application layer.

## 8. Transaction Boundaries

Currently, the monolithic application passes a `DatabaseConnection` object through the DI chain.
**CRITICAL MIGRATION BLOCKER**: Cross-module transactions currently exist. For example, `Checkout` creates an Order, reserves Inventory, and clears the Cart _in a single PostgreSQL transaction_. When extracted into microservices, this ACID transaction will fail. It MUST be rewritten using the **Saga Pattern** or distributed two-phase commit.

## 9. Authentication & Authorization

- **Implementation**: JWT-based authentication.
- **Middleware**: `createAuthMiddleware` parses headers, `requireActor` enforces `role`.
- **Migration Impact**: Future microservices will need an API Gateway to parse the JWT and forward identity headers (e.g., `X-User-Id`, `X-User-Role`), or each service must have access to the public key to verify JWTs locally.

## 10. Events & Async Processing

- **Current**: PostgreSQL Transactional Outbox table (`outbox_events`). The `EventRelay` process queries `status = 'PENDING'`, dispatches them to an `EventEmitter`, and marks them `PROCESSED`.
- **Migration Impact**: The in-memory `EventEmitter` must be replaced with a distributed message broker (Kafka, RabbitMQ, Redis Streams). The Outbox pattern is already perfectly designed for microservices; only the transport layer needs swapping.

| EVENT              | PRODUCER      | CONSUMERS                                 |
| ------------------ | ------------- | ----------------------------------------- |
| `OrderCreated`     | `orders`      | `inventory`, `notifications`, `analytics` |
| `PaymentSucceeded` | `payment`     | `orders`, `fulfillment`                   |
| `PriceDropped`     | `marketplace` | `price-alerts`                            |

## 11. Redis / Cache

- **Location**: `apps/api/src/infra/redis`
- **Usage**: API response caching (`CacheHelper`), distributed Rate Limiting.
- **Migration Impact**: Redis can be easily segregated into independent instances per microservice.

## 12. External Integrations

- **Stripe**: `PaymentService`
- **Shippo**: `FulfillmentService`
- **Resend**: `NotificationService` (Email)
- **Meta Cloud**: `NotificationService` (WhatsApp)
- **LLM/Embeddings**: `AiService`

## 13. Frontend Architecture

- **Tech**: React + Vite SPA.
- **Routing**: `react-router-dom`.
- **API Clients**: Uses native `fetch` mapped via `apps/web/src/api/client.ts`.
- **Migration Impact**: The frontend proxies `/api/*` to `localhost:4000`. Once microservices are introduced, an API Gateway (like Nginx or Kong) must sit at `localhost:4000` to route `/api/orders` to the Order Service and `/api/products` to the Catalog service. The frontend code requires zero changes.

## 14. End-to-End Workflows

**Checkout Flow (Current Monolith):**
`POST /checkout` -> `CartService` -> `InventoryService.reserve` -> `OrderService.create` -> `PaymentService.createIntent` -> DB COMMIT.
_If Inventory fails, the PG transaction rolls back immediately._

## 15. Observability

- Uses structured JSON logging with Correlation IDs (`X-Correlation-ID`) passed implicitly through the Fastify request context.
- **Migration Impact**: Correlation IDs must be passed in outbound HTTP/gRPC requests between microservices to maintain distributed tracing.

## 16. Error Handling

Global error handler maps `AppError`, `ValidationError`, `ForbiddenError` to respective HTTP 400/401/403/404/500 codes.

## 17. Testing

- Tests are written in `vitest`.
- The repository relies heavily on integration/API tests querying the monolith.
- **Migration Impact**: E2E tests must be moved to test against the API Gateway rather than the fastify instance directly.

## 18. Configuration

Configuration resides in `.env`.

- `DATABASE_URL` / `DATABASE_HOST`
- `REDIS_HOST`
- Integration keys (Resend, WhatsApp, Stripe).

## 19. Dependency Graph

`apps/api/src/app.ts` reveals the coupling:
`CheckoutModule` -> depends on -> `CartModule`, `InventoryModule`, `OrdersModule`, `PaymentModule`.
This represents high synchronous coupling.

## 20. Microservice Candidate Analysis & Extraction Strategy

### B. UNKNOWN / NEEDS VERIFICATION

- Real-world traffic load (determines if Kafka or Redis is needed for the event bus).

### C. CRITICAL MIGRATION BLOCKERS

1. **Shared PostgreSQL Transactions**: E.g., reserving inventory and placing an order simultaneously.
2. **Hard Foreign Keys**: Cross-domain DB joins in reporting/analytics endpoints.
3. **Synchronous DI Calls**: The `apiClient` pattern must replace local DI imports inside the backend.

### D. SAFE FIRST EXTRACTION CANDIDATES

1. **Notifications Service**: Completely decoupled, purely event-driven, handles emails/WhatsApp.
2. **Analytics & ML Service**: Reads heavily, but operates mostly in isolation on replica/sync data.
3. **Identity Service**: Only serves JWTs and profile data. Very few inbound synchronous dependencies.

### E. DO NOT CHANGE BEFORE MIGRATION

- Do not add new features bridging modules synchronously. Always use the Outbox for cross-module side effects.

### F. RECOMMENDED MIGRATION SEQUENCE

1. **Phase 1: Infrastructure Preparation**: Introduce an API Gateway and replace the in-memory Event Bus with RabbitMQ/Kafka.
2. **Phase 2: The Edges (Notifications, Analytics, Identity)**: Extract these as they are loosely coupled.
3. **Phase 3: The Core (Catalog, Inventory, Orders)**: The hardest phase. Requires implementing the Saga Pattern for order placement and stripping cross-database foreign keys.
4. **Phase 4: Deprecate Monolith**: Once all 21 modules are extracted, the monolith repo is retired.
