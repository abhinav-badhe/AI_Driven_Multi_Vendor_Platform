# 8. Deterministic Versioned SQL Migrations for PostgreSQL

## Status
Accepted

## Context
Phase 2 introduces the authoritative PostgreSQL schema for Identity & Access (users, tenants, memberships, refresh tokens) and Merchant (merchant profiles). A robust, deterministic migration mechanism is required that ensures ordered forward execution, schema tracking, transactional guarantees, and zero silent schema synchronization drift.

## Decision
Adopt a version-tracked, deterministic SQL migration runner under `apps/api/src/infra/database/migrations/`.
- Migrations are defined in sequentially ordered files (e.g. `0001_identity_schema.sql`, `0002_merchant_schema.sql`).
- A dedicated tracking table (`schema_migrations`) stores the applied migration name, version hash, and timestamp.
- Each migration executes within an atomic database transaction (`BEGIN ... COMMIT`), automatically rolling back on failure to prevent half-applied schemas.
- Down/rollback migrations are explicitly separated and never executed automatically in production.

## Consequences
### Positive
- Predictable and deterministic schema evolution across local environments, CI, and production.
- Direct visibility into raw SQL DDL without ORM magic or hidden schema mutations.
- Safe transactional rollback on any migration failure.

### Negative
- Requires writing explicit SQL DDL migrations rather than auto-generating schemas from entity classes.

## Alternatives Considered
- **Prisma / TypeORM Schema Sync:** Rejected because automatic schema synchronization risks silent data loss, non-deterministic DDL execution, and hidden locks in production.
- **Third-Party Migration SaaS:** Rejected to avoid external network/cloud dependencies.

## Rollback/Exit Considerations
Because migrations are standard SQL DDL files tracked by version in `schema_migrations`, the platform can easily integrate with external tools (e.g., `sqitch`, `db-migrate`, or Flyway) in the future without altering database state.
