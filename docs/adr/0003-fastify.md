# 3. Fastify as Backend HTTP Framework

## Status

Accepted

## Context

The backend requires a modern, high-performance HTTP layer with first-class TypeScript support, built-in schema validation, extensible request lifecycle hooks, and structured JSON logging.

## Decision

Adopt Fastify as the HTTP framework for `apps/api`. Fastify provides native integration with Pino for structured logging, standardized lifecycle hooks (for request ID, correlation ID, and error handling), and schema-driven request/response validation.

## Consequences

### Positive

- High throughput and low latency overhead.
- Native structured logging with correlation and request ID propagation.
- Plugin architecture aligns with modular monolith composition without tight coupling.

### Negative

- Plugin registration ordering and scope encapsulation must be consciously managed.
- Ecosystem differs from Express middleware conventions, requiring Fastify-compatible plugins or custom lifecycle hooks.

## Alternatives Considered

- **Express:** Mature, but lacks native async lifecycle guarantees, modern schema-driven validation, and built-in structured logging integration out of the box.
- **NestJS:** Full-featured, but adds significant decorator/DI abstraction weight and framework lock-in that obscures clean architecture boundaries.

## Rollback/Exit Considerations

HTTP routing and request handling are encapsulated in the boundary layer (`apps/api/src/app.ts`). Core application logic and bounded contexts do not depend on Fastify internals, allowing framework substitution if required.
