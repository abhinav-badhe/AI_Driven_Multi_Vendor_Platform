import type { AuthorizedActor } from '../../identity/rbac/policy.js';
import type { MerchantVerificationStatus } from './merchant-repository.js';

export type { MerchantVerificationStatus };

export interface MerchantProfileDto {
  id: string;
  tenantId: string;
  businessName: string;
  legalName: string;
  contactEmail: string;
  verificationStatus: MerchantVerificationStatus;
  rejectionReason?: string;
  verifiedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface OnboardMerchantInput {
  businessName: string;
  legalName: string;
  contactEmail: string;
}

export interface UpdateMerchantProfileInput {
  businessName?: string | undefined;
  legalName?: string | undefined;
  contactEmail?: string | undefined;
}

/**
 * IMerchantProfileReader - Decoupled read interface for merchant profiles.
 * Consumed by Marketplace (ListingService) and Search (SearchService).
 */
export interface IMerchantProfileReader {
  getProfileByTenantId(tenantId: string): Promise<MerchantProfileDto | null>;
}

/**
 * IMerchantService - Full merchant lifecycle and profile management interface.
 * Implemented by local SQL MerchantService, InMemoryMerchantStore, and HttpMerchantClient.
 */
export interface IMerchantService extends IMerchantProfileReader {
  onboard(actor: AuthorizedActor, input: OnboardMerchantInput): Promise<MerchantProfileDto>;
  getProfile(actor: AuthorizedActor): Promise<MerchantProfileDto>;
  getProfileByTenantId(tenantId: string): Promise<MerchantProfileDto | null>;
  updateProfile(
    actor: AuthorizedActor,
    updates: UpdateMerchantProfileInput,
  ): Promise<MerchantProfileDto>;
  submitForVerification(actor: AuthorizedActor): Promise<MerchantProfileDto>;
  approveMerchant(actor: AuthorizedActor, targetTenantId: string): Promise<MerchantProfileDto>;
  rejectMerchant(
    actor: AuthorizedActor,
    targetTenantId: string,
    reason: string,
  ): Promise<MerchantProfileDto>;
  listMerchants(actor: AuthorizedActor): Promise<MerchantProfileDto[]>;
}
