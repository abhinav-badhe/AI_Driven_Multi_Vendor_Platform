import type {
  PromotionRow,
  CalculateDiscountItem,
  CalculateDiscountContext,
  DiscountCalculationResult,
  AppliedPromotionSnapshot,
} from './promotion-models.js';

export interface NormalizedPromotion {
  id: string;
  tenant_id: string;
  name: string;
  code: string | null;
  discount_type: 'PERCENTAGE' | 'FIXED_AMOUNT';
  discount_value: number;
  max_discount_amount: number | null;
  min_order_amount: number;
  scope: 'ORDER' | 'PRODUCT' | 'CATEGORY';
  target_ids: string[] | null;
  merchant_tenant_id: string | null;
  usage_limit_total: number | null;
  usage_limit_per_customer: number | null;
  current_usage_count: number;
  starts_at: Date;
  expires_at: Date | null;
  stackable: boolean;
  status: string;
  first_order_only: boolean;
  currency: string;
}

export type PromotionInput = PromotionRow | NormalizedPromotion | Record<string, unknown>;

export class DiscountCalculator {
  /**
   * Deterministic integer percentage rounding in minor units.
   */
  static calculatePercentageDiscount(baseAmount: number, percentage: number): number {
    if (baseAmount <= 0 || percentage <= 0) return 0;
    // Strictly integer minor unit rounding
    return Math.round((baseAmount * percentage) / 100);
  }

  /**
   * Normalize any input (PromotionRow or PromotionDto) into canonical internal structure.
   */
  static normalize(p: PromotionInput): NormalizedPromotion {
    const record = p as Record<string, unknown>;
    return {
      id: String(record.id ?? ''),
      tenant_id: String(record.tenant_id ?? record.tenantId ?? ''),
      name: String(record.name ?? ''),
      code: (record.code as string | null | undefined) ?? null,
      discount_type: (record.discount_type ?? record.discountType ?? 'PERCENTAGE') as
        'PERCENTAGE' | 'FIXED_AMOUNT',
      discount_value: Number(record.discount_value ?? record.discountValue ?? 0),
      max_discount_amount:
        record.max_discount_amount !== undefined
          ? (record.max_discount_amount as number | null)
          : record.maxDiscountAmount !== undefined
            ? (record.maxDiscountAmount as number | null)
            : null,
      min_order_amount: Number(record.min_order_amount ?? record.minOrderAmount ?? 0),
      scope: (record.scope as 'ORDER' | 'PRODUCT' | 'CATEGORY') ?? 'ORDER',
      target_ids: (record.target_ids ?? record.targetIds ?? null) as string[] | null,
      merchant_tenant_id: (record.merchant_tenant_id ?? record.merchantTenantId ?? null) as
        string | null,
      usage_limit_total:
        record.usage_limit_total !== undefined
          ? (record.usage_limit_total as number | null)
          : record.usageLimitTotal !== undefined
            ? (record.usageLimitTotal as number | null)
            : null,
      usage_limit_per_customer:
        record.usage_limit_per_customer !== undefined
          ? (record.usage_limit_per_customer as number | null)
          : record.usageLimitPerCustomer !== undefined
            ? (record.usageLimitPerCustomer as number | null)
            : null,
      current_usage_count: Number(record.current_usage_count ?? record.currentUsageCount ?? 0),
      starts_at: record.starts_at
        ? new Date(record.starts_at as string | number | Date)
        : record.startsAt
          ? new Date(record.startsAt as string | number | Date)
          : new Date(0),
      expires_at: record.expires_at
        ? new Date(record.expires_at as string | number | Date)
        : record.expiresAt
          ? new Date(record.expiresAt as string | number | Date)
          : null,
      stackable: Boolean(record.stackable ?? true),
      status: String(record.status ?? 'ACTIVE'),
      first_order_only: Boolean(record.first_order_only ?? record.firstOrderOnly ?? false),
      currency: String(record.currency ?? 'USD'),
    };
  }

