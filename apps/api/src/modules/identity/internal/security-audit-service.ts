import type { DatabaseConnection } from '../../../infra/database/connection.js';
import type { Logger } from '../../../observability/logger.js';
import { randomUUID } from 'node:crypto';

export type AuditEventType =
  | 'LOGIN_SUCCESS'
  | 'LOGIN_FAILURE'
  | 'LOGOUT'
  | 'EMAIL_VERIFIED'
  | 'REFRESH_TOKEN_ISSUED'
  | 'REFRESH_TOKEN_ROTATED'
  | 'REFRESH_TOKEN_REUSE_DETECTED'
  | 'REFRESH_TOKEN_FAMILY_REVOKED'
  | 'MERCHANT_VERIFICATION_APPROVED'
  | 'MERCHANT_VERIFICATION_REJECTED'
  | 'LISTING_SUSPENDED'
  | 'UNAUTHORIZED_ACCESS_ATTEMPT'
  | 'PROMOTION_CREATED'
  | 'PROMOTION_UPDATED'
  | 'PROMOTION_STATUS_CHANGED';

export interface AuditEventMetadata {
  [key: string]: unknown;
}

export class SecurityAuditService {
  constructor(
    private readonly db: DatabaseConnection,
    private readonly logger: Logger,
  ) {}

  async record(params: {
    eventType: AuditEventType;
    actorId?: string | undefined;
    tenantId?: string | undefined;
    ipAddress?: string | undefined;
    userAgent?: string | undefined;
    metadata?: AuditEventMetadata | undefined;
  }): Promise<void> {
    const id = randomUUID();
    // Never log passwords, tokens, or secrets in metadata
    const safeMetadata = params.metadata ?? {};

    try {
      await this.db.query(
        `INSERT INTO security_audit_events
           (id, event_type, actor_id, tenant_id, ip_address, user_agent, metadata)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
        [
          id,
          params.eventType,
          params.actorId ?? null,
          params.tenantId ?? null,
          params.ipAddress ?? null,
          params.userAgent ?? null,
          JSON.stringify(safeMetadata),
        ],
      );
    } catch (err) {
      // Audit failures must not disrupt primary flows
      this.logger.error('Failed to write security audit event', {
        eventType: params.eventType,
        error: err instanceof Error ? err.message : 'unknown',
      });
    }
  }
}
