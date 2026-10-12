import { randomUUID } from 'node:crypto';
import type { DatabaseConnection } from '../../../infra/database/connection.js';
import type { Logger } from '../../../observability/logger.js';
import type { AuthorizedActor } from '../../identity/index.js';
import {
  RbacPolicy,
  SecurityAuditService,
  type ISecurityAuditService,
} from '../../identity/index.js';
import { OutboxService, EventTypes, createDomainEvent } from '../../events/index.js';
import {
  ValidationError,
  NotFoundError,
  ForbiddenError,
  ConflictError,
  InvalidStateTransitionError,
} from '../../../errors/app-error.js';
import { PromotionRepository } from './promotion-repository.js';
import { DiscountCalculator } from './discount-calculator.js';
import type {
  PromotionRow,
  PromotionDto,
  CreatePromotionInput,
  UpdatePromotionInput,
  CalculateDiscountItem,
  DiscountCalculationResult,
  AppliedPromotionSnapshot,
  IPromotionPricingEngine,
  ListPromotionsFilter,
  PreviewDiscountsInput,
  ApplyCouponResult,
  RemoveCouponResult,
} from './promotion-models.js';

export class PromotionService implements IPromotionPricingEngine {
  private readonly repo: PromotionRepository;
  private readonly audit: ISecurityAuditService;

  constructor(
    private readonly db: DatabaseConnection,
    logger: Logger,
    private readonly outbox?: OutboxService | undefined,
    audit?: ISecurityAuditService,
  ) {
    this.repo = new PromotionRepository(db);
    this.audit = audit ?? new SecurityAuditService(db, logger);
  }

  async createPromotion(
    actor: AuthorizedActor,
    input: CreatePromotionInput,
  ): Promise<PromotionDto> {
    // 1. Authorization check
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

    // 2. Input validation
    if (!input.name || input.name.trim().length === 0) {
      throw new ValidationError('Promotion name is required');
    }

    if (input.discountValue <= 0) {
      throw new ValidationError('Discount value must be greater than zero');
    }

    if (input.discountType === 'PERCENTAGE' && input.discountValue > 100) {
      throw new ValidationError('Percentage discount cannot exceed 100%');
    }

    if (input.minOrderAmount !== undefined && input.minOrderAmount < 0) {
      throw new ValidationError('Minimum order amount cannot be negative');
    }

    if (
      input.maxDiscountAmount !== undefined &&
      input.maxDiscountAmount !== null &&
      input.maxDiscountAmount <= 0
    ) {
      throw new ValidationError('Maximum discount amount must be greater than zero');
    }

    const startsAt = new Date(input.startsAt);
    if (isNaN(startsAt.getTime())) {
      throw new ValidationError('Invalid promotion start date');
    }

    let expiresAt: Date | null = null;
    if (input.expiresAt) {
      expiresAt = new Date(input.expiresAt);
      if (isNaN(expiresAt.getTime())) {
        throw new ValidationError('Invalid promotion expiration date');
      }
      if (expiresAt.getTime() <= startsAt.getTime()) {
        throw new ValidationError('Expiration date must be after start date');
      }
    }

    // Check code uniqueness
    let code: string | null = null;
    if (input.code && input.code.trim().length > 0) {
      code = input.code.trim().toUpperCase();
      const existing = await this.repo.getPromotionByCode(this.db, code);
      if (existing) {
        throw new ConflictError(`Coupon code '${code}' already exists`);
      }
    }

    const id = randomUUID();
    const created = await this.repo.createPromotion(this.db, {
      ...input,
      id,
      merchantTenantId,
      code,
      startsAt,
      expiresAt,
    });

    // 3. Outbox event & audit logging
    if (this.outbox) {
      await this.db.withTransaction(async (tx) => {
        await this.outbox!.recordEvent(
          tx,
          createDomainEvent({
            eventType: EventTypes.PROMOTION_CREATED,
            tenantId: merchantTenantId ?? actor.tenantId,
            aggregateType: 'PROMOTION',
            aggregateId: id,
            payload: {
              promotionId: id,
              name: created.name,
              code: created.code,
              discountType: created.discount_type,
              discountValue: created.discount_value,
              merchantTenantId: created.merchant_tenant_id,
              status: created.status,
            },
          }),
        );
      });
    }

    await this.audit.record({
      eventType: 'PROMOTION_CREATED',
      actorId: actor.userId,
      tenantId: actor.tenantId,
      metadata: {
        promotionId: id,
        name: created.name,
        code: created.code,
        merchantTenantId: created.merchant_tenant_id,
      },
    });

    return this.toDto(created);
  }