  /**
   * Check if a promotion is fundamentally eligible for a given cart and customer context.
   */
  static isEligible(
    promoInput: PromotionInput,
    items: CalculateDiscountItem[],
    context: CalculateDiscountContext,
  ): { eligible: boolean; reason?: string } {
    const promo = this.normalize(promoInput);
    const now = context.now ?? new Date();

    // 1. Status
    if (promo.status !== 'ACTIVE') {
      return {
        eligible: false,
        reason: `Promotion '${promo.name}' is ${promo.status.toLowerCase()}`,
      };
    }

    // 2. Date window
    const startsAt = promo.starts_at;
    if (now.getTime() < startsAt.getTime()) {
      return { eligible: false, reason: `Promotion '${promo.name}' has not started yet` };
    }
    if (promo.expires_at) {
      const expiresAt = promo.expires_at;
      if (now.getTime() > expiresAt.getTime()) {
        return { eligible: false, reason: `Promotion '${promo.name}' has expired` };
      }
    }

    // 3. Currency matching
    if (promo.currency.toUpperCase() !== context.currency.toUpperCase()) {
      return {
        eligible: false,
        reason: `Currency mismatch: promotion is in ${promo.currency}, cart is in ${context.currency}`,
      };
    }

    // 4. Global usage limit
    if (promo.usage_limit_total !== null && promo.current_usage_count >= promo.usage_limit_total) {
      return {
        eligible: false,
        reason: `Promotion '${promo.name}' has reached its global usage limit`,
      };
    }

    // 5. Per-customer usage limit
    if (promo.usage_limit_per_customer !== null) {
      const customerCount = context.customerUsageCounts?.get(promo.id) ?? 0;
      if (customerCount >= promo.usage_limit_per_customer) {
        return {
          eligible: false,
          reason: `Customer has reached usage limit for promotion '${promo.name}'`,
        };
      }
    }

    // 6. First order only
    if (promo.first_order_only && context.isFirstOrder === false) {
      return {
        eligible: false,
        reason: `Promotion '${promo.name}' is only valid for first-time orders`,
      };
    }

    // 7. Merchant isolation
    if (promo.merchant_tenant_id) {
      const hasMerchantItems = items.some((it) => it.merchantTenantId === promo.merchant_tenant_id);
      if (!hasMerchantItems) {
        return {
          eligible: false,
          reason: `Promotion is only valid for products from merchant '${promo.merchant_tenant_id}'`,
        };
      }
    }

    // 8. Scope items matching & minimum order amount
    const eligibleItems = this.getEligibleItems(promo, items);
    if (eligibleItems.length === 0) {
      return {
        eligible: false,
        reason: `No qualifying items in cart for promotion '${promo.name}'`,
      };
    }

    const eligibleSubtotal = eligibleItems.reduce((sum, it) => sum + it.lineTotalAmount, 0);
    if (eligibleSubtotal < promo.min_order_amount) {
      return {
        eligible: false,
        reason: `Eligible order amount (${eligibleSubtotal}) is below minimum required (${promo.min_order_amount})`,
      };
    }

    return { eligible: true };
  }

  /**
   * Filter items matching promotion scope and merchant restriction.
   */
  static getEligibleItems(
    promoInput: PromotionInput,
    items: CalculateDiscountItem[],
  ): CalculateDiscountItem[] {
    const promo = this.normalize(promoInput);
    return items.filter((item) => {
      // If merchant-specific, merchant must match
      if (promo.merchant_tenant_id && item.merchantTenantId !== promo.merchant_tenant_id) {
        return false;
      }

      if (promo.scope === 'ORDER') {
        return true;
      }

      if (promo.scope === 'PRODUCT') {
        const targetIds = promo.target_ids || [];
        return (
          (item.productId && targetIds.includes(item.productId)) ||
          targetIds.includes(item.listingId) ||
          targetIds.includes(item.skuId)
        );
      }

      if (promo.scope === 'CATEGORY') {
        const targetIds = promo.target_ids || [];
        return item.categoryId ? targetIds.includes(item.categoryId) : false;
      }

      return false;
    });
  }

