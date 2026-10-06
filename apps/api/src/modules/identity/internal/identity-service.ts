import type { DatabaseConnection } from '../../../infra/database/connection.js';
import type { Logger } from '../../../observability/logger.js';
import { IdentityRepository, hashVerificationToken } from './identity-repository.js';
import { ScryptPasswordHasher } from './password-hasher.js';
import { HmacTokenService } from './token-service.js';
import { SecurityAuditService } from './security-audit-service.js';
import type { AuthorizedActor } from '../rbac/policy.js';
import {
  ValidationError,
  UnauthorizedError,
  EmailNotVerifiedError,
  ConflictError,
  NotFoundError,
} from '../../../errors/app-error.js';
import { randomBytes } from 'node:crypto';

export interface RegisterInput {
  email: string;
  password: string;
  tenantName: string;
  role: 'MERCHANT' | 'CUSTOMER';
}

export interface AuthTokenPair {
  accessToken: string;
  accessTokenExpiresAt: Date;
  refreshToken: string;
  refreshTokenExpiresAt: Date;
}

export interface LoginInput {
  email: string;
  password: string;
}

export interface AuthRequestContext {
  ip?: string | undefined;
  userAgent?: string | undefined;
}

export interface AuthenticatedIdentity {
  userId: string;
  email: string;
  tenantId: string;
  role: string;
}

export class IdentityService {
  private readonly db: DatabaseConnection;
  private readonly repo: IdentityRepository;
  private readonly hasher: ScryptPasswordHasher;
  private readonly tokenService: HmacTokenService;
  private readonly audit: SecurityAuditService;

  static readonly VERIFICATION_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

  constructor(
    db: DatabaseConnection,
    logger: Logger,
    tokenSecret: string,
  ) {
    this.db = db;
    this.repo = new IdentityRepository(db);
    this.hasher = new ScryptPasswordHasher();
    this.tokenService = new HmacTokenService({ accessTokenSecret: tokenSecret });
    this.audit = new SecurityAuditService(db, logger);
  }

  async register(input: RegisterInput): Promise<{ userId: string; email: string; tenantId: string; role: string }> {
    if (!input.email || !input.email.includes('@')) {
      throw new ValidationError('Invalid email address');
    }
    if (!input.password || input.password.length < 8) {
      throw new ValidationError('Password must be at least 8 characters');
    }

    const existing = await this.repo.findUserByEmail(input.email);
    if (existing) {
      throw new ConflictError('An account with this email already exists');
    }

    const passwordHash = await this.hasher.hash(input.password);

    const { user, tenant } = await this.registerInDb(input, passwordHash);
    return { userId: user.id, email: input.email.toLowerCase(), tenantId: tenant.id, role: input.role };
  }

  private async registerInDb(
    input: RegisterInput,
    passwordHash: string,
  ): Promise<{
    user: { id: string };
    tenant: { id: string };
  }> {
    const user = await this.repo.createUser({
      email: input.email,
      passwordHash,
    });

    const tenantType = input.role === 'MERCHANT' ? 'MERCHANT' : 'CUSTOMER';
    const tenant = await this.repo.createTenant({
      type: tenantType,
      name: input.tenantName,
    });

    await this.repo.createMembership({
      tenantId: tenant.id,
      userId: user.id,
      role: input.role,
    });

    // No session is issued at signup: the account must verify its email first.
    return { user, tenant };
  }

  /**
   * Issues a fresh email-verification token for a user (invalidating older ones).
   * Returns the raw token — the caller delivers it to the user's inbox.
   */
  async createEmailVerificationToken(userId: string): Promise<string> {
    const user = await this.repo.findUserById(userId);
    if (!user) throw new NotFoundError('User not found');

    const rawToken = randomBytes(32).toString('hex');
    await this.repo.deleteVerificationTokensForUser(userId);
    await this.repo.createVerificationToken(
      userId,
      hashVerificationToken(rawToken),
      new Date(Date.now() + IdentityService.VERIFICATION_TOKEN_TTL_MS),
    );
    return rawToken;
  }

  async verifyEmail(rawToken: string): Promise<{ userId: string; email: string }> {
    if (!rawToken || typeof rawToken !== 'string') {
      throw new ValidationError('Verification token is required');
    }
    const record = await this.repo.findValidVerificationToken(hashVerificationToken(rawToken.trim()));
    if (!record) {
      throw new ValidationError('Verification link is invalid or has expired');
    }
    const user = await this.repo.findUserById(record.user_id);
    if (!user || user.status !== 'ACTIVE') {
      throw new ValidationError('Verification link is invalid or has expired');
    }
    await this.repo.markUserEmailVerified(user.id);
    await this.repo.consumeVerificationToken(record.id);
    await this.repo.deleteVerificationTokensForUser(user.id);
    await this.audit.record({
      eventType: 'EMAIL_VERIFIED',
      actorId: user.id,
      metadata: {},
    });
    return { userId: user.id, email: user.email };
  }

