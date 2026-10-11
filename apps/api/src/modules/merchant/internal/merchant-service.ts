import type { DatabaseConnection } from '../../../infra/database/connection.js';
import type { Logger } from '../../../observability/logger.js';
import type { AuthorizedActor } from '../../identity/index.js';
import { RbacPolicy, SecurityAuditService, type ISecurityAuditService } from '../../identity/index.js';
import { MerchantRepository } from './merchant-repository.js';
import type { MerchantVerificationStatus } from './merchant-repository.js';
import {
  NotFoundError,
  ForbiddenError,
  ValidationError,
  ConflictError,
} from '../../../errors/app-error.js';

// Domain-controlled valid state transitions
const ALLOWED_TRANSITIONS: Record<MerchantVerificationStatus, MerchantVerificationStatus[]> = {
  DRAFT: ['SUBMITTED'],
  SUBMITTED: ['VERIFIED', 'REJECTED'],
  VERIFIED: ['SUSPENDED'],
  REJECTED: ['SUBMITTED'],
  SUSPENDED: ['VERIFIED'],
};

import type {
  MerchantProfileDto,
  OnboardMerchantInput,
  UpdateMerchantProfileInput,
  IMerchantService,
} from './merchant-models.js';

export type { MerchantProfileDto, OnboardMerchantInput, UpdateMerchantProfileInput };

export class MerchantService implements IMerchantService {
  private readonly repo: MerchantRepository;
  private readonly audit: ISecurityAuditService;

  constructor(
    db: DatabaseConnection,
    logger: Logger,
    audit?: ISecurityAuditService,
  ) {
    this.repo = new MerchantRepository(db);
    this.audit = audit ?? new SecurityAuditService(db, logger);
  }

  async onboard(actor: AuthorizedActor, input: OnboardMerchantInput): Promise<MerchantProfileDto> {
    RbacPolicy.requirePermission(actor, 'merchant:onboard');

    if (!input.businessName?.trim()) throw new ValidationError('Business name is required');
    if (!input.legalName?.trim()) throw new ValidationError('Legal name is required');
    if (!input.contactEmail?.includes('@')) throw new ValidationError('Valid contact email is required');

    const existing = await this.repo.findByTenantId(actor.tenantId);
    if (existing) {
      throw new ConflictError('Merchant profile already exists for this tenant');
    }

    const profile = await this.repo.create({
      tenantId: actor.tenantId,
      businessName: input.businessName.trim(),
      legalName: input.legalName.trim(),
      contactEmail: input.contactEmail.toLowerCase().trim(),
    });

    return this.toDto(profile);
  }

  async getProfile(actor: AuthorizedActor): Promise<MerchantProfileDto> {
    RbacPolicy.requirePermission(actor, 'merchant:read-own');

    const profile = await this.repo.findByTenantId(actor.tenantId);
    if (!profile) throw new NotFoundError('Merchant profile not found');

    // Enforce tenant isolation: only own tenant data
    RbacPolicy.requireTenantMatch(actor, profile.tenant_id);

    return this.toDto(profile);
  }

  async getProfileByTenantId(tenantId: string): Promise<MerchantProfileDto | null> {
    const profile = await this.repo.findByTenantId(tenantId);
    if (!profile) return null;
    return this.toDto(profile);
  }

  async updateProfile(
    actor: AuthorizedActor,
    updates: UpdateMerchantProfileInput,
  ): Promise<MerchantProfileDto> {
    RbacPolicy.requirePermission(actor, 'merchant:update-own');

    const profile = await this.repo.findByTenantId(actor.tenantId);
    if (!profile) throw new NotFoundError('Merchant profile not found');

    RbacPolicy.requireTenantMatch(actor, profile.tenant_id);

    if (profile.verification_status === 'VERIFIED' || profile.verification_status === 'SUSPENDED') {
      throw new ForbiddenError('Cannot update a verified or suspended merchant profile');
    }

    const updated = await this.repo.updateProfile(profile.id, {
      businessName: updates.businessName,
      legalName: updates.legalName,
      contactEmail: updates.contactEmail,
    });

    return this.toDto(updated);
  }

