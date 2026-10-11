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
  | 'PROMOTION_STATUS_CHANGED'
  | 'LOGIN_2FA_CHALLENGE'
  | 'LOGIN_2FA_FAILURE'
  | '2FA_ENABLED'
  | '2FA_DISABLED';

export interface AuditEventMetadata {
  [key: string]: unknown;
}

export interface SecurityAuditParams {
  eventType: AuditEventType;
  actorId?: string | undefined;
  tenantId?: string | undefined;
  ipAddress?: string | undefined;
  userAgent?: string | undefined;
  metadata?: AuditEventMetadata | undefined;
}

export interface SecurityAuditEventRecord {
  id: string;
  eventType: AuditEventType;
  actorId: string | null;
  tenantId: string | null;
  ipAddress: string | null;
  userAgent: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface ISecurityAuditService {
  record(params: SecurityAuditParams): Promise<void>;
  query?(filters?: {
    actorId?: string;
    tenantId?: string;
    eventType?: AuditEventType;
    limit?: number;
  }): Promise<SecurityAuditEventRecord[]>;
}

export class SecurityAuditService implements ISecurityAuditService {
  constructor(
    private readonly db: DatabaseConnection,
    private readonly logger: Logger,
  ) {}

  async record(params: SecurityAuditParams): Promise<void> {
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

  async query(filters?: {
    actorId?: string;
    tenantId?: string;
    eventType?: AuditEventType;
    limit?: number;
  }): Promise<SecurityAuditEventRecord[]> {
    const conditions: string[] = [];
    const values: unknown[] = [];
    let idx = 1;

    if (filters?.actorId) {
      conditions.push(`actor_id = $${idx++}`);
      values.push(filters.actorId);
    }
    if (filters?.tenantId) {
      conditions.push(`tenant_id = $${idx++}`);
      values.push(filters.tenantId);
    }
    if (filters?.eventType) {
      conditions.push(`event_type = $${idx++}`);
      values.push(filters.eventType);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = Math.min(filters?.limit ?? 50, 200);
    values.push(limit);

    const result = await this.db.query(
      `SELECT id, event_type, actor_id, tenant_id, ip_address, user_agent, metadata, created_at
       FROM security_audit_events
       ${whereClause}
       ORDER BY created_at DESC
       LIMIT $${idx}`,
      values,
    );

    return result.rows.map((r: any) => ({
      id: r.id,
      eventType: r.event_type as AuditEventType,
      actorId: r.actor_id,
      tenantId: r.tenant_id,
      ipAddress: r.ip_address,
      userAgent: r.user_agent,
      metadata: typeof r.metadata === 'string' ? JSON.parse(r.metadata) : (r.metadata ?? {}),
      createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
    }));
  }
}

/**
 * In-memory Security Audit Service for isolated unit tests and standalone mock environments.
 */
export class InMemorySecurityAuditService implements ISecurityAuditService {
  private readonly events: SecurityAuditEventRecord[] = [];

  async record(params: SecurityAuditParams): Promise<void> {
    this.events.unshift({
      id: randomUUID(),
      eventType: params.eventType,
      actorId: params.actorId ?? null,
      tenantId: params.tenantId ?? null,
      ipAddress: params.ipAddress ?? null,
      userAgent: params.userAgent ?? null,
      metadata: (params.metadata as Record<string, unknown>) ?? {},
      createdAt: new Date().toISOString(),
    });
  }

  async query(filters?: {
    actorId?: string;
    tenantId?: string;
    eventType?: AuditEventType;
    limit?: number;
  }): Promise<SecurityAuditEventRecord[]> {
    let result = [...this.events];
    if (filters?.actorId) {
      result = result.filter((e) => e.actorId === filters.actorId);
    }
    if (filters?.tenantId) {
      result = result.filter((e) => e.tenantId === filters.tenantId);
    }
    if (filters?.eventType) {
      result = result.filter((e) => e.eventType === filters.eventType);
    }
    return result.slice(0, filters?.limit ?? 50);
  }

  getAll(): readonly SecurityAuditEventRecord[] {
    return this.events;
  }

  clear(): void {
    this.events.length = 0;
  }
}
