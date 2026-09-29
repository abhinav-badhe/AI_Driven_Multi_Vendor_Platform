# 1. Monorepo Using npm Workspaces

## Status

Accepted

## Context

The platform is an AI-driven multi-vendor predictive commerce system requiring high cohesion across the frontend interface, modular backend, shared type contracts, and continuous verification tooling. Managing multiple repositories at this stage would introduce version skew, dependency drift, and significant orchestration overhead across local development and CI.

## Decision

Adopt a single monorepo structure managed via native `npm workspaces`. The repository layout is partitioned into:

- `apps/web`: React-based user interface.
- `apps/api`: Node.js modular monolith backend.
- `packages/`: Reserved strictly for genuine cross-cutting libraries or contracts if necessary.

## Consequences

### Positive

- Atomic commits and unified versioning across frontend, backend, and documentation.
- Single command execution for workspace-wide building, linting, typechecking, and testing.
- No third-party workspace tool overhead (e.g. Lerna/Nx/Turborepo) required for baseline foundation.

### Negative

- Monorepo tooling and scripts must be kept uniform to avoid workspace configuration conflicts.
- CI must manage workspace dependency graphs cleanly.

## Alternatives Considered

- **Polyrepo (Multi-repo):** Rejected due to development overhead, version synchronization bottlenecks, and friction when coordinating cross-cutting architectural changes.
- **pnpm / Yarn Workspaces:** Rejected for Phase 1 to rely on standard Node.js native tooling (`npm`) available out of the box without requiring global external tooling.

## Rollback/Exit Considerations

If package isolation or independent team scaling later requires multi-repo separation, bounded contexts and applications are already physically segregated into independent directory hierarchies (`apps/web`, `apps/api`) with independent `package.json` manifests.
