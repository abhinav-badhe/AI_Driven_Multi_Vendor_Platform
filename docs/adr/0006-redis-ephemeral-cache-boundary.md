# 6. Redis Restricted to Cache, Rate Limiting, and Ephemeral State

## Status

Accepted

## Context

In high-throughput commerce systems, in-memory stores are frequently misused as secondary databases, leading to data loss, silent split-brain conditions, and unrecoverable transactional state upon eviction or failover.

## Decision

Constrain Redis strictly to ephemeral use cases:

1. Short-lived read caching (with definitive invalidation strategies).
2. Distributed rate limiting and throttling counters.
3. Ephemeral, non-authoritative session state or locks with bounded TTLs.

Redis MUST NOT be used as a primary source of truth, persistent message broker, or transactional store. Phase 1 provides only the client configuration and lifecycle boundary; application tests and baseline startup must not require a live Redis instance to function.

## Consequences

### Positive

- Prevents architectural degradation and unrecoverable data loss during Redis restarts or evictions.
- Preserves clear disaster recovery semantics: Redis can be flushed or rebuilt entirely from PostgreSQL without permanent data loss.

### Negative

- Ephemeral state must be resilient to cache misses; code must always implement fallback paths to the primary database or deterministic defaults.

## Alternatives Considered

- **Redis as Primary Store for Sessions/Carts:** Rejected; checkout and cart orchestration must not lose state unpredictably due to eviction or memory pressure.
- **In-Memory In-Process Cache Only:** Insufficient for multi-instance horizontal scaling of rate limiting and shared caching.

## Rollback/Exit Considerations

Because Redis holds strictly ephemeral state, migrating to an alternative caching layer (e.g., Memcached or local LRU for test environments) or bypassing the cache entirely remains straightforward.
