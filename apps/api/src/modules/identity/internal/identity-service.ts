import type { DatabaseConnection } from '../../../infra/database/connection.js';
import type { Logger } from '../../../observability/logger.js';
import { IdentityRepository, hashVerificationToken } from './identity-repository.js';
import { ScryptPasswordHasher } from './password-hasher.js';
import { HmacTokenService } from './token-service.js';
import { SecurityAuditService, type ISecurityAuditService } from './security-audit-service.js';
import { RbacPolicy, type AuthorizedActor } from '../rbac/policy.js';
import {
  ValidationError,
  UnauthorizedError,
  EmailNotVerifiedError,
  ConflictError,
  NotFoundError,
} from '../../../errors/app-error.js';
import { randomBytes } from 'node:crypto';
import type { IIdentityActorResolver } from './stateless-token-actor-resolver.js';
import {
  generateTotpSecret,
  verifyTotpCode,
  buildOtpAuthUri,
  generateRecoveryCodes,
  hashRecoveryCode,
} from './totp-service.js';

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

export interface LoginResult extends AuthTokenPair {
  requires2FA?: boolean;
  tempToken?: string;
}

export type LoginRequires2FAResult = LoginResult & { requires2FA: true; tempToken: string };

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

export class IdentityService implements IIdentityActorResolver {
  private readonly db: DatabaseConnection;
  private readonly repo: IdentityRepository;
  private readonly hasher: ScryptPasswordHasher;
  private readonly tokenService: HmacTokenService;
  private readonly audit: ISecurityAuditService;

  static readonly VERIFICATION_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