  /**
   * Starts (or restarts) verification for an email address.
   * Returns the raw token, or null when there is nothing to send
   * (unknown address or already verified) — callers must not reveal which.
   */
  async beginEmailVerification(email: string): Promise<{ rawToken: string; email: string } | null> {
    const user = await this.repo.findUserByEmail(email);
    if (!user || user.status !== 'ACTIVE' || user.email_verified_at) {
      return null;
    }
    const rawToken = await this.createEmailVerificationToken(user.id);
    return { rawToken, email: user.email };
  }

  async login(input: LoginInput, context?: AuthRequestContext | undefined): Promise<AuthTokenPair> {
    // Generic delay-compatible failure path to prevent timing oracle attacks
    const genericFailure = async () => {
      // always run hash to avoid timing leaks
      await this.hasher.hash('dummy_prevention_password');
      await this.audit.record({
        eventType: 'LOGIN_FAILURE',
        ipAddress: context?.ip,
        userAgent: context?.userAgent,
        metadata: { reason: 'invalid_credentials' },
      });
      throw new UnauthorizedError('Invalid credentials');
    };

    const user = await this.repo.findUserByEmail(input.email);
    if (!user || user.status !== 'ACTIVE') {
      await genericFailure();
      throw new UnauthorizedError('Invalid credentials'); // unreachable but TS happy
    }

    const valid = await this.hasher.verify(input.password, user.password_hash);
    if (!valid) {
      await genericFailure();
      throw new UnauthorizedError('Invalid credentials');
    }

    // Email must be verified before password login is allowed. Checked only
    // after a correct password so invalid credentials reveal nothing new.
    if (!user.email_verified_at) {
      await this.audit.record({
        eventType: 'LOGIN_FAILURE',
        actorId: user.id,
        ipAddress: context?.ip,
        userAgent: context?.userAgent,
        metadata: { reason: 'email_not_verified' },
      });
      throw new EmailNotVerifiedError('Email address has not been verified. Check your inbox for the verification link.');
    }

    const membership = await this.repo.findActiveMembershipByUserId(user.id);
    if (!membership) {
      throw new UnauthorizedError('Invalid credentials');
    }

    const tokens = await this.issueTokenPair(user.id, membership.tenant_id, membership.role);

    await this.audit.record({
      eventType: 'LOGIN_SUCCESS',
      actorId: user.id,
      tenantId: membership.tenant_id,
      ipAddress: context?.ip,
      userAgent: context?.userAgent,
    });

    return tokens;
  }

  async refresh(rawRefreshToken: string, context?: AuthRequestContext | undefined): Promise<AuthTokenPair> {
    const tokenHash = this.tokenService.hashToken(rawRefreshToken);

    // Reuse evidence is captured inside the transaction but acted upon
    // OUTSIDE it: the throw below rolls the transaction back, which must
    // not undo the family revocation (otherwise reuse would be detected,
    // logged, but never enforced).
    let reuseEvidence: { userId: string; tenantId: string; familyId: string; reason?: string } | null =
      null;

    try {
      return await this.db.withTransaction(async (tx) => {
        const txRepo = new IdentityRepository(tx);
        const record = await txRepo.findRefreshTokenByHash(tokenHash);

        if (!record) {
          throw new UnauthorizedError('Invalid refresh token');
        }

        // Reuse detection: token already rotated = potential theft
        if (record.is_rotated) {
          reuseEvidence = {
            userId: record.user_id,
            tenantId: record.tenant_id,
            familyId: record.family_id,
          };
          throw new UnauthorizedError('Refresh token has been revoked');
        }

        if (record.is_revoked) {
          throw new UnauthorizedError('Refresh token has been revoked');
        }

        if (new Date(record.expires_at) < new Date()) {
          throw new UnauthorizedError('Refresh token has expired');
        }

        // Atomic conditional rotation: only one concurrent caller succeeds
        const rotated = await txRepo.rotateRefreshTokenAtomic(record.id);
        if (!rotated) {
          // Concurrently rotated: trigger family reuse revocation
          reuseEvidence = {
            userId: record.user_id,
            tenantId: record.tenant_id,
            familyId: record.family_id,
            reason: 'concurrent_race_condition',
          };
          throw new UnauthorizedError('Refresh token has been revoked');
        }

        const membership = await txRepo.findMembershipByUserAndTenant(
          record.user_id,
          record.tenant_id,
        );
        if (!membership || membership.status !== 'ACTIVE') {
          throw new UnauthorizedError('Session is no longer valid');
        }

        const accessToken = this.tokenService.generateAccessToken({
          userId: record.user_id,
          tenantId: record.tenant_id,
          role: membership.role,
        });
        const newRefreshToken = this.tokenService.generateRefreshToken(record.family_id);

        await txRepo.saveRefreshToken({
          id: newRefreshToken.id,
          userId: record.user_id,
          tenantId: record.tenant_id,
          familyId: newRefreshToken.familyId,
          tokenHash: newRefreshToken.tokenHash,
          expiresAt: newRefreshToken.expiresAt,
        });

        await this.audit.record({
          eventType: 'REFRESH_TOKEN_ROTATED',
          actorId: record.user_id,
          tenantId: record.tenant_id,
        });

        return {
          accessToken: accessToken.token,
          accessTokenExpiresAt: accessToken.expiresAt,
          refreshToken: newRefreshToken.rawToken,
          refreshTokenExpiresAt: newRefreshToken.expiresAt,
        };
      });
    } catch (err) {
      // NOTE: reuseEvidence is only ever set on paths that throw, so the
      // declared type narrows to never here — read it through an explicit type.
      const evidence = reuseEvidence as unknown as {
        userId: string;
        tenantId: string;
        familyId: string;
        reason?: string | undefined;
      } | null;
      if (evidence) {
        await this.repo.revokeTokenFamily(evidence.familyId);
        await this.audit.record({
          eventType: 'REFRESH_TOKEN_REUSE_DETECTED',
          actorId: evidence.userId,
          tenantId: evidence.tenantId,
          ipAddress: context?.ip,
          metadata: { familyId: evidence.familyId, ...(evidence.reason ? { reason: evidence.reason } : {}) },
        });
        await this.audit.record({
          eventType: 'REFRESH_TOKEN_FAMILY_REVOKED',
          actorId: evidence.userId,
          tenantId: evidence.tenantId,
          metadata: { familyId: evidence.familyId },
        });
      }
      throw err;
    }
  }

