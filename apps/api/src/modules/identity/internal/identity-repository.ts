import { randomUUID, createHash } from 'node:crypto';
import type { DatabaseConnection } from '../../../infra/database/connection.js';

export interface UserRow {
  id: string;
  email: string;
  password_hash: string;
  status: string;
  email_verified_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface EmailVerificationTokenRow {
  id: string;
  user_id: string;
  token_hash: string;
  expires_at: string;
  consumed_at: string | null;
  created_at: string;
}

export function hashVerificationToken(rawToken: string): string {
  return createHash('sha256').update(rawToken).digest('hex');
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

  async markUserEmailVerified(userId: string): Promise<void> {
    await this.db.query(
      `UPDATE users SET email_verified_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND email_verified_at IS NULL`,
      [userId],
    );
  }

  async createVerificationToken(userId: string, tokenHash: string, expiresAt: Date): Promise<void> {
    await this.db.query(
      `INSERT INTO email_verification_tokens (id, user_id, token_hash, expires_at)
       VALUES ($1, $2, $3, $4)`,
      [randomUUID(), userId, tokenHash, expiresAt.toISOString()],
    );
  }

  async findValidVerificationToken(tokenHash: string): Promise<EmailVerificationTokenRow | null> {
    // Expiry is checked in JS (not SQL) for pg-mem compatibility.
    const result = await this.db.query<EmailVerificationTokenRow>(
      `SELECT * FROM email_verification_tokens
       WHERE token_hash = $1 AND consumed_at IS NULL`,
      [tokenHash],
    );
    const row = result.rows[0] ?? null;
    if (!row) return null;
    if (new Date(row.expires_at).getTime() <= Date.now()) return null;
    return row;
  }

  async consumeVerificationToken(id: string): Promise<void> {
    await this.db.query(
      `UPDATE email_verification_tokens SET consumed_at = CURRENT_TIMESTAMP WHERE id = $1`,
      [id],
    );
  }

  async deleteVerificationTokensForUser(userId: string): Promise<void> {
    await this.db.query(`DELETE FROM email_verification_tokens WHERE user_id = $1`, [userId]);
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

  async listAllUsers(limit = 100): Promise<Array<{
    id: string;
    email: string;
    role: string;
    tenantId: string;
    createdAt: string;
    isActive: boolean;
  }>> {
    const res = await this.db.query<{
      id: string;
      email: string;
      role: string | null;
      tenant_id: string | null;
      status: string;
      created_at: Date | string;
    }>(
      `SELECT u.id, u.email, tm.role, tm.tenant_id, u.status, u.created_at
       FROM users u
       LEFT JOIN tenant_memberships tm ON tm.user_id = u.id
       ORDER BY u.created_at DESC
       LIMIT $1`,
      [limit],
    );
    return res.rows.map((r) => ({
      id: r.id,
      email: r.email,
      role: r.role ?? 'CUSTOMER',
      tenantId: r.tenant_id ?? '',
      createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
      isActive: r.status === 'ACTIVE',
    }));
  }

  async getAuditRecords(limit = 50): Promise<Array<{
    id: string;
    event: string;
    userId?: string;
    ip?: string;
    timestamp: string;
    severity: string;
  }>> {
    const res = await this.db.query<{
      id: string;
      user_id: string;
      is_revoked: boolean;
      is_rotated: boolean;
      created_at: Date | string;
    }>(
      `SELECT id, user_id, is_revoked, is_rotated, created_at
       FROM refresh_tokens
       ORDER BY created_at DESC
       LIMIT $1`,
      [limit],
    );
    return res.rows.map((r) => ({
      id: r.id,
      event: r.is_revoked ? 'TOKEN_REVOKED' : r.is_rotated ? 'TOKEN_ROTATED' : 'TOKEN_ISSUED',
      userId: r.user_id,
      ip: '127.0.0.1',
      timestamp: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
      severity: r.is_revoked ? 'WARN' : 'INFO',
    }));
  }

  async find2FASettingsByUserId(userId: string): Promise<UserTwoFactorAuthRow | null> {
    const res = await this.db.query<{
      id: string;
      user_id: string;
      secret: string;
      is_enabled: boolean;
      recovery_codes: unknown;
      created_at: Date | string;
      updated_at: Date | string;
    }>(
      `SELECT id, user_id, secret, is_enabled, recovery_codes, created_at, updated_at
       FROM user_two_factor_auth
       WHERE user_id = $1`,
      [userId],
    );
    const row = res.rows[0];
    if (!row) return null;
    let recoveryCodes: string[] = [];
    if (Array.isArray(row.recovery_codes)) {
      recoveryCodes = row.recovery_codes as string[];
    } else if (typeof row.recovery_codes === 'string') {
      try {
        recoveryCodes = JSON.parse(row.recovery_codes);
      } catch {
        recoveryCodes = [];
      }
    }
    return {
      id: row.id,
      user_id: row.user_id,
      secret: row.secret,
      is_enabled: Boolean(row.is_enabled),
      recovery_codes: recoveryCodes,
      created_at: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
      updated_at: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at),
    };
  }

  async save2FASetup(params: {
    userId: string;
    secret: string;
    recoveryCodes: string[];
  }): Promise<UserTwoFactorAuthRow> {
    const id = randomUUID();
    const codesJson = JSON.stringify(params.recoveryCodes);
    const existing = await this.find2FASettingsByUserId(params.userId);

    if (existing) {
      await this.db.query(
        `UPDATE user_two_factor_auth
         SET secret = $1, recovery_codes = $2::jsonb, is_enabled = FALSE, updated_at = CURRENT_TIMESTAMP
         WHERE user_id = $3`,
        [params.secret, codesJson, params.userId],
      );
    } else {
      await this.db.query(
        `INSERT INTO user_two_factor_auth (id, user_id, secret, is_enabled, recovery_codes)
         VALUES ($1, $2, $3, FALSE, $4::jsonb)`,
        [id, params.userId, params.secret, codesJson],
      );
    }

    const updated = await this.find2FASettingsByUserId(params.userId);
    if (!updated) throw new Error('Failed to save 2FA setup');
    return updated;
  }

  async enable2FA(userId: string): Promise<boolean> {
    const res = await this.db.query(
      `UPDATE user_two_factor_auth
       SET is_enabled = TRUE, updated_at = CURRENT_TIMESTAMP
       WHERE user_id = $1`,
      [userId],
    );
    return (res.rowCount ?? 0) > 0;
  }

  async disable2FA(userId: string): Promise<boolean> {
    const res = await this.db.query(
      `DELETE FROM user_two_factor_auth WHERE user_id = $1`,
      [userId],
    );
    return (res.rowCount ?? 0) > 0;
  }

  async consumeRecoveryCode(userId: string, codeHash: string): Promise<boolean> {
    const settings = await this.find2FASettingsByUserId(userId);
    if (!settings || !settings.is_enabled) return false;

    const codeIdx = settings.recovery_codes.indexOf(codeHash);
    if (codeIdx === -1) return false;

    const remainingCodes = [...settings.recovery_codes];
    remainingCodes.splice(codeIdx, 1);

    await this.db.query(
      `UPDATE user_two_factor_auth
       SET recovery_codes = $1::jsonb, updated_at = CURRENT_TIMESTAMP
       WHERE user_id = $2`,
      [JSON.stringify(remainingCodes), userId],
    );

    return true;
  }
}

export interface UserTwoFactorAuthRow {
  id: string;
  user_id: string;
  secret: string;
  is_enabled: boolean;
  recovery_codes: string[];
  created_at: string;
  updated_at: string;
}

