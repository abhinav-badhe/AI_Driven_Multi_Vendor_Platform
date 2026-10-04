import { randomUUID } from 'node:crypto';
import type { DatabaseConnection } from '../../../infra/database/connection.js';

export type MerchantVerificationStatus =
  | 'DRAFT'
  | 'SUBMITTED'
  | 'VERIFIED'
  | 'REJECTED'
  | 'SUSPENDED';

export interface MerchantProfileRow {
  id: string;
  tenant_id: string;
  business_name: string;
  legal_name: string;
  contact_email: string;
  verification_status: MerchantVerificationStatus;
  rejection_reason: string | null;
  verified_at: string | null;
  verified_by: string | null;
  created_at: string;
  updated_at: string;
}

export class MerchantRepository {
  constructor(private readonly db: DatabaseConnection) {}

  async create(params: {
    tenantId: string;
    businessName: string;
    legalName: string;
    contactEmail: string;
  }): Promise<MerchantProfileRow> {
    const id = randomUUID();
    const result = await this.db.query<MerchantProfileRow>(
      `INSERT INTO merchant_profiles
         (id, tenant_id, business_name, legal_name, contact_email, verification_status)
       VALUES ($1, $2, $3, $4, $5, 'DRAFT')
       RETURNING *`,
      [id, params.tenantId, params.businessName, params.legalName, params.contactEmail],
    );
    const row = result.rows[0];
    if (!row) throw new Error('Failed to create merchant profile');
    return row;
  }

  async findByTenantId(tenantId: string): Promise<MerchantProfileRow | null> {
    const result = await this.db.query<MerchantProfileRow>(
      `SELECT * FROM merchant_profiles WHERE tenant_id = $1`,
      [tenantId],
    );
    return result.rows[0] ?? null;
  }

  async updateProfile(
    id: string,
    params: {
      businessName?: string | undefined;
      legalName?: string | undefined;
      contactEmail?: string | undefined;
    },
  ): Promise<MerchantProfileRow> {
    const result = await this.db.query<MerchantProfileRow>(
      `UPDATE merchant_profiles
       SET business_name = COALESCE($2, business_name),
           legal_name = COALESCE($3, legal_name),
           contact_email = COALESCE($4, contact_email),
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $1
       RETURNING *`,
      [id, params.businessName ?? null, params.legalName ?? null, params.contactEmail ?? null],
    );
    const row = result.rows[0];
    if (!row) throw new Error('Merchant profile not found');
    return row;
  }

  async transitionStatus(
    id: string,
    status: MerchantVerificationStatus,
    options?: { verifiedBy?: string; rejectionReason?: string },
  ): Promise<MerchantProfileRow> {
    const verifiedAtClause = status === 'VERIFIED' ? 'CURRENT_TIMESTAMP' : 'verified_at';
    const result = await this.db.query<MerchantProfileRow>(
      `UPDATE merchant_profiles
       SET verification_status = $2,
           verified_by = $3,
           verified_at = ${verifiedAtClause},
           rejection_reason = $4,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $1
       RETURNING *`,
      [id, status, options?.verifiedBy ?? null, options?.rejectionReason ?? null],
    );
    const row = result.rows[0];
    if (!row) throw new Error('Merchant profile not found');
    return row;
  }
}
