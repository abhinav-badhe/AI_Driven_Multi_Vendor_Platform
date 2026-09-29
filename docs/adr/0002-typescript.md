# 2. Strict TypeScript for Frontend and Backend

## Status

Accepted

## Context

The platform requires strict module boundary enforcement, deterministic typed schemas, and authorized typed tools for AI agent commerce access. Dynamically typed JavaScript allows silent runtime failures, hidden contract divergence, and undetectable cross-boundary leaks.

## Decision

Adopt strict TypeScript across all workspaces (`apps/web`, `apps/api`). The TypeScript compiler is configured with `strict: true`, `noImplicitAny: true`, `strictNullChecks: true`, and `exactOptionalPropertyTypes: true` via a shared `tsconfig.base.json`.

## Consequences

### Positive

- Enforces strict type boundaries at compile time.
- Guarantees compile-time verification for AI typed tool inputs, outputs, and authorization contexts.
- Shared type safety across frontend and backend API contracts.

### Negative

- Requires a build step (compilation/transpilation).
- Requires explicit type definitions and schema mappings for external payloads.

## Alternatives Considered

- **Plain JavaScript with JSDoc:** Insufficient type enforcement and boundary security for complex multi-vendor workflows and authorized AI tooling.
- **Mixed TS/JS:** Rejected to eliminate any lax typing loopholes.

## Rollback/Exit Considerations

TypeScript compiles to standard ECMAScript modules (ESM). In the event of an exit, emitted JavaScript can run directly on standard Node.js runtimes.
