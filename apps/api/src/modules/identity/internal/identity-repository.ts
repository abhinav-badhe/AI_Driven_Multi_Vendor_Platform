import { randomUUID } from 'node:crypto';
import type { DatabaseConnection } from '../../../infra/database/connection.js';

export interface UserRow {
  id: string;
  email: string;
  password_hash: string;
  status: string;
  created_at: string;
  updated_at: string;
}

export interface TenantRow {
  id: string;
  type: string;
  name: string;
  status: string;
}

export interface MembershipRow {
  id: string;
  tenant_id: string;
  user_id: string;
  role: string;
  status: string;
}

export interface RefreshTokenRow {
  id: string;
  user_id: string;
  tenant_id: string;
  family_id: string;
  token_hash: string;
  is_revoked: boolean;
  is_rotated: boolean;
  expires_at: string;
  created_at: string;
  rotated_at: string | null;
}

export class IdentityRepository {
  constructor(private readonly db: DatabaseConnection) {}

  async createUser(params: {
    email: string;
    passwordHash: string;
  }): Promise<UserRow> {
    const id = randomUUID();
    const result = await this.db.query<UserRow>(
      `INSERT INTO users (id, email, password_hash, status)
       VALUES ($1, $2, $3, 'ACTIVE')
       RETURNING *`,
      [id, params.email.toLowerCase(), params.passwordHash],
    );
    const row = result.rows[0];
    if (!row) throw new Error('Failed to create user');
    return row;
  }

  async findUserByEmail(email: string): Promise<UserRow | null> {
    const result = await this.db.query<UserRow>(
      `SELECT * FROM users WHERE email = $1`,
      [email.toLowerCase()],
    );
    return result.rows[0] ?? null;
  }

  async findUserById(id: string): Promise<UserRow | null> {
    const result = await this.db.query<UserRow>(`SELECT * FROM users WHERE id = $1`, [id]);
    return result.rows[0] ?? null;
  }

  async createTenant(params: { type: string; name: string }): Promise<TenantRow> {
    const id = randomUUID();
    const result = await this.db.query<TenantRow>(
      `INSERT INTO tenants (id, type, name, status)
       VALUES ($1, $2, $3, 'ACTIVE')
       RETURNING *`,
      [id, params.type, params.name],
    );
    const row = result.rows[0];
    if (!row) throw new Error('Failed to create tenant');
    return row;
  }

  async findTenantById(id: string): Promise<TenantRow | null> {
    const result = await this.db.query<TenantRow>(`SELECT * FROM tenants WHERE id = $1`, [id]);
    return result.rows[0] ?? null;
  }

  async createMembership(params: {
    tenantId: string;
    userId: string;
    role: string;
  }): Promise<MembershipRow> {
    const id = randomUUID();
    const result = await this.db.query<MembershipRow>(
      `INSERT INTO tenant_memberships (id, tenant_id, user_id, role, status)
       VALUES ($1, $2, $3, $4, 'ACTIVE')
       RETURNING *`,
      [id, params.tenantId, params.userId, params.role],
    );
    const row = result.rows[0];
    if (!row) throw new Error('Failed to create membership');
    return row;
  }

  async findMembershipByUserAndTenant(
    userId: string,
    tenantId: string,
  ): Promise<MembershipRow | null> {
    const result = await this.db.query<MembershipRow>(
      `SELECT * FROM tenant_memberships
       WHERE user_id = $1 AND tenant_id = $2 AND status = 'ACTIVE'`,
      [userId, tenantId],
    );
    return result.rows[0] ?? null;
  }

  async findActiveMembershipByUserId(userId: string): Promise<MembershipRow | null> {
    const result = await this.db.query<MembershipRow>(
      `SELECT * FROM tenant_memberships WHERE user_id = $1 AND status = 'ACTIVE' LIMIT 1`,
      [userId],
    );
    return result.rows[0] ?? null;
  }

  async saveRefreshToken(params: {
    id: string;
    userId: string;
    tenantId: string;
    familyId: string;
    tokenHash: string;
    expiresAt: Date;
  }): Promise<void> {
    await this.db.query(
      `INSERT INTO refresh_tokens (id, user_id, tenant_id, family_id, token_hash, is_revoked, is_rotated, expires_at)
       VALUES ($1, $2, $3, $4, $5, FALSE, FALSE, $6)`,
      [
        params.id,
        params.userId,
        params.tenantId,
        params.familyId,
        params.tokenHash,
        params.expiresAt.toISOString(),
      ],
    );
  }

  async findRefreshTokenByHash(hash: string): Promise<RefreshTokenRow | null> {
    const result = await this.db.query<RefreshTokenRow>(
      `SELECT * FROM refresh_tokens WHERE token_hash = $1`,
      [hash],
    );
    return result.rows[0] ?? null;
  }

  async rotateRefreshToken(id: string): Promise<void> {
    await this.db.query(
      `UPDATE refresh_tokens SET is_rotated = TRUE, rotated_at = CURRENT_TIMESTAMP WHERE id = $1`,
      [id],
    );
  }

  async rotateRefreshTokenAtomic(id: string): Promise<boolean> {
    const result = await this.db.query(
      `UPDATE refresh_tokens
       SET is_rotated = TRUE, rotated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND is_rotated = FALSE AND is_revoked = FALSE
       RETURNING id`,
      [id],
    );
    return result.rows.length > 0;
  }

  async revokeTokenFamily(familyId: string): Promise<void> {
    await this.db.query(
      `UPDATE refresh_tokens SET is_revoked = TRUE WHERE family_id = $1`,
      [familyId],
    );
  }

  async revokeAllUserTokensInTenant(userId: string, tenantId: string): Promise<void> {
    await this.db.query(
      `UPDATE refresh_tokens SET is_revoked = TRUE
       WHERE user_id = $1 AND tenant_id = $2`,
      [userId, tenantId],
    );
  }

  async findActiveUserAndMembership(
    userId: string,
    tenantId: string,
  ): Promise<{
    userStatus: string;
    tenantStatus: string;
    tenantType: string;
    membershipStatus: string;
    currentRole: string;
  } | null> {
    const result = await this.db.query<{
      user_status: string;
      tenant_status: string;
      tenant_type: string;
      membership_status: string;
      active_role: string;
    }>(
      `SELECT
         u.status AS user_status,
         t.status AS tenant_status,
         t.type AS tenant_type,
         tm.status AS membership_status,
         tm.role AS active_role
       FROM users u
       JOIN tenant_memberships tm ON tm.user_id = u.id
       JOIN tenants t ON t.id = tm.tenant_id
       WHERE u.id = $1 AND tm.tenant_id = $2`,
      [userId, tenantId],
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      userStatus: row.user_status,
      tenantStatus: row.tenant_status,
      tenantType: row.tenant_type,
      membershipStatus: row.membership_status,
      currentRole: row.active_role,
    };
  }
}