  async submitForVerification(actor: AuthorizedActor): Promise<MerchantProfileDto> {
    RbacPolicy.requirePermission(actor, 'merchant:submit-for-verification');

    const profile = await this.repo.findByTenantId(actor.tenantId);
    if (!profile) throw new NotFoundError('Merchant profile not found');

    RbacPolicy.requireTenantMatch(actor, profile.tenant_id);

    this.assertTransitionAllowed(profile.verification_status, 'SUBMITTED');

    const updated = await this.repo.transitionStatus(profile.id, 'SUBMITTED');
    return this.toDto(updated);
  }

  async approveMerchant(
    actor: AuthorizedActor,
    targetTenantId: string,
  ): Promise<MerchantProfileDto> {
    RbacPolicy.requirePermission(actor, 'merchant:verify');

    if (actor.tenantId === targetTenantId) {
      throw new ForbiddenError(
        'Platform administrator cannot perform merchant verification on their own tenant',
      );
    }

    const profile = await this.repo.findByTenantId(targetTenantId);
    if (!profile) throw new NotFoundError('Merchant profile not found');

    this.assertTransitionAllowed(profile.verification_status, 'VERIFIED');

    const updated = await this.repo.transitionStatus(profile.id, 'VERIFIED', {
      verifiedBy: actor.userId,
    });

    await this.audit.record({
      eventType: 'MERCHANT_VERIFICATION_APPROVED',
      actorId: actor.userId,
      tenantId: targetTenantId,
      metadata: { merchantProfileId: profile.id },
    });

    return this.toDto(updated);
  }

  async rejectMerchant(
    actor: AuthorizedActor,
    targetTenantId: string,
    reason: string,
  ): Promise<MerchantProfileDto> {
    RbacPolicy.requirePermission(actor, 'merchant:reject');

    if (actor.tenantId === targetTenantId) {
      throw new ForbiddenError(
        'Platform administrator cannot perform merchant verification on their own tenant',
      );
    }

    if (!reason?.trim()) throw new ValidationError('Rejection reason is required');

    const profile = await this.repo.findByTenantId(targetTenantId);
    if (!profile) throw new NotFoundError('Merchant profile not found');

    this.assertTransitionAllowed(profile.verification_status, 'REJECTED');

    const updated = await this.repo.transitionStatus(profile.id, 'REJECTED', {
      verifiedBy: actor.userId,
      rejectionReason: reason.trim(),
    });

    await this.audit.record({
      eventType: 'MERCHANT_VERIFICATION_REJECTED',
      actorId: actor.userId,
      tenantId: targetTenantId,
      metadata: { merchantProfileId: profile.id, reason: reason.trim() },
    });

    return this.toDto(updated);
  }

  private assertTransitionAllowed(
    current: MerchantVerificationStatus,
    next: MerchantVerificationStatus,
  ): void {
    const allowed = ALLOWED_TRANSITIONS[current];
    if (!allowed.includes(next)) {
      throw new ForbiddenError(
        `Invalid state transition: cannot move from '${current}' to '${next}'`,
      );
    }
  }

  private toDto(row: {
    id: string;
    tenant_id: string;
    business_name: string;
    legal_name: string;
    contact_email: string;
    verification_status: MerchantVerificationStatus;
    rejection_reason: string | null;
    verified_at: string | null;
    created_at: string;
    updated_at: string;
  }): MerchantProfileDto {
    return {
      id: row.id,
      tenantId: row.tenant_id,
      businessName: row.business_name,
      legalName: row.legal_name,
      contactEmail: row.contact_email,
      verificationStatus: row.verification_status,
      ...(row.rejection_reason ? { rejectionReason: row.rejection_reason } : {}),
      ...(row.verified_at ? { verifiedAt: row.verified_at } : {}),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  async listMerchants(actor: AuthorizedActor): Promise<MerchantProfileDto[]> {
    if (actor.role !== 'ADMINISTRATOR') {
      RbacPolicy.requirePermission(actor, 'merchant:verify');
    }
    const rows = await this.repo.findAll();
    return rows.map((r) => this.toDto(r));
  }
}

