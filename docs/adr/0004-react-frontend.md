# 4. React for Frontend Application Shell

## Status

Accepted

## Context

The platform requires an interactive frontend capable of supporting multi-vendor commerce interfaces, responsive buyer flows, predictive discovery experiences, and merchant administrative dashboards.

## Decision

Adopt React with Vite as the build tool under `apps/web`. Vite offers sub-second cold starts, fast HMR, and standard ESM bundling.

## Consequences

### Positive

- Vast ecosystem of commerce and UI components.
- Modern single-page application (SPA) architecture with fast local development cycle.
- Seamless TypeScript typing integration.

### Negative

- Client-side state and data fetching must be structured deliberately as application complexity grows.

## Alternatives Considered

- **Next.js:** Full-stack framework; rejected for Phase 1 to preserve an explicit separation between the React presentation client and the Fastify modular monolith backend.
- **Vue / Svelte:** Robust alternatives, but React was selected as the designated standard for this platform.

## Rollback/Exit Considerations

Component and view logic will adhere to standard modern React patterns. Standard build output produces static web assets capable of being hosted on any standard web server or CDN.