  constructor(
    db: DatabaseConnection,
    logger: Logger,
    tokenSecret: string,
    audit?: ISecurityAuditService,
  ) {
    this.db = db;
    this.repo = new IdentityRepository(db);
    this.hasher = new ScryptPasswordHasher();
    this.tokenService = new HmacTokenService({ accessTokenSecret: tokenSecret });
    this.audit = audit ?? new SecurityAuditService(db, logger);
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

  /**
   * Issues a fresh password reset token for a user (invalidating previous ones).
   */
  async createPasswordResetToken(userId: string): Promise<string> {
    const user = await this.repo.findUserById(userId);
    if (!user) throw new NotFoundError('User not found');

    const rawToken = randomBytes(32).toString('hex');
    await this.repo.deletePasswordResetTokensForUser(userId);
    await this.repo.createPasswordResetToken(
      userId,
      hashVerificationToken(rawToken),
      new Date(Date.now() + 60 * 60 * 1000), // 1 hour TTL
    );
    return rawToken;
  }

  /**
   * Initiates password reset for an email address.
   * Returns the raw token and email, or null if the user does not exist.
   * Always safe to return null to avoid email enumeration.
   */
  async beginPasswordReset(email: string): Promise<{ rawToken: string; email: string } | null> {
    const user = await this.repo.findUserByEmail(email);
    if (!user || user.status !== 'ACTIVE') {
      return null;
    }
    const rawToken = await this.createPasswordResetToken(user.id);
    return { rawToken, email: user.email };
  }

  /**
   * Consumes a password reset token and sets the new password.
   */
  async resetPassword(rawToken: string, newPassword: string): Promise<{ userId: string; email: string }> {
    if (!rawToken || typeof rawToken !== 'string') {
      throw new ValidationError('Reset token is required');
    }
    if (!newPassword || typeof newPassword !== 'string' || newPassword.length < 8) {
      throw new ValidationError('Password must be at least 8 characters');
    }

    const record = await this.repo.findValidPasswordResetToken(hashVerificationToken(rawToken.trim()));
    if (!record) {
      throw new ValidationError('Password reset link is invalid or has expired');
    }

    const user = await this.repo.findUserById(record.user_id);
    if (!user || user.status !== 'ACTIVE') {
      throw new ValidationError('User account is invalid or deactivated');
    }

    const newHash = await this.hasher.hash(newPassword);
    await this.repo.updateUserPassword(user.id, newHash);
    await this.repo.consumePasswordResetToken(record.id);
    await this.repo.deletePasswordResetTokensForUser(user.id);
    await this.repo.revokeAllUserTokens(user.id);

    await this.audit.record({
      eventType: 'PASSWORD_RESET_SUCCESS',
      actorId: user.id,
      metadata: {},
    });

    return { userId: user.id, email: user.email };
  }

  async login(input: LoginInput, context?: AuthRequestContext | undefined): Promise<LoginResult> {
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

    const userTwoFactor = await this.repo.find2FASettingsByUserId(user.id);
    if (userTwoFactor && userTwoFactor.is_enabled) {
      const tempToken = this.tokenService.generate2FATempToken({
        userId: user.id,
        tenantId: membership.tenant_id,
        role: membership.role,
      });
      await this.audit.record({
        eventType: 'LOGIN_2FA_CHALLENGE',
        actorId: user.id,
        tenantId: membership.tenant_id,
        ipAddress: context?.ip,
        userAgent: context?.userAgent,
      });
      return {
        requires2FA: true,
        tempToken,
        accessToken: '',
        refreshToken: '',
        accessTokenExpiresAt: new Date(0),
        refreshTokenExpiresAt: new Date(0),
      };
    }

    const tokens = await this.issueTokenPair(user.id, membership.tenant_id, membership.role);

    await this.audit.record({
      eventType: 'LOGIN_SUCCESS',
      actorId: user.id,
      tenantId: membership.tenant_id,
      ipAddress: context?.ip,
      userAgent: context?.userAgent,
    });

    return {
      ...tokens,
      requires2FA: false,
    };
  }

  async verify2FALogin(
    tempToken: string,
    codeOrRecoveryCode: string,
    context?: AuthRequestContext | undefined,
  ): Promise<AuthTokenPair> {
    const payload = this.tokenService.verify2FATempToken(tempToken);
    if (!payload) {
      throw new UnauthorizedError('Invalid or expired 2FA verification session. Please log in again.');
    }

    const user = await this.repo.findUserById(payload.userId);
    if (!user || user.status !== 'ACTIVE') {
      throw new UnauthorizedError('Invalid credentials');
    }

    const settings = await this.repo.find2FASettingsByUserId(payload.userId);
    if (!settings || !settings.is_enabled) {
      throw new UnauthorizedError('2FA is not enabled for this user');
    }

    const cleanInput = codeOrRecoveryCode.trim();
    let verified = false;
    let usedRecoveryCode = false;

    // Check TOTP 6-digit code
    if (/^\d{6}$/.test(cleanInput)) {
      verified = verifyTotpCode(settings.secret, cleanInput);
    }

    // If not verified with TOTP, check backup recovery code
    if (!verified) {
      const codeHash = hashRecoveryCode(cleanInput);
      const consumed = await this.repo.consumeRecoveryCode(payload.userId, codeHash);
      if (consumed) {
        verified = true;
        usedRecoveryCode = true;
      }
    }

    if (!verified) {
      await this.audit.record({
        eventType: 'LOGIN_2FA_FAILURE',
        actorId: payload.userId,
        tenantId: payload.tenantId,
        ipAddress: context?.ip,
        userAgent: context?.userAgent,
        metadata: { reason: 'invalid_code' },
      });
      throw new UnauthorizedError('Invalid verification code');
    }

    const tokens = await this.issueTokenPair(payload.userId, payload.tenantId, payload.role);

    await this.audit.record({
      eventType: 'LOGIN_SUCCESS',
      actorId: payload.userId,
      tenantId: payload.tenantId,
      ipAddress: context?.ip,
      userAgent: context?.userAgent,
      metadata: { method: usedRecoveryCode ? 'recovery_code' : 'totp' },
    });

    return tokens;
  }

  async get2FAStatus(userId: string): Promise<{ isEnabled: boolean }> {
    const settings = await this.repo.find2FASettingsByUserId(userId);
    return { isEnabled: Boolean(settings?.is_enabled) };
  }

  async setup2FA(userId: string, issuer = 'Commerce Platform'): Promise<{
    secret: string;
    otpAuthUri: string;
    recoveryCodes: string[];
  }> {
    const user = await this.repo.findUserById(userId);
    if (!user || user.status !== 'ACTIVE') {
      throw new NotFoundError('User not found');
    }

    const secret = generateTotpSecret();
    const { plaintextCodes, hashedCodes } = generateRecoveryCodes(10);
    const otpAuthUri = buildOtpAuthUri(secret, user.email, issuer);

    await this.repo.save2FASetup({
      userId,
      secret,
      recoveryCodes: hashedCodes,
    });

    return {
      secret,
      otpAuthUri,
      recoveryCodes: plaintextCodes,
    };
  }

  async enable2FA(userId: string, code: string): Promise<{ success: true }> {
    const settings = await this.repo.find2FASettingsByUserId(userId);
    if (!settings || !settings.secret) {
      throw new ValidationError('2FA setup has not been initiated. Please start setup first.');
    }

    const isValid = verifyTotpCode(settings.secret, code.trim());
    if (!isValid) {
      throw new ValidationError('Invalid verification code. Please check your authenticator app and try again.');
    }

    await this.repo.enable2FA(userId);
    await this.audit.record({
      eventType: '2FA_ENABLED',
      actorId: userId,
      metadata: {},
    });

    return { success: true };
  }

  async disable2FA(userId: string, passwordConfirm: string, code?: string): Promise<{ success: true }> {
    const user = await this.repo.findUserById(userId);
    if (!user || user.status !== 'ACTIVE') {
      throw new NotFoundError('User not found');
    }

    const passwordValid = await this.hasher.verify(passwordConfirm, user.password_hash);
    if (!passwordValid) {
      throw new UnauthorizedError('Incorrect password');
    }

    const settings = await this.repo.find2FASettingsByUserId(userId);
    if (!settings || !settings.is_enabled) {
      return { success: true };
    }

    if (code) {
      const codeValid = verifyTotpCode(settings.secret, code.trim());
      if (!codeValid) {
        throw new ValidationError('Invalid verification code');
      }
    }

    await this.repo.disable2FA(userId);
    await this.audit.record({
      eventType: '2FA_DISABLED',
      actorId: userId,
      metadata: {},
    });

    return { success: true };
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

  async listUsers(actor: AuthorizedActor): Promise<Array<{
    id: string;
    email: string;
    role: string;
    tenantId: string;
    createdAt: string;
    isActive: boolean;
  }>> {
    if (actor.role !== 'ADMINISTRATOR') {
      RbacPolicy.requirePermission(actor, 'admin:manage-users');
    }
    return this.repo.listAllUsers();
  }

  async getAuditLog(actor: AuthorizedActor): Promise<Array<{
    id: string;
    event: string;
    userId?: string;
    ip?: string;
    timestamp: string;
    severity: string;
  }>> {
    if (actor.role !== 'ADMINISTRATOR') {
      RbacPolicy.requirePermission(actor, 'admin:view-audit');
    }
    return this.repo.getAuditRecords();
  }
}