  /**
   * Calculate nominal discount amount for a single promotion against given remaining item amounts.
   */
  static calculateSingleDiscount(
    promoInput: PromotionInput,
    itemsWithRemaining: Array<{ item: CalculateDiscountItem; remaining: number }>,
  ): {
    discountAmount: number;
    itemDeductions: Map<string, number>;
  } {
    const promo = this.normalize(promoInput);
    const itemDeductions = new Map<string, number>();
    const eligibleEntries = itemsWithRemaining.filter(({ item }) => {
      if (promo.merchant_tenant_id && item.merchantTenantId !== promo.merchant_tenant_id) {
        return false;
      }
      if (promo.scope === 'PRODUCT') {
        const targetIds = promo.target_ids || [];
        return (
          (item.productId && targetIds.includes(item.productId)) ||
          targetIds.includes(item.listingId) ||
          targetIds.includes(item.skuId)
        );
      }
      if (promo.scope === 'CATEGORY') {
        const targetIds = promo.target_ids || [];
        return item.categoryId ? targetIds.includes(item.categoryId) : false;
      }
      return true;
    });

    const eligibleRemaining = eligibleEntries.reduce((sum, e) => sum + e.remaining, 0);
    if (eligibleRemaining <= 0) {
      return { discountAmount: 0, itemDeductions };
    }

    let rawDiscount = 0;
    if (promo.discount_type === 'PERCENTAGE') {
      rawDiscount = this.calculatePercentageDiscount(eligibleRemaining, promo.discount_value);
      if (promo.max_discount_amount !== null && promo.max_discount_amount > 0) {
        rawDiscount = Math.min(rawDiscount, promo.max_discount_amount);
      }
    } else {
      // FIXED_AMOUNT
      rawDiscount = Math.min(promo.discount_value, eligibleRemaining);
    }

    // Discount cannot exceed eligible remaining
    const finalPromoDiscount = Math.max(0, Math.min(rawDiscount, eligibleRemaining));

    // Distribute proportionally across eligible items in integer minor units
    let allocated = 0;
    for (let i = 0; i < eligibleEntries.length; i++) {
      const entry = eligibleEntries[i]!;
      let itemShare = 0;
      if (i === eligibleEntries.length - 1) {
        // Last item absorbs remainder to prevent rounding drifts
        itemShare = Math.min(entry.remaining, finalPromoDiscount - allocated);
      } else {
        itemShare = Math.min(
          entry.remaining,
          Math.round((finalPromoDiscount * entry.remaining) / eligibleRemaining),
        );
      }
      itemShare = Math.max(0, itemShare);
      itemDeductions.set(
        entry.item.listingId,
        (itemDeductions.get(entry.item.listingId) ?? 0) + itemShare,
      );
      allocated += itemShare;
    }

    return { discountAmount: allocated, itemDeductions };
  }

