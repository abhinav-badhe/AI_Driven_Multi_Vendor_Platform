import { randomUUID } from 'node:crypto';
import type { AuthorizedActor } from '../../identity/rbac/policy.js';
import { RbacPolicy } from '../../identity/rbac/policy.js';
import {
  ValidationError,
  NotFoundError,
  ForbiddenError,
  ConflictError,
} from '../../../errors/app-error.js';
import { DiscountCalculator } from './discount-calculator.js';
import type {
  PromotionDto,
  CreatePromotionInput,
  UpdatePromotionInput,
  DiscountCalculationResult,
  AppliedPromotionSnapshot,
  IPromotionPricingEngine,
  ListPromotionsFilter,
  PreviewDiscountsInput,
  ApplyCouponResult,
  RemoveCouponResult,
} from './promotion-models.js';

export class InMemoryPromotionStore implements IPromotionPricingEngine {
  private readonly promotions = new Map<string, PromotionDto>();
  private readonly codeIndex = new Map<string, string>(); // UPPERCASE CODE -> ID
  private readonly checkoutApplied = new Map<
    string,
    {
      couponCode: string;
      discountAmount: number;
      totalAmount: number;
      appliedPromotions: AppliedPromotionSnapshot[];
    }
  >();

  seedPromotions(promos: PromotionDto[]): void {
    for (const p of promos) {
      this.promotions.set(p.id, p);
      if (p.code) {
        this.codeIndex.set(p.code.toUpperCase(), p.id);
      }
    }
  }

  async createPromotion(
    actor: AuthorizedActor,
    input: CreatePromotionInput,
  ): Promise<PromotionDto> {
    let merchantTenantId: string | null = null;
    if (actor.role === 'ADMINISTRATOR') {
      RbacPolicy.requirePermission(actor, 'promotion:create-own');
      merchantTenantId = input.merchantTenantId ?? null;
    } else if (actor.role === 'MERCHANT') {
      RbacPolicy.requirePermission(actor, 'promotion:create-own');
      if (input.merchantTenantId && input.merchantTenantId !== actor.tenantId) {
        throw new ForbiddenError('Merchants cannot create promotions for other merchants');
      }
      merchantTenantId = actor.tenantId;
    } else {
      throw new ForbiddenError('Only merchants and administrators can create promotions');
    }

    if (!input.name || input.name.trim().length === 0) {
      throw new ValidationError('Promotion name is required');
    }
    if (input.discountValue <= 0) {
      throw new ValidationError('Discount value must be greater than zero');
    }
    if (input.discountType === 'PERCENTAGE' && input.discountValue > 100) {
      throw new ValidationError('Percentage discount cannot exceed 100%');
    }

    let code: string | null = null;
    if (input.code && input.code.trim().length > 0) {
      code = input.code.trim().toUpperCase();
      if (this.codeIndex.has(code)) {
        throw new ConflictError(`Coupon code '${code}' already exists`);
      }
    }

    const id = randomUUID();
    const nowIso = new Date().toISOString();
    const startsAt =
      typeof input.startsAt === 'string' ? input.startsAt : input.startsAt.toISOString();
    const expiresAt = input.expiresAt
      ? typeof input.expiresAt === 'string'
        ? input.expiresAt
        : input.expiresAt.toISOString()
      : null;

    const dto: PromotionDto = {
      id,
      name: input.name.trim(),
      description: input.description ?? null,
      merchantTenantId,
      code,
      discountType: input.discountType,
      discountValue: input.discountValue,
      currency: input.currency ?? 'USD',
      scope: input.scope ?? 'ORDER',
      targetIds: input.targetIds ?? [],
      minOrderAmount: input.minOrderAmount ?? 0,
      maxDiscountAmount: input.maxDiscountAmount ?? null,
      startsAt,
      expiresAt,
      status: input.status ?? 'ACTIVE',
      usageLimitTotal: input.usageLimitTotal ?? null,
      usageLimitPerCustomer: input.usageLimitPerCustomer ?? null,
      currentUsageCount: 0,
      firstOrderOnly: input.firstOrderOnly ?? false,
      stackable: input.stackable ?? false,
      metadata: input.metadata ?? {},
      createdAt: nowIso,
      updatedAt: nowIso,
    };

    this.promotions.set(id, dto);
    if (code) {
      this.codeIndex.set(code, id);
    }
    return dto;
  }

  async getPromotion(actor: AuthorizedActor, id: string): Promise<PromotionDto> {
    const promo = this.promotions.get(id);
    if (!promo) {
      throw new NotFoundError(`Promotion '${id}' not found`);
    }
    if (
      actor.role === 'MERCHANT' &&
      promo.merchantTenantId &&
      promo.merchantTenantId !== actor.tenantId
    ) {
      throw new ForbiddenError('Merchants can only view their own promotions');
    }
    return promo;
  }

  async listPromotions(
    actor: AuthorizedActor,
    filter?: ListPromotionsFilter,
  ): Promise<PromotionDto[]> {
    let result = Array.from(this.promotions.values());

    if (actor.role === 'MERCHANT') {
      result = result.filter(
        (p) =>
          p.merchantTenantId === actor.tenantId ||
          (filter?.includePlatform && p.merchantTenantId === null),
      );
    } else if (filter?.merchantTenantId) {
      result = result.filter((p) => p.merchantTenantId === filter.merchantTenantId);
    }

    if (filter?.status) {
      result = result.filter((p) => p.status === filter.status);
    }

    const offset = filter?.offset ?? 0;
    const limit = filter?.limit ?? 50;
    return result.slice(offset, offset + limit);
  }