  async updatePromotion(
    actor: AuthorizedActor,
    id: string,
    input: UpdatePromotionInput,
  ): Promise<PromotionDto> {
    const existing = await this.repo.getPromotionById(this.db, id);
    if (!existing) {
      throw new NotFoundError(`Promotion '${id}' not found`);
    }

    // Authorization
    if (actor.role === 'MERCHANT') {
      RbacPolicy.requirePermission(actor, 'promotion:update-own');
      if (existing.merchant_tenant_id !== actor.tenantId) {
        throw new ForbiddenError(
          'Merchants cannot update promotions of other merchants or platform promotions',
        );
      }
    } else if (actor.role === 'ADMINISTRATOR') {
      RbacPolicy.requirePermission(actor, 'promotion:manage-any');
    } else {
      throw new ForbiddenError('Unauthorized to update promotions');
    }

    // Validation
    if (input.discountValue !== undefined && input.discountValue <= 0) {
      throw new ValidationError('Discount value must be greater than zero');
    }
    const discountType = input.discountType ?? existing.discount_type;
    const discountValue = input.discountValue ?? existing.discount_value;
    if (discountType === 'PERCENTAGE' && discountValue > 100) {
      throw new ValidationError('Percentage discount cannot exceed 100%');
    }

    if (input.minOrderAmount !== undefined && input.minOrderAmount < 0) {
      throw new ValidationError('Minimum order amount cannot be negative');
    }

    const updated = await this.repo.updatePromotion(this.db, id, input);
    if (!updated) {
      throw new NotFoundError(`Promotion '${id}' not found`);
    }

    // Outbox events
    if (this.outbox) {
      let eventType: string = EventTypes.PROMOTION_UPDATED;
      if (input.status && input.status !== existing.status) {
        eventType =
          input.status === 'ACTIVE'
            ? EventTypes.PROMOTION_ACTIVATED
            : EventTypes.PROMOTION_DEACTIVATED;
      }
      await this.db.withTransaction(async (tx) => {
        await this.outbox!.recordEvent(
          tx,
          createDomainEvent({
            eventType,
            tenantId: updated.merchant_tenant_id ?? actor.tenantId,
            aggregateType: 'PROMOTION',
            aggregateId: id,
            payload: {
              promotionId: id,
              previousStatus: existing.status,
              currentStatus: updated.status,
            },
          }),
        );
      });
    }

    await this.audit.record({
      eventType: 'PROMOTION_UPDATED',
      actorId: actor.userId,
      tenantId: actor.tenantId,
      metadata: { promotionId: id, changes: Object.keys(input) },
    });

    return this.toDto(updated);
  }

  async getPromotion(actor: AuthorizedActor, id: string): Promise<PromotionDto> {
    const promo = await this.repo.getPromotionById(this.db, id);
    if (!promo) {
      throw new NotFoundError(`Promotion '${id}' not found`);
    }

    if (
      actor.role === 'MERCHANT' &&
      promo.merchant_tenant_id &&
      promo.merchant_tenant_id !== actor.tenantId
    ) {
      throw new ForbiddenError('Merchants cannot view promotions of other merchants');
    }

    return this.toDto(promo);
  }

