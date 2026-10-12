export type PromotionDiscountType = 'PERCENTAGE' | 'FIXED_AMOUNT';
export type PromotionScope = 'ORDER' | 'PRODUCT' | 'CATEGORY';
export type PromotionStatus = 'ACTIVE' | 'INACTIVE' | 'ARCHIVED';
export type RedemptionStatus = 'RESERVED' | 'COMPLETED' | 'CANCELLED';

export interface PromotionRow {
  id: string;
  name: string;
  description: string | null;
  merchant_tenant_id: string | null;
  code: string | null;
  discount_type: PromotionDiscountType;
  discount_value: number;
  currency: string;
  scope: PromotionScope;
  target_ids: string[];
  min_order_amount: number;
  max_discount_amount: number | null;
  starts_at: Date;
  expires_at: Date | null;
  status: PromotionStatus;
  usage_limit_total: number | null;
  usage_limit_per_customer: number | null;
  current_usage_count: number;
  first_order_only: boolean;
  stackable: boolean;
  metadata: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
}

export interface CouponRedemptionRow {
  id: string;
  promotion_id: string;
  coupon_code: string | null;
  checkout_session_id: string;
  customer_order_id: string | null;
  customer_tenant_id: string;
  merchant_tenant_id: string | null;
  discount_amount: number;
  currency: string;
  status: RedemptionStatus;
  created_at: Date;
  updated_at: Date;
}

export interface PromotionDto {
  id: string;
  name: string;
  description?: string | null;
  merchantTenantId?: string | null;
  code?: string | null;
  discountType: PromotionDiscountType;
  discountValue: number;
  currency: string;
  scope: PromotionScope;
  targetIds: string[];
  minOrderAmount: number;
  maxDiscountAmount?: number | null;
  startsAt: string;
  expiresAt?: string | null;
  status: PromotionStatus;
  usageLimitTotal?: number | null;
  usageLimitPerCustomer?: number | null;
  currentUsageCount: number;
  firstOrderOnly: boolean;
  stackable: boolean;
  metadata?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface CreatePromotionInput {
  name: string;
  description?: string | null | undefined;
  merchantTenantId?: string | null | undefined;
  code?: string | null | undefined;
  discountType: PromotionDiscountType;
  discountValue: number;
  currency?: string | undefined;
  scope?: PromotionScope | undefined;
  targetIds?: string[] | undefined;
  minOrderAmount?: number | undefined;
  maxDiscountAmount?: number | null | undefined;
  startsAt: string | Date;
  expiresAt?: string | Date | null | undefined;
  status?: PromotionStatus | undefined;
  usageLimitTotal?: number | null | undefined;
  usageLimitPerCustomer?: number | null | undefined;
  firstOrderOnly?: boolean | undefined;
  stackable?: boolean | undefined;
  metadata?: Record<string, unknown> | undefined;
}

export interface UpdatePromotionInput {
  name?: string | undefined;
  description?: string | null | undefined;
  discountType?: PromotionDiscountType | undefined;
  discountValue?: number | undefined;
  currency?: string | undefined;
  scope?: PromotionScope | undefined;
  targetIds?: string[] | undefined;
  minOrderAmount?: number | undefined;
  maxDiscountAmount?: number | null | undefined;
  startsAt?: string | Date | undefined;
  expiresAt?: string | Date | null | undefined;
  status?: PromotionStatus | undefined;
  usageLimitTotal?: number | null | undefined;
  usageLimitPerCustomer?: number | null | undefined;
  firstOrderOnly?: boolean | undefined;
  stackable?: boolean | undefined;
  metadata?: Record<string, unknown> | undefined;
}

export interface CalculateDiscountItem {
  listingId: string;
  skuId: string;
  productId?: string | null;
  categoryId?: string | null;
  merchantTenantId: string;
  quantity: number;
  unitPriceAmount: number;
  lineTotalAmount: number;
}

export interface CalculateDiscountContext {
  customerTenantId: string;
  currency: string;
  now?: Date | undefined;
  isFirstOrder?: boolean | undefined;
  customerUsageCounts?: Map<string, number> | undefined;
}

export interface AppliedPromotionSnapshot {
  promotionId: string;
  code: string | null;
  name: string;
  discountType: PromotionDiscountType;
  discountValue: number;
  scope: PromotionScope;
  merchantTenantId: string | null;
  discountAmount: number;
  explanation: string;
}

export interface DiscountCalculationResult {
  appliedPromotions: AppliedPromotionSnapshot[];
  subtotalAmount: number;
  totalDiscountAmount: number;
  itemDiscounts: Array<{ listingId: string; discountAmount: number }>;
  merchantDiscounts: Record<string, number>;
  finalTotalAmount: number;
}

export interface ListPromotionsFilter {
  merchantTenantId?: string | undefined;
  includePlatform?: boolean | undefined;
  status?: PromotionStatus | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
}

export interface PreviewDiscountsInput {
  items: CalculateDiscountItem[];
  couponCode?: string | null | undefined;
  currency: string;
  now?: Date | undefined;
  isFirstOrder?: boolean | undefined;
}

export interface ApplyCouponResult {
  discountAmount: number;
  totalAmount: number;
  couponCode: string;
  appliedPromotions: AppliedPromotionSnapshot[];
}

export interface RemoveCouponResult {
  discountAmount: number;
  totalAmount: number;
  couponCode: null;
  appliedPromotions: [];
}

export interface FinalizeRedemptionInput {
  checkoutSessionId: string;
  customerOrderId: string;
  customerTenantId: string;
  actor: import('../../identity/rbac/policy.js').AuthorizedActor;
}

export interface ReverseRedemptionInput {
  checkoutSessionId: string;
  customerOrderId?: string | null | undefined;
  reason?: string | undefined;
}

/**
 * IPromotionPricingEngine - Clean architectural seam for promotions & pricing.
 * Allows synchronous database execution or remote microservice HTTP execution.
 */
export interface IPromotionPricingEngine {
  createPromotion(
    actor: import('../../identity/rbac/policy.js').AuthorizedActor,
    input: CreatePromotionInput,
  ): Promise<PromotionDto>;

  getPromotion(
    actor: import('../../identity/rbac/policy.js').AuthorizedActor,
    id: string,
  ): Promise<PromotionDto>;

  listPromotions(
    actor: import('../../identity/rbac/policy.js').AuthorizedActor,
    filter?: ListPromotionsFilter,
  ): Promise<PromotionDto[]>;

  updatePromotion(
    actor: import('../../identity/rbac/policy.js').AuthorizedActor,
    id: string,
    input: UpdatePromotionInput,
  ): Promise<PromotionDto>;

  previewDiscounts(
    actor: import('../../identity/rbac/policy.js').AuthorizedActor,
    input: PreviewDiscountsInput,
  ): Promise<DiscountCalculationResult>;

  applyCouponToCheckout(
    actor: import('../../identity/rbac/policy.js').AuthorizedActor,
    checkoutSessionId: string,
    couponCode: string,
  ): Promise<ApplyCouponResult>;

  removeCouponFromCheckout(
    actor: import('../../identity/rbac/policy.js').AuthorizedActor,
    checkoutSessionId: string,
  ): Promise<RemoveCouponResult>;
}
