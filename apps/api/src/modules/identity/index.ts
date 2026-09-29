/**
 * BOUNDED CONTEXT: Identity & Access
 * Ownership: Authentication, actor identity, tenant context, roles & permissions.
 *
 * Boundary Rules:
 * - Internal domain entities, password hashing, and token signing are private to internal/.
 * - Other modules must access identity solely via this public interface.
 */

export interface IdentityModule {
  readonly contextName: 'identity';
}

export const identityModule: IdentityModule = {
  contextName: 'identity',
};