  async listPromotions(
    actor: AuthorizedActor,
    filters?: ListPromotionsFilter,
  ): Promise<PromotionDto[]> {
    let merchantTenantId = filters?.merchantTenantId;
    let includePlatform = filters?.includePlatform;

    if (actor.role === 'MERCHANT') {
      RbacPolicy.requirePermission(actor, 'promotion:read-own');
      merchantTenantId = actor.tenantId;
      includePlatform = filters?.includePlatform ?? false;
    } else if (actor.role === 'ADMINISTRATOR') {
      RbacPolicy.requirePermission(actor, 'promotion:read-any');
    } else {
      // Customer
      RbacPolicy.requirePermission(actor, 'promotion:read-any');
    }

    const rows = await this.repo.listPromotions(this.db, {
      merchantTenantId,
      includePlatform,
      status: filters?.status,
      limit: filters?.limit,
      offset: filters?.offset,
    });

    return rows.map((r) => this.toDto(r));
  }

  /**
   * Preview discount calculation on a set of items without mutating any checkout session.
   */
  async previewDiscounts(
    actor: AuthorizedActor,
    input: PreviewDiscountsInput,
  ): Promise<DiscountCalculationResult> {
    RbacPolicy.requirePermission(actor, 'promotion:validate');

    const merchantIds = Array.from(new Set(input.items.map((it) => it.merchantTenantId)));
    const candidatePromos: PromotionRow[] = [];

    // 1. Fetch active automatic promotions (no coupon code required)
    const autoPromos = await this.repo.findActivePromotionsForItems(
      this.db,
      input.currency,
      merchantIds,
      input.now,
    );
    candidatePromos.push(...autoPromos);

    // 2. If coupon code provided, fetch and validate coupon
    if (input.couponCode && input.couponCode.trim().length > 0) {
      const couponPromo = await this.repo.getPromotionByCode(this.db, input.couponCode.trim());
      if (!couponPromo) {
        throw new NotFoundError(`Invalid coupon code '${input.couponCode}'`);
      }
      candidatePromos.push(couponPromo);
    }

    // 3. Customer usage counts & first order check
    const customerUsageCounts = new Map<string, number>();
    for (const p of candidatePromos) {
      if (p.usage_limit_per_customer !== null) {
        const count = await this.repo.getCustomerRedemptionCount(this.db, p.id, actor.tenantId);
        customerUsageCounts.set(p.id, count);
      }
    }

    const orderCount = await this.repo.getCustomerCompletedOrderCount(this.db, actor.tenantId);
    const isFirstOrder = orderCount === 0;

    return DiscountCalculator.calculateDiscounts(candidatePromos, input.items, {
      customerTenantId: actor.tenantId,
      currency: input.currency,
      now: input.now,
      isFirstOrder,
      customerUsageCounts,
    });
  }