  async updatePromotion(
    actor: AuthorizedActor,
    id: string,
    input: UpdatePromotionInput,
  ): Promise<PromotionDto> {
    const promo = await this.getPromotion(actor, id);
    if (actor.role === 'MERCHANT') {
      RbacPolicy.requirePermission(actor, 'promotion:create-own');
      if (promo.merchantTenantId && promo.merchantTenantId !== actor.tenantId) {
        throw new ForbiddenError('Merchants can only update their own promotions');
      }
    }

    const updated: PromotionDto = {
      ...promo,
      ...(input.name !== undefined && { name: input.name }),
      ...(input.description !== undefined && { description: input.description }),
      ...(input.discountType !== undefined && { discountType: input.discountType }),
      ...(input.discountValue !== undefined && { discountValue: input.discountValue }),
      ...(input.currency !== undefined && { currency: input.currency }),
      ...(input.scope !== undefined && { scope: input.scope }),
      ...(input.targetIds !== undefined && { targetIds: input.targetIds }),
      ...(input.minOrderAmount !== undefined && { minOrderAmount: input.minOrderAmount }),
      ...(input.maxDiscountAmount !== undefined && { maxDiscountAmount: input.maxDiscountAmount }),
      ...(input.status !== undefined && { status: input.status }),
      ...(input.usageLimitTotal !== undefined && { usageLimitTotal: input.usageLimitTotal }),
      ...(input.usageLimitPerCustomer !== undefined && {
        usageLimitPerCustomer: input.usageLimitPerCustomer,
      }),
      ...(input.firstOrderOnly !== undefined && { firstOrderOnly: input.firstOrderOnly }),
      ...(input.stackable !== undefined && { stackable: input.stackable }),
      ...(input.metadata !== undefined && { metadata: input.metadata }),
      updatedAt: new Date().toISOString(),
    };

    this.promotions.set(id, updated);
    return updated;
  }

  async previewDiscounts(
    actor: AuthorizedActor,
    input: PreviewDiscountsInput,
  ): Promise<DiscountCalculationResult> {
    const currency = input.currency ?? 'USD';

    let candidatePromos: PromotionDto[] = [];
    if (input.couponCode) {
      const codeUpper = input.couponCode.trim().toUpperCase();
      const promoId = this.codeIndex.get(codeUpper);
      if (!promoId) {
        throw new NotFoundError(`Coupon code '${input.couponCode}' is invalid or does not exist`);
      }
      candidatePromos = [this.promotions.get(promoId)!];
    } else {
      candidatePromos = Array.from(this.promotions.values()).filter(
        (p) => p.status === 'ACTIVE' && (!p.code || p.code.length === 0),
      );
    }

    // Convert PromotionDto to PromotionRow shape for calculator
    const candidateRows = candidatePromos.map((p) => ({
      id: p.id,
      name: p.name,
      description: p.description ?? null,
      merchant_tenant_id: p.merchantTenantId ?? null,
      code: p.code ?? null,
      discount_type: p.discountType,
      discount_value: p.discountValue,
      currency: p.currency,
      scope: p.scope,
      target_ids: p.targetIds,
      min_order_amount: p.minOrderAmount,
      max_discount_amount: p.maxDiscountAmount ?? null,
      starts_at: new Date(p.startsAt),
      expires_at: p.expiresAt ? new Date(p.expiresAt) : null,
      status: p.status,
      usage_limit_total: p.usageLimitTotal ?? null,
      usage_limit_per_customer: p.usageLimitPerCustomer ?? null,
      current_usage_count: p.currentUsageCount,
      first_order_only: p.firstOrderOnly,
      stackable: p.stackable,
      metadata: p.metadata ?? {},
      created_at: new Date(p.createdAt),
      updated_at: new Date(p.updatedAt),
    }));

    return DiscountCalculator.calculateDiscounts(candidateRows, input.items, {
      customerTenantId: actor.tenantId,
      currency,
      isFirstOrder: input.isFirstOrder ?? false,
    });
  }

  async applyCouponToCheckout(
    _actor: AuthorizedActor,
    checkoutSessionId: string,
    couponCode: string,
  ): Promise<ApplyCouponResult> {
    const codeUpper = couponCode.trim().toUpperCase();
    const promoId = this.codeIndex.get(codeUpper);
    if (!promoId) {
      throw new NotFoundError(`Coupon code '${couponCode}' is invalid or does not exist`);
    }

    const promo = this.promotions.get(promoId)!;
    const discountAmount = promo.discountType === 'FIXED_AMOUNT' ? promo.discountValue : 10;
    const totalAmount = Math.max(0, 100 - discountAmount);

    const snapshot: AppliedPromotionSnapshot = {
      promotionId: promo.id,
      code: promo.code ?? null,
      name: promo.name,
      discountType: promo.discountType,
      discountValue: promo.discountValue,
      scope: promo.scope,
      merchantTenantId: promo.merchantTenantId ?? null,
      discountAmount,
      explanation: `${promo.name} applied`,
    };

    const result: ApplyCouponResult = {
      discountAmount,
      totalAmount,
      couponCode: promo.code ?? couponCode,
      appliedPromotions: [snapshot],
    };

    this.checkoutApplied.set(checkoutSessionId, result);
    return result;
  }

  async removeCouponFromCheckout(
    _actor: AuthorizedActor,
    checkoutSessionId: string,
  ): Promise<RemoveCouponResult> {
    this.checkoutApplied.delete(checkoutSessionId);
    return {
      discountAmount: 0,
      totalAmount: 100,
      couponCode: null,
      appliedPromotions: [],
    };
  }
}
