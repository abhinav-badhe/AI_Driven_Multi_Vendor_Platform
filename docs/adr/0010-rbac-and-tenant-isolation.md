# 10. Role-Based Access Control (RBAC) and Verified Tenant Isolation

## Status
Accepted

## Context
In a multi-vendor predictive commerce platform, strict isolation between tenants (merchants, customers, platform administrators) is a foundational non-negotiable security requirement. Data cross-contamination or unauthorized access between competing vendors must be impossible by design.

## Decision
1. **Explicit Role Hierarchy:** Define three core system roles:
   - `ADMINISTRATOR`: Platform operators with governance, verification, and audit access.
   - `MERCHANT`: Business owners authorized strictly within their own tenant boundary.
   - `CUSTOMER`: End users interacting with commerce features and personal identity.
2. **Granular Permissions:** Map roles to explicit functional capabilities (e.g. `merchant:onboard`, `merchant:read-own`, `merchant:update-own`, `merchant:verify`).
3. **Server-Enforced Tenant Context:** Never trust tenant identifiers supplied by client requests. Tenant context is extracted cryptographically from the verified access token and attached to the request lifecycle.
4. **Programmatic & Relational Isolation:**
   - Every domain query and command asserts `requireTenantMatch(actor, resourceTenantId)`.
   - Relational schemas enforce foreign keys on `tenant_id` to guarantee referential integrity and cascade rules.
5. **Cross-Tenant Access Rejection:** Any attempt by an actor to query, mutate, or reference resources belonging to a different tenant is rejected with a `403 Forbidden` (`FORBIDDEN`) error and logged as a security audit event.

## Consequences
### Positive
- Prevents cross-tenant data leakage by eliminating client-controlled tenant scoping.
- Role and permission definitions are centralized, testable, and deterministic.
- Clear audit trails for unauthorized access attempts.

### Negative
- All domain modules must consistently accept `AuthorizedActor` and check tenant matches.

## Alternatives Considered
- **Database Row-Level Security (RLS) alone:** Relies heavily on database-level sessions and connection pooling complications; preferred approach is explicit domain-level tenant boundaries backed by relational schema foreign keys.
- **Client-Provided Tenant Headers:** Rejected as vulnerable to spoofing and unauthorized cross-tenant data exfiltration.
