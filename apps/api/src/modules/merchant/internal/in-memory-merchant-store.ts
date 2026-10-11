import type { AuthorizedActor } from '../../identity/rbac/policy.js';
import { RbacPolicy } from '../../identity/rbac/policy.js';
import type {
  MerchantProfileDto,
  OnboardMerchantInput,
  UpdateMerchantProfileInput,
  MerchantVerificationStatus,
  IMerchantService,
} from './merchant-models.js';
import {
  NotFoundError,
  ForbiddenError,
  ValidationError,
  ConflictError,
} from '../../../errors/app-error.js';

const ALLOWED_TRANSITIONS: Record<MerchantVerificationStatus, MerchantVerificationStatus[]> = {
  DRAFT: ['SUBMITTED'],
  SUBMITTED: ['VERIFIED', 'REJECTED'],
  VERIFIED: ['SUSPENDED'],
  REJECTED: ['SUBMITTED'],
  SUSPENDED: ['VERIFIED'],
};

/**
 * InMemoryMerchantStore - Fast zero-DB in-memory implementation of IMerchantService.
 * Used for unit testing and offline/circuit-breaker fallback.
 */
export class InMemoryMerchantStore implements IMerchantService {
  private readonly profilesByTenant = new Map<string, MerchantProfileDto>();

  seedProfile(profile: MerchantProfileDto): void {
    this.profilesByTenant.set(profile.tenantId, { ...profile });
  }

  clear(): void {
    this.profilesByTenant.clear();
  }

  async onboard(actor: AuthorizedActor, input: OnboardMerchantInput): Promise<MerchantProfileDto> {
    RbacPolicy.requirePermission(actor, 'merchant:onboard');

    if (!input.businessName?.trim()) throw new ValidationError('Business name is required');
    if (!input.legalName?.trim()) throw new ValidationError('Legal name is required');
    if (!input.contactEmail?.includes('@')) throw new ValidationError('Valid contact email is required');

    if (this.profilesByTenant.has(actor.tenantId)) {
      throw new ConflictError('Merchant profile already exists for this tenant');
    }

    const now = new Date().toISOString();
    const profile: MerchantProfileDto = {
      id: `merchant-${Math.random().toString(36).substring(2, 9)}`,
      tenantId: actor.tenantId,
      businessName: input.businessName.trim(),
      legalName: input.legalName.trim(),
      contactEmail: input.contactEmail.toLowerCase().trim(),
      verificationStatus: 'DRAFT',
      createdAt: now,
      updatedAt: now,
    };

    this.profilesByTenant.set(actor.tenantId, profile);
    return { ...profile };
  }

  async getProfile(actor: AuthorizedActor): Promise<MerchantProfileDto> {
    RbacPolicy.requirePermission(actor, 'merchant:read-own');

    const profile = this.profilesByTenant.get(actor.tenantId);
    if (!profile) throw new NotFoundError('Merchant profile not found');

    RbacPolicy.requireTenantMatch(actor, profile.tenantId);
    return { ...profile };
  }

  async getProfileByTenantId(tenantId: string): Promise<MerchantProfileDto | null> {
    const profile = this.profilesByTenant.get(tenantId);
    return profile ? { ...profile } : null;
  }

  async updateProfile(
    actor: AuthorizedActor,
    updates: UpdateMerchantProfileInput,
  ): Promise<MerchantProfileDto> {
    RbacPolicy.requirePermission(actor, 'merchant:update-own');

    const profile = this.profilesByTenant.get(actor.tenantId);
    if (!profile) throw new NotFoundError('Merchant profile not found');

    RbacPolicy.requireTenantMatch(actor, profile.tenantId);

    if (profile.verificationStatus === 'VERIFIED' || profile.verificationStatus === 'SUSPENDED') {
      throw new ForbiddenError('Cannot update a verified or suspended merchant profile');
    }

    const updated: MerchantProfileDto = {
      ...profile,
      businessName: updates.businessName?.trim() || profile.businessName,
      legalName: updates.legalName?.trim() || profile.legalName,
      contactEmail: updates.contactEmail?.toLowerCase().trim() || profile.contactEmail,
      updatedAt: new Date().toISOString(),
    };

    this.profilesByTenant.set(actor.tenantId, updated);
    return { ...updated };
  }

  async submitForVerification(actor: AuthorizedActor): Promise<MerchantProfileDto> {
    RbacPolicy.requirePermission(actor, 'merchant:submit-for-verification');

    const profile = this.profilesByTenant.get(actor.tenantId);
    if (!profile) throw new NotFoundError('Merchant profile not found');

    RbacPolicy.requireTenantMatch(actor, profile.tenantId);
    this.assertTransitionAllowed(profile.verificationStatus, 'SUBMITTED');

    const updated: MerchantProfileDto = {
      ...profile,
      verificationStatus: 'SUBMITTED',
      updatedAt: new Date().toISOString(),
    };

    this.profilesByTenant.set(actor.tenantId, updated);
    return { ...updated };
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

    const profile = this.profilesByTenant.get(targetTenantId);
    if (!profile) throw new NotFoundError('Merchant profile not found');

    this.assertTransitionAllowed(profile.verificationStatus, 'VERIFIED');

    const now = new Date().toISOString();
    const updated: MerchantProfileDto = {
      ...profile,
      verificationStatus: 'VERIFIED',
      verifiedAt: now,
      updatedAt: now,
    };

    this.profilesByTenant.set(targetTenantId, updated);
    return { ...updated };
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

    const profile = this.profilesByTenant.get(targetTenantId);
    if (!profile) throw new NotFoundError('Merchant profile not found');

    this.assertTransitionAllowed(profile.verificationStatus, 'REJECTED');

    const updated: MerchantProfileDto = {
      ...profile,
      verificationStatus: 'REJECTED',
      rejectionReason: reason.trim(),
      updatedAt: new Date().toISOString(),
    };

    this.profilesByTenant.set(targetTenantId, updated);
    return { ...updated };
  }

  async listMerchants(actor: AuthorizedActor): Promise<MerchantProfileDto[]> {
    if (actor.role !== 'ADMINISTRATOR') {
      RbacPolicy.requirePermission(actor, 'merchant:verify');
    }
    return Array.from(this.profilesByTenant.values()).sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );
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
}
