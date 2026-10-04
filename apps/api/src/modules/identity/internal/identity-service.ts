import type { DatabaseConnection } from '../../../infra/database/connection.js';
import type { Logger } from '../../../observability/logger.js';
import { IdentityRepository } from './identity-repository.js';
import { ScryptPasswordHasher } from './password-hasher.js';
import { HmacTokenService } from './token-service.js';
import { SecurityAuditService } from './security-audit-service.js';
import type { AuthorizedActor } from '../rbac/policy.js';
import {
  ValidationError,
  UnauthorizedError,
  ConflictError,
} from '../../../errors/app-error.js';

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

  async register(input: RegisterInput): Promise<AuthTokenPair> {
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

    const { tokens } = await this.registerInDb(input, passwordHash);
    return tokens;
  }

  private async registerInDb(
    input: RegisterInput,
    passwordHash: string,
  ): Promise<{
    user: { id: string };
    tenant: { id: string };
    tokens: AuthTokenPair;
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

    const tokens = await this.issueTokenPair(user.id, tenant.id, input.role);

    return { user, tenant, tokens };
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

    return await this.db.withTransaction(async (tx) => {
      const txRepo = new IdentityRepository(tx);
      const record = await txRepo.findRefreshTokenByHash(tokenHash);

      if (!record) {
        throw new UnauthorizedError('Invalid refresh token');
      }

      // Reuse detection: token already rotated = potential theft
      if (record.is_rotated) {
        await txRepo.revokeTokenFamily(record.family_id);
        await this.audit.record({
          eventType: 'REFRESH_TOKEN_REUSE_DETECTED',
          actorId: record.user_id,
          tenantId: record.tenant_id,
          ipAddress: context?.ip,
          metadata: { familyId: record.family_id },
        });
        await this.audit.record({
          eventType: 'REFRESH_TOKEN_FAMILY_REVOKED',
          actorId: record.user_id,
          tenantId: record.tenant_id,
          metadata: { familyId: record.family_id },
        });
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
        await txRepo.revokeTokenFamily(record.family_id);
        await this.audit.record({
          eventType: 'REFRESH_TOKEN_REUSE_DETECTED',
          actorId: record.user_id,
          tenantId: record.tenant_id,
          ipAddress: context?.ip,
          metadata: { familyId: record.family_id, reason: 'concurrent_race_condition' },
        });
        await this.audit.record({
          eventType: 'REFRESH_TOKEN_FAMILY_REVOKED',
          actorId: record.user_id,
          tenantId: record.tenant_id,
          metadata: { familyId: record.family_id, reason: 'concurrent_race_condition' },
        });
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
