# 7. Modular Monolith Rather than Microservices

## Status

Accepted

## Context

Premature decomposition into microservices introduces distributed transaction failures, network latency overhead, high operational complexity, dual-write challenges, and deployment friction before domain boundaries and data access patterns have stabilized.

## Decision

Implement the backend as a single deployable Modular Monolith under `apps/api`.
The monolith enforces explicit bounded contexts:

- Identity & Access
- Merchant
- Catalog
- Marketplace
- Inventory
- Cart & Checkout
- Orders
- Fulfillment
- Payment
- Settlement/Ledger
- Customer
- Promotion & Pricing
- Events
- Search (derived read model)
- AI (application capability using authorized tools)
- Analytics/ML (governed data consumers)
- Security & Audit

Each module owns its internal logic, and cross-module interactions are restricted to public interfaces or asynchronous outbox events. Direct cross-module database access is prohibited.

## Consequences

### Positive

- Single deployment artifact, straightforward local development, and simple debugging.
- ACID transactions across module boundaries when strictly necessary, while enforcing module encapsulation.
- Clear migration path: well-bounded modules can later be extracted into independent services if and when organizational or scaling requirements demand it.

### Negative

- Requires rigorous architectural discipline, linting rules, and tests to prevent developers from bypassing module boundaries in a shared codebase.

## Alternatives Considered

- **Microservices Architecture:** Rejected due to premature operational overhead, service-mesh complexity, distributed tracing overhead, and distributed consensus requirements.
- **Unstructured / Layered Monolith:** Rejected because traditional layered monoliths (controllers -> services -> models) lead to tangled dependencies and tightly coupled database schemas.

## Rollback/Exit Considerations

Because bounded contexts are physically separated and communicate only via public interfaces or events, any individual module can be extracted into an independent microservice in the future with minimal refactoring.
