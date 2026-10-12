# 9. Server-Controlled Token Authentication with Refresh Token Rotation

## Status

Accepted

## Context

Multi-vendor commerce requires an authentication mechanism that guarantees stateless low-latency access token verification while providing strict server-side revocation, session invalidation, and protection against token theft or replay attacks.

## Decision

Adopt a dual-token authentication model:

1. **Short-Lived Access Tokens & Live Context:** Signed cryptographic tokens (HMAC SHA-256) with short TTL (15 minutes). For protected operations, `auth-middleware` performs live server-side validation against PostgreSQL ensuring the user status is `ACTIVE` (not `LOCKED` or `DEACTIVATED`), the tenant is `ACTIVE`, the membership is `ACTIVE`, and dynamically enforces the user's current database role without relying on stale claims.
2. **Password Hashing Specification:** Native `crypto.scrypt` with standard RFC 7914 parameters: CPU/memory cost $N=16384$ ($2^{14}$), block size $r=8$, parallelization $p=1$, `maxmem=64MB`, and key length 64 bytes (512-bit output) with unique 16-byte (128-bit) cryptographically random salt per user. Stored as `salt:hash`. Verification uses constant-time `timingSafeEqual` and dummy hashing prevents timing oracle attacks.
3. **Long-Lived Refresh Tokens:** High-entropy cryptographically random strings (32 bytes / 256 bits).
4. **Hashed Refresh Token Storage:** Raw refresh tokens are never stored in the database. Only SHA-256 hashes of the refresh tokens are persisted in `refresh_tokens`.
5. **Atomic Token Family & Rotation:** Each refresh token belongs to a `family_id`. Upon valid refresh, rotation is executed atomically via conditional update (`WHERE id = $1 AND is_rotated = FALSE AND is_revoked = FALSE`) within a database transaction.
6. **Concurrent Refresh Safety & Reuse Detection:** If two requests present the same refresh token concurrently, atomic conditional update ensures exactly one caller succeeds. The losing caller detects the conflict, immediately revokes the entire token family, logs a security audit event, and fails with `401 Unauthorized`.
7. **Logout Semantics:** Logout revokes all active refresh token families for the user within that tenant boundary (`revokeAllUserTokensInTenant`), completely terminating all concurrent sessions for that user in the tenant.
8. **No External Identity SaaS:** Authentication is self-contained within the Identity & Access bounded context, avoiding third-party authentication dependencies or vendor lock-in.

## Consequences

### Positive

- Minimizes the window of exposure for intercepted access tokens.
- Detects token theft immediately through family reuse detection.
- Fast, secure logout through immediate server-side revocation.
- Raw secrets are never stored at rest, protecting database dumps from compromise.

### Negative

- Requires database interaction during token refresh operations.
- Clients must handle silent token refresh cycles gracefully.

## Alternatives Considered

- **Pure Stateless JWTs without Refresh Store:** Rejected because stateless tokens cannot be revoked before natural expiration, violating enterprise security requirements.
- **Server-Side Session Store Only:** Rejected because stateful session lookups on every single HTTP request introduce database/cache contention and degrade horizontal scale.

## Rollback/Exit Considerations

Access token verification and refresh token validation are isolated within the Identity & Access module. If social login, OIDC/OAuth2, or passkeys are added in subsequent phases, the underlying actor/tenant context interfaces remain stable.