  /**
   * Deterministic Precedence and Conflict Resolution Engine.
   *
   * Precedence Tier:
   * 1. PRODUCT (item discounts)
   * 2. CATEGORY (category discounts)
   * 3. MERCHANT (merchant order discounts)
   * 4. PLATFORM (platform order discounts)
   *
   * Conflict Resolution:
   * - If all applicable promotions are stackable, they apply in precedence tier order.
   * - If non-stackable promotions exist, we evaluate:
   *   a) The stackable combination
   *   b) Each non-stackable promotion individually
   *   And deterministically select the one that produces the maximum customer savings.
   *   Tie-breaking: Lowest promotion ID ASC.
   */
  static calculateDiscounts(
    promotions: PromotionInput[],
    items: CalculateDiscountItem[],
    context: CalculateDiscountContext,
  ): DiscountCalculationResult {
    const subtotalAmount = items.reduce((sum, it) => sum + it.lineTotalAmount, 0);
    if (items.length === 0 || subtotalAmount <= 0) {
      return {
        appliedPromotions: [],
        subtotalAmount: 0,
        totalDiscountAmount: 0,
        itemDiscounts: [],
        merchantDiscounts: {},
        finalTotalAmount: 0,
      };
    }

    const normalizedPromos = promotions.map((p) => this.normalize(p));

    // 1. Filter eligible promotions
    const eligiblePromos = normalizedPromos.filter(
      (p) => this.isEligible(p, items, context).eligible,
    );
    if (eligiblePromos.length === 0) {
      return {
        appliedPromotions: [],
        subtotalAmount,
        totalDiscountAmount: 0,
        itemDiscounts: items.map((it) => ({ listingId: it.listingId, discountAmount: 0 })),
        merchantDiscounts: {},
        finalTotalAmount: subtotalAmount,
      };
    }

    // 2. Sort eligible promotions by precedence tier
    const getTier = (p: NormalizedPromotion): number => {
      if (p.scope === 'PRODUCT') return 1;
      if (p.scope === 'CATEGORY') return 2;
      if (p.merchant_tenant_id) return 3; // Merchant-level
      return 4; // Platform-level
    };

    const sortedPromos = [...eligiblePromos].sort((a, b) => {
      const tierDiff = getTier(a) - getTier(b);
      if (tierDiff !== 0) return tierDiff;
      // Secondary: higher discount value first
      if (b.discount_value !== a.discount_value) return b.discount_value - a.discount_value;
      // Deterministic tie-breaker
      return a.id.localeCompare(b.id);
    });

    // 3. Evaluate scenarios:
    // Scenario A: Stacking pipeline of all stackable promotions in precedence order
    const stackablePromos = sortedPromos.filter((p) => p.stackable);
    const stackablePlan = this.simulatePipeline(stackablePromos, items);

    // Scenario B: Individual non-stackable promotions (each tested individually)
    const nonStackablePromos = sortedPromos.filter((p) => !p.stackable);
    const individualPlans = nonStackablePromos.map((p) => this.simulatePipeline([p], items));

    // Find the best plan (maximum total discount)
    const allPlans = [stackablePlan, ...individualPlans].filter((p) => p.totalDiscountAmount > 0);

    if (allPlans.length === 0) {
      return {
        appliedPromotions: [],
        subtotalAmount,
        totalDiscountAmount: 0,
        itemDiscounts: items.map((it) => ({ listingId: it.listingId, discountAmount: 0 })),
        merchantDiscounts: {},
        finalTotalAmount: subtotalAmount,
      };
    }

    // Sort plans by: total discount DESC, then least number of promotions, then lowest promotion ID
    allPlans.sort((a, b) => {
      if (b.totalDiscountAmount !== a.totalDiscountAmount) {
        return b.totalDiscountAmount - a.totalDiscountAmount;
      }
      if (a.appliedPromotions.length !== b.appliedPromotions.length) {
        return a.appliedPromotions.length - b.appliedPromotions.length;
      }
      const firstA = a.appliedPromotions[0]?.promotionId ?? '';
      const firstB = b.appliedPromotions[0]?.promotionId ?? '';
      return firstA.localeCompare(firstB);
    });

    const chosenPlan = allPlans[0]!;

    // Compute merchant discount aggregations
    const merchantDiscounts: Record<string, number> = {};
    for (const it of items) {
      const d = chosenPlan.itemDeductions.get(it.listingId) ?? 0;
      merchantDiscounts[it.merchantTenantId] = (merchantDiscounts[it.merchantTenantId] ?? 0) + d;
    }

    const itemDiscounts = items.map((it) => ({
      listingId: it.listingId,
      discountAmount: chosenPlan.itemDeductions.get(it.listingId) ?? 0,
    }));

    const finalTotalAmount = Math.max(0, subtotalAmount - chosenPlan.totalDiscountAmount);

    return {
      appliedPromotions: chosenPlan.appliedPromotions,
      subtotalAmount,
      totalDiscountAmount: chosenPlan.totalDiscountAmount,
      itemDiscounts,
      merchantDiscounts,
      finalTotalAmount,
    };
  }

  /**
   * Sequentially simulate discount pipeline on items.
   */
  private static simulatePipeline(
    promos: NormalizedPromotion[],
    items: CalculateDiscountItem[],
  ): {
    appliedPromotions: AppliedPromotionSnapshot[];
    totalDiscountAmount: number;
    itemDeductions: Map<string, number>;
  } {
    const remainingByItem = items.map((item) => ({
      item,
      remaining: item.lineTotalAmount,
    }));

    const totalItemDeductions = new Map<string, number>();
    const applied: AppliedPromotionSnapshot[] = [];
    let totalDiscount = 0;

    for (const promo of promos) {
      const { discountAmount, itemDeductions } = this.calculateSingleDiscount(
        promo,
        remainingByItem,
      );
      if (discountAmount > 0) {
        totalDiscount += discountAmount;
        for (const [listingId, ded] of itemDeductions.entries()) {
          totalItemDeductions.set(listingId, (totalItemDeductions.get(listingId) ?? 0) + ded);
          const r = remainingByItem.find((entry) => entry.item.listingId === listingId);
          if (r) {
            r.remaining = Math.max(0, r.remaining - ded);
          }
        }
        applied.push({
          promotionId: promo.id,
          code: promo.code,
          name: promo.name,
          discountType: promo.discount_type,
          discountValue: promo.discount_value,
          scope: promo.scope,
          merchantTenantId: promo.merchant_tenant_id,
          discountAmount,
          explanation:
            promo.discount_type === 'PERCENTAGE'
              ? `${promo.discount_value}% off (saved ${discountAmount})`
              : `Fixed discount of ${discountAmount}`,
        });
      }
    }

    return {
      appliedPromotions: applied,
      totalDiscountAmount: totalDiscount,
      itemDeductions: totalItemDeductions,
    };
  }
}
