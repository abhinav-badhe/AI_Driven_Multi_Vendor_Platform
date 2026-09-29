# 5. PostgreSQL as Transactional Source of Truth

## Status

Accepted

## Context

Multi-vendor commerce systems require strict ACID guarantees for inventory movements, financial ledgers, orders, listings, and identity state. Distributed data stores or NoSQL engines risk data inconsistency, race conditions, and reconciliation debt.

## Decision

Designate PostgreSQL as the sole transactional source of truth for all primary business data. All bounded contexts will persist their authoritative state in PostgreSQL. In Phase 1, only the database configuration abstraction and connection boundary are implemented; business schemas and domain tables are deferred to future phases.

## Consequences

### Positive

- Strict ACID compliance for financial, inventory, and order operations.
- Strong support for row-level locking, transactional outbox pattern, and relational integrity.
- Mature indexing, partitioning, and backup/restore operational model.

### Negative

- Schema evolutions require disciplined migration management.
- Direct cross-context table joins must be strictly prohibited at the application and architecture level to preserve modular monolith boundaries.

## Alternatives Considered

- **Document / NoSQL Stores (MongoDB):** Rejected due to lack of multi-entity transactional guarantees essential for multi-vendor accounting and inventory reservations.
- **Distributed SQL (CockroachDB / YugabyteDB):** Unnecessary operational complexity for initial architecture.

## Rollback/Exit Considerations

By isolating database interactions behind repository and infrastructure boundaries within each bounded context, database drivers or topologies can be scaled or adjusted without altering domain business rules.
