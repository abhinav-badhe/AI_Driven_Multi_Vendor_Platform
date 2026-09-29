/**
 * BOUNDED CONTEXT: Security & Audit
 * Ownership: Immutable audit logs, tamper-evident security events, compliance monitoring.
 */
export interface SecurityAuditModule {
  readonly contextName: 'security-audit';
}

export const securityAuditModule: SecurityAuditModule = {
  contextName: 'security-audit',
};