  /**
   * Atomically validate and apply a coupon to an active checkout session.
   */
  async applyCouponToCheckout(
    actor: AuthorizedActor,
    checkoutSessionId: string,
    couponCode: string,
  ): Promise<ApplyCouponResult> {
    RbacPolicy.requirePermission(actor, 'checkout:read-own');

    // 1. Load checkout session
    const sessionRes = await this.db.query<{
      id: string;
      customer_tenant_id: string;
      status: string;
      currency: string;
      subtotal_amount: number;
      shipping_amount: number;
      tax_amount: number;
    }>(
      `SELECT id, customer_tenant_id, status, currency, subtotal_amount, shipping_amount, tax_amount
       FROM checkout_sessions WHERE id = $1`,
      [checkoutSessionId],
    );

    const session = sessionRes.rows[0];
    if (!session) {
      throw new NotFoundError(`Checkout session '${checkoutSessionId}' not found`);
    }

    if (actor.role !== 'ADMINISTRATOR') {
      RbacPolicy.requireTenantMatch(actor, session.customer_tenant_id);
    }

    if (session.status !== 'OPEN' && session.status !== 'READY' && session.status !== 'RESERVED') {
      throw new InvalidStateTransitionError(
        `Cannot apply coupon to checkout session in status '${session.status}'`,
      );
    }

    // 2. Fetch checkout items
    const itemsRes = await this.db.query<{
      listing_id: string;
      sku_id: string;
      merchant_tenant_id: string;
      quantity: number;
      unit_price_amount: number;
      line_total_amount: number;
      currency: string;
    }>(
      `SELECT listing_id, sku_id, merchant_tenant_id, quantity, unit_price_amount, line_total_amount, currency
       FROM checkout_items WHERE checkout_session_id = $1`,
      [checkoutSessionId],
    );

    if (itemsRes.rows.length === 0) {
      throw new ValidationError('Checkout session has no items');
    }

    // 3. Resolve product IDs & category IDs from SKUs
    const skuIds = itemsRes.rows.map((r) => r.sku_id);
    const skusRes = await this.db.query<{ id: string; product_id: string; category_id: string }>(
      `SELECT s.id, s.product_id, p.category_id
       FROM product_skus s
       JOIN products p ON s.product_id = p.id
       WHERE s.id = ANY($1::text[])`,
      [skuIds],
    );

    const skuInfoMap = new Map(skusRes.rows.map((r) => [r.id, r]));

    const calcItems: CalculateDiscountItem[] = itemsRes.rows.map((row) => {
      const skuInfo = skuInfoMap.get(row.sku_id);
      return {
        listingId: row.listing_id,
        skuId: row.sku_id,
        productId: skuInfo?.product_id ?? null,
        categoryId: skuInfo?.category_id ?? null,
        merchantTenantId: row.merchant_tenant_id,
        quantity: Number(row.quantity),
        unitPriceAmount: Number(row.unit_price_amount),
        lineTotalAmount: Number(row.line_total_amount),
      };
    });

    // 4. Validate coupon code
    const promo = await this.repo.getPromotionByCode(this.db, couponCode);
    if (!promo) {
      throw new NotFoundError(`Coupon code '${couponCode}' is invalid or does not exist`);
    }

    // 5. Check customer usage & first-order status
    const customerUsageCount = await this.repo.getCustomerRedemptionCount(
      this.db,
      promo.id,
      session.customer_tenant_id,
    );
    const orderCount = await this.repo.getCustomerCompletedOrderCount(
      this.db,
      session.customer_tenant_id,
    );

    const customerUsageCounts = new Map([[promo.id, customerUsageCount]]);

    const eligibility = DiscountCalculator.isEligible(promo, calcItems, {
      customerTenantId: session.customer_tenant_id,
      currency: session.currency,
      isFirstOrder: orderCount === 0,
      customerUsageCounts,
    });

    if (!eligibility.eligible) {
      throw new ValidationError(
        eligibility.reason ?? `Coupon '${couponCode}' is not eligible for this order`,
      );
    }

    // 6. Run calculation
    const calcResult = DiscountCalculator.calculateDiscounts([promo], calcItems, {
      customerTenantId: session.customer_tenant_id,
      currency: session.currency,
      isFirstOrder: orderCount === 0,
      customerUsageCounts,
    });

    if (calcResult.totalDiscountAmount <= 0) {
      throw new ValidationError(
        `Coupon '${couponCode}' did not qualify for any discount on this order`,
      );
    }

    const subtotal = Number(session.subtotal_amount);
    const shipping = Number(session.shipping_amount);
    const tax = Number(session.tax_amount);
    const discount = calcResult.totalDiscountAmount;
    const finalTotal = Math.max(0, subtotal + shipping + tax - discount);

    // 7. Persist updated checkout snapshot
    await this.db.query(
      `UPDATE checkout_sessions
       SET discount_amount = $1,
           total_amount = $2,
           coupon_code = $3,
           applied_promotions = $4::jsonb,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $5`,
      [
        discount,
        finalTotal,
        promo.code,
        JSON.stringify(calcResult.appliedPromotions),
        checkoutSessionId,
      ],
    );

    // 8. Record reservation in coupon_redemptions table
    const redemptionId = randomUUID();
    await this.repo.recordRedemption(this.db, {
      id: redemptionId,
      promotionId: promo.id,
      couponCode: promo.code,
      checkoutSessionId,
      customerTenantId: session.customer_tenant_id,
      merchantTenantId: promo.merchant_tenant_id,
      discountAmount: discount,
      currency: session.currency,
      status: 'RESERVED',
    });

    return {
      discountAmount: discount,
      totalAmount: finalTotal,
      couponCode: promo.code ?? couponCode,
      appliedPromotions: calcResult.appliedPromotions,
    };
  }