  async logout(rawRefreshToken: string): Promise<void> {
    const tokenHash = this.tokenService.hashToken(rawRefreshToken);
    const record = await this.repo.findRefreshTokenByHash(tokenHash);
    if (record) {
      await this.repo.revokeAllUserTokensInTenant(record.user_id, record.tenant_id);
      await this.audit.record({
        eventType: 'LOGOUT',
        actorId: record.user_id,
        tenantId: record.tenant_id,
      });
    }
  }

  verifyAccessToken(token: string): AuthorizedActor | null {
    const payload = this.tokenService.verifyAccessToken(token);
    if (!payload) return null;

    const role = payload.role as 'ADMINISTRATOR' | 'MERCHANT' | 'CUSTOMER';
    return {
      userId: payload.userId,
      tenantId: payload.tenantId,
      role,
    };
  }

  async resolveActiveActor(token: string): Promise<AuthorizedActor | null> {
    const rawActor = this.verifyAccessToken(token);
    if (!rawActor) return null;

    const activeInfo = await this.repo.findActiveUserAndMembership(
      rawActor.userId,
      rawActor.tenantId,
    );
    if (!activeInfo) {
      throw new UnauthorizedError('Invalid credentials or revoked access');
    }

    if (activeInfo.userStatus !== 'ACTIVE') {
      throw new UnauthorizedError('User account is locked or deactivated');
    }

    if (activeInfo.tenantStatus !== 'ACTIVE') {
      throw new UnauthorizedError('Tenant is inactive');
    }

    if (activeInfo.membershipStatus !== 'ACTIVE') {
      throw new UnauthorizedError('Tenant membership is inactive');
    }

    // Dynamic resolution guarantees fresh server-side role without reliance on stale token claims
    return {
      userId: rawActor.userId,
      tenantId: rawActor.tenantId,
      role: activeInfo.currentRole as 'ADMINISTRATOR' | 'MERCHANT' | 'CUSTOMER',
    };
  }

  async getIdentity(userId: string): Promise<AuthenticatedIdentity | null> {
    const user = await this.repo.findUserById(userId);
    if (!user) return null;
    const membership = await this.repo.findActiveMembershipByUserId(userId);
    if (!membership) return null;
    return {
      userId: user.id,
      email: user.email,
      tenantId: membership.tenant_id,
      role: membership.role,
    };
  }

  private async issueTokenPair(
    userId: string,
    tenantId: string,
    role: string,
    existingFamilyId?: string,
  ): Promise<AuthTokenPair> {
    const accessToken = this.tokenService.generateAccessToken({ userId, tenantId, role });
    const refreshToken = this.tokenService.generateRefreshToken(existingFamilyId);

    await this.repo.saveRefreshToken({
      id: refreshToken.id,
      userId,
      tenantId,
      familyId: refreshToken.familyId,
      tokenHash: refreshToken.tokenHash,
      expiresAt: refreshToken.expiresAt,
    });

    return {
      accessToken: accessToken.token,
      accessTokenExpiresAt: accessToken.expiresAt,
      refreshToken: refreshToken.rawToken,
      refreshTokenExpiresAt: refreshToken.expiresAt,
    };
  }
}