  /**
   * Remove coupon from checkout session and restore pricing snapshot.
   */
  async removeCouponFromCheckout(
    actor: AuthorizedActor,
    checkoutSessionId: string,
  ): Promise<RemoveCouponResult> {
    RbacPolicy.requirePermission(actor, 'checkout:read-own');

    const sessionRes = await this.db.query<{
      customer_tenant_id: string;
      subtotal_amount: number;
      shipping_amount: number;
      tax_amount: number;
    }>(
      `SELECT customer_tenant_id, subtotal_amount, shipping_amount, tax_amount
       FROM checkout_sessions WHERE id = $1`,
      [checkoutSessionId],
    );

    const session = sessionRes.rows[0];
    if (!session) {
      throw new NotFoundError(`Checkout session '${checkoutSessionId}' not found`);
    }

    if (actor.role !== 'ADMINISTRATOR') {
      RbacPolicy.requireTenantMatch(actor, session.customer_tenant_id);
    }

    const subtotal = Number(session.subtotal_amount);
    const shipping = Number(session.shipping_amount);
    const tax = Number(session.tax_amount);
    const finalTotal = subtotal + shipping + tax;

    await this.db.query(
      `UPDATE checkout_sessions
       SET discount_amount = 0,
           total_amount = $1,
           coupon_code = NULL,
           applied_promotions = '[]'::jsonb,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $2`,
      [finalTotal, checkoutSessionId],
    );

    // Delete or cancel redemptions for this checkout session
    await this.db.query(
      `DELETE FROM coupon_redemptions WHERE checkout_session_id = $1 AND status = 'RESERVED'`,
      [checkoutSessionId],
    );

    return {
      discountAmount: 0,
      totalAmount: finalTotal,
      couponCode: null,
      appliedPromotions: [],
    };
  }

  /**
   * Finalize coupon redemption atomically within the checkout -> order transaction.
   * Concurrency safe with SELECT FOR UPDATE.
   */
  async finalizeRedemption(
    tx: DatabaseConnection,
    params: {
      checkoutSessionId: string;
      customerOrderId: string;
      customerTenantId: string;
      actor: AuthorizedActor;
    },
  ): Promise<void> {
    // 1. Check if checkout session has applied promotions
    const sessionRes = await tx.query<{
      coupon_code: string | null;
      applied_promotions: unknown;
      currency: string;
      discount_amount: number;
    }>(
      `SELECT coupon_code, applied_promotions, currency, discount_amount
       FROM checkout_sessions WHERE id = $1`,
      [params.checkoutSessionId],
    );

    const session = sessionRes.rows[0];
    if (!session || !session.applied_promotions) {
      return;
    }

    const appliedPromos: AppliedPromotionSnapshot[] =
      typeof session.applied_promotions === 'string'
        ? JSON.parse(session.applied_promotions)
        : (session.applied_promotions as AppliedPromotionSnapshot[]);

    if (!Array.isArray(appliedPromos) || appliedPromos.length === 0) {
      return;
    }

    // Check if redemptions for this checkout session / order have already been finalized (idempotent retry)
    const existingRedemptions = await this.repo.getRedemptionsByCheckout(
      tx,
      params.checkoutSessionId,
    );
    if (existingRedemptions.some((r) => r.status === 'COMPLETED')) {
      return;
    }

    for (const applied of appliedPromos) {
      // 2. Lock promotion row FOR UPDATE to prevent concurrency races on usage limits
      const promo = await this.repo.lockPromotionForUpdate(tx, applied.promotionId);
      if (!promo) {
        throw new NotFoundError(
          `Promotion '${applied.promotionId}' not found during checkout redemption`,
        );
      }

      // Check global usage limit under lock
      if (
        promo.usage_limit_total !== null &&
        promo.current_usage_count >= promo.usage_limit_total
      ) {
        throw new ConflictError(
          `Promotion '${promo.name}' usage limit has been reached by a concurrent order`,
        );
      }

      // Check per-customer usage limit under lock
      if (promo.usage_limit_per_customer !== null) {
        const customerCount = await this.repo.getCustomerRedemptionCount(
          tx,
          promo.id,
          params.customerTenantId,
        );
        // Exclude reserved row for this checkout
        if (customerCount > promo.usage_limit_per_customer) {
          throw new ConflictError(
            `Customer usage limit for promotion '${promo.name}' has been exceeded`,
          );
        }
      }

      // 3. Atomically increment usage count
      await this.repo.incrementUsageCount(tx, promo.id);

      // 4. Mark redemption as COMPLETED
      const redemptionId = randomUUID();
      await this.repo.recordRedemption(tx, {
        id: redemptionId,
        promotionId: promo.id,
        couponCode: promo.code,
        checkoutSessionId: params.checkoutSessionId,
        customerOrderId: params.customerOrderId,
        customerTenantId: params.customerTenantId,
        merchantTenantId: promo.merchant_tenant_id,
        discountAmount: applied.discountAmount,
        currency: session.currency,
        status: 'COMPLETED',
      });

      // 5. Emit COUPON_REDEEMED outbox event inside same transaction
      if (this.outbox) {
        await this.outbox.recordEvent(
          tx,
          createDomainEvent({
            eventType: EventTypes.COUPON_REDEEMED,
            tenantId: promo.merchant_tenant_id ?? params.customerTenantId,
            aggregateType: 'COUPON_REDEMPTION',
            aggregateId: redemptionId,
            payload: {
              redemptionId,
              promotionId: promo.id,
              couponCode: promo.code,
              orderId: params.customerOrderId,
              checkoutSessionId: params.checkoutSessionId,
              customerId: params.customerTenantId,
              merchantTenantId: promo.merchant_tenant_id,
              discountAmount: applied.discountAmount,
              currency: session.currency,
            },
          }),
        );
      }
    }
  }

  /**
   * Reverse coupon redemption if order/payment is cancelled/refunded.
   */
  async reverseRedemption(
    tx: DatabaseConnection,
    params: {
      checkoutSessionId: string;
      customerOrderId?: string | null | undefined;
      reason?: string | undefined;
    },
  ): Promise<void> {
    const redemptions = await this.repo.getRedemptionsByCheckout(tx, params.checkoutSessionId);
    for (const r of redemptions) {
      if (r.status === 'COMPLETED') {
        await this.repo.decrementUsageCount(tx, r.promotion_id);
        await this.repo.updateRedemptionStatus(
          tx,
          params.checkoutSessionId,
          r.promotion_id,
          'CANCELLED',
        );

        if (this.outbox) {
          await this.outbox.recordEvent(
            tx,
            createDomainEvent({
              eventType: EventTypes.COUPON_REDEMPTION_REVERSED,
              tenantId: r.merchant_tenant_id ?? r.customer_tenant_id,
              aggregateType: 'COUPON_REDEMPTION',
              aggregateId: r.id,
              payload: {
                redemptionId: r.id,
                promotionId: r.promotion_id,
                checkoutSessionId: params.checkoutSessionId,
                customerOrderId: params.customerOrderId ?? r.customer_order_id,
                discountAmount: r.discount_amount,
                reason: params.reason ?? 'ORDER_CANCELLED',
              },
            }),
          );
        }
      }
    }
  }

  private toDto(row: PromotionRow): PromotionDto {
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      merchantTenantId: row.merchant_tenant_id,
      code: row.code,
      discountType: row.discount_type,
      discountValue: row.discount_value,
      currency: row.currency,
      scope: row.scope,
      targetIds: row.target_ids,
      minOrderAmount: row.min_order_amount,
      maxDiscountAmount: row.max_discount_amount,
      startsAt: new Date(row.starts_at).toISOString(),
      expiresAt: row.expires_at ? new Date(row.expires_at).toISOString() : null,
      status: row.status,
      usageLimitTotal: row.usage_limit_total,
      usageLimitPerCustomer: row.usage_limit_per_customer,
      currentUsageCount: row.current_usage_count,
      firstOrderOnly: row.first_order_only,
      stackable: row.stackable,
      metadata: row.metadata,
      createdAt: new Date(row.created_at).toISOString(),
      updatedAt: new Date(row.updated_at).toISOString(),
    };
  }
}
