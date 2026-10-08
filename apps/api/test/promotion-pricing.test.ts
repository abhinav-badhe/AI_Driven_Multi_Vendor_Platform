import { describe, it, expect, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { parseConfig } from '../src/config/index.js';
import {
  createMigratedTestDatabase,
  registerVerifiedUser,
} from './helpers/test-db.js';
import type { DatabaseConnection } from '../src/infra/database/connection.js';
import { InMemoryEventTransport, EventTypes } from '../src/modules/events/index.js';
import { InMemorySearchStore } from '../src/modules/search/index.js';
import { JsonLogger } from '../src/observability/logger.js';
import {
  PromotionService,
  DiscountCalculator,
  type CalculateDiscountItem,
  type PromotionRow,
} from '../src/modules/promotion-pricing/index.js';
import type { AuthorizedActor } from '../src/modules/identity/index.js';

describe('Promotion & Coupon Engine - Comprehensive Production Suite', () => {
  let app: FastifyInstance;
  let db: DatabaseConnection;
  let eventTransport: InMemoryEventTransport;
  let searchStore: InMemorySearchStore;
  let promotionService: PromotionService;
  let testConfig: ReturnType<typeof parseConfig>;
  const logger = new JsonLogger({
    serviceName: 'promotion-test',
    level: 'error',
    pretty: false,
    redactKeys: [],
  });

  // Actors
  let adminActor: AuthorizedActor;
  let merchantAlphaActor: AuthorizedActor;
  let merchantBetaActor: AuthorizedActor;
  let merchantBetaToken: string;

  let customer1Actor: AuthorizedActor;
  let customer1Token: string;

  let customer2Actor: AuthorizedActor;
  let customer2Token: string;

  // Test catalog fixtures
  let product1Id: string;
  let product2Id: string;
  let categoryElectronicsId: string;
  let categoryApparelId: string;
  let sku1Id: string;
  let sku2Id: string;
  let listing1Id: string;
  let listing2Id: string;

  beforeEach(async () => {
    db = await createMigratedTestDatabase();
    eventTransport = new InMemoryEventTransport();
    searchStore = new InMemorySearchStore();
    promotionService = new PromotionService(db, logger);

    testConfig = parseConfig({
      NODE_ENV: 'test',
      PORT: '0',
      HOST: '127.0.0.1',
      LOG_LEVEL: 'fatal',
      DATABASE_HOST: 'localhost',
      DATABASE_PORT: '5432',
      DATABASE_NAME: 'test_db',
      DATABASE_USER: 'test_user',
      DATABASE_PASSWORD: 'test_password',
      DATABASE_POOL_MIN: '1',
      DATABASE_POOL_MAX: '5',
      REDIS_HOST: 'localhost',
      REDIS_PORT: '6379',
      REDIS_PASSWORD: '',
      REDIS_TLS: 'false',
      ACCESS_TOKEN_SECRET: 'test_secret_must_be_at_least_32_chars_long_12345',
      SERVICE_NAME: 'promotion-test',
      LOG_PRETTY: 'false',
      REDACT_KEYS: 'password,token',
    });

    app = await buildApp({
      config: testConfig,
      logger,
      dbConnection: db,
      eventTransport,
      searchStore,
      skipMigrations: true,
    });

    // 1. Setup Admin
    await registerVerifiedUser(app, db, {
      email: 'admin@platform.com',
      password: 'AdminPassword123!',
      tenantName: 'Platform Tenant',
      role: 'MERCHANT',
    });
    const adminUserRes = await db.query<{ id: string; tenant_id: string }>(
      `SELECT u.id, tm.tenant_id FROM users u JOIN tenant_memberships tm ON u.id = tm.user_id WHERE u.email = $1`,
      ['admin@platform.com'],
    );
    await db.query(`UPDATE tenant_memberships SET role = 'ADMINISTRATOR' WHERE user_id = $1`, [
      adminUserRes.rows[0]!.id,
    ]);
    adminActor = {
      userId: adminUserRes.rows[0]!.id,
      tenantId: adminUserRes.rows[0]!.tenant_id,
      role: 'ADMINISTRATOR',
    };

    // 2. Setup Merchant Alpha
    await registerVerifiedUser(app, db, {
      email: 'merchant.alpha@store.com',
      password: 'MerchantPass123!',
      tenantName: 'Merchant Alpha Store',
      role: 'MERCHANT',
    });
    const mAlphaRes = await db.query<{ id: string; tenant_id: string }>(
      `SELECT u.id, tm.tenant_id FROM users u JOIN tenant_memberships tm ON u.id = tm.user_id WHERE u.email = $1`,
      ['merchant.alpha@store.com'],
    );
    merchantAlphaActor = {
      userId: mAlphaRes.rows[0]!.id,
      tenantId: mAlphaRes.rows[0]!.tenant_id,
      role: 'MERCHANT',
    };

    // 3. Setup Merchant Beta
    merchantBetaToken = await registerVerifiedUser(app, db, {
      email: 'merchant.beta@store.com',
      password: 'MerchantPass123!',
      tenantName: 'Merchant Beta Store',
      role: 'MERCHANT',
    });
    const mBetaRes = await db.query<{ id: string; tenant_id: string }>(
      `SELECT u.id, tm.tenant_id FROM users u JOIN tenant_memberships tm ON u.id = tm.user_id WHERE u.email = $1`,
      ['merchant.beta@store.com'],
    );
    merchantBetaActor = {
      userId: mBetaRes.rows[0]!.id,
      tenantId: mBetaRes.rows[0]!.tenant_id,
      role: 'MERCHANT',
    };

    // 4. Setup Customer 1
    customer1Token = await registerVerifiedUser(app, db, {
      email: 'customer1@shopper.com',
      password: 'CustomerPass123!',
      tenantName: 'Customer One',
      role: 'CUSTOMER',
    });
    const c1Res = await db.query<{ id: string; tenant_id: string }>(
      `SELECT u.id, tm.tenant_id FROM users u JOIN tenant_memberships tm ON u.id = tm.user_id WHERE u.email = $1`,
      ['customer1@shopper.com'],
    );
    customer1Actor = {
      userId: c1Res.rows[0]!.id,
      tenantId: c1Res.rows[0]!.tenant_id,
      role: 'CUSTOMER',
    };

    // 5. Setup Customer 2
    customer2Token = await registerVerifiedUser(app, db, {
      email: 'customer2@shopper.com',
      password: 'CustomerPass123!',
      tenantName: 'Customer Two',
      role: 'CUSTOMER',
    });
    const c2Res = await db.query<{ id: string; tenant_id: string }>(
      `SELECT u.id, tm.tenant_id FROM users u JOIN tenant_memberships tm ON u.id = tm.user_id WHERE u.email = $1`,
      ['customer2@shopper.com'],
    );
    customer2Actor = {
      userId: c2Res.rows[0]!.id,
      tenantId: c2Res.rows[0]!.tenant_id,
      role: 'CUSTOMER',
    };

    // Seed Categories
    categoryElectronicsId = randomUUID();
    categoryApparelId = randomUUID();
    await db.query(
      `INSERT INTO categories (id, name, slug) VALUES ($1, 'Electronics', 'electronics'), ($2, 'Apparel', 'apparel')`,
      [categoryElectronicsId, categoryApparelId],
    );

    // Seed Products
    product1Id = randomUUID();
    product2Id = randomUUID();
    await db.query(
      `INSERT INTO products (id, title, slug, category_id, status) VALUES
       ($1, 'Wireless Headphones', 'headphones-' || $1, $2, 'ACTIVE'),
       ($3, 'Cotton T-Shirt', 'tshirt-' || $3, $4, 'ACTIVE')`,
      [product1Id, categoryElectronicsId, product2Id, categoryApparelId],
    );

    // Seed SKUs
    sku1Id = randomUUID();
    sku2Id = randomUUID();
    await db.query(
      `INSERT INTO product_skus (id, product_id, sku_code, status) VALUES
       ($1, $2, 'SKU-HEADPHONES-BLK', 'ACTIVE'),
       ($3, $4, 'SKU-TSHIRT-BLU', 'ACTIVE')`,
      [sku1Id, product1Id, sku2Id, product2Id],
    );

    // Seed Listings
    listing1Id = randomUUID(); // Merchant Alpha listing: $100.00 (10000 minor units)
    listing2Id = randomUUID(); // Merchant Beta listing: $50.00 (5000 minor units)
    await db.query(
      `INSERT INTO merchant_listings (id, tenant_id, sku_id, price_amount, currency, status) VALUES
       ($1, $2, $3, 10000, 'USD', 'ACTIVE'),
       ($4, $5, $6, 5000, 'USD', 'ACTIVE')`,
      [listing1Id, merchantAlphaActor.tenantId, sku1Id, listing2Id, merchantBetaActor.tenantId, sku2Id],
    );

    // Seed Inventory for both listings
    await db.query(
      `INSERT INTO inventory_items (id, tenant_id, listing_id, sku_id, on_hand_quantity, reserved_quantity, non_sellable_quantity, version) VALUES
       ($1, $2, $3, $4, 100, 0, 0, 1),
       ($5, $6, $7, $8, 100, 0, 0, 1)`,
      [
        randomUUID(),
        merchantAlphaActor.tenantId,
        listing1Id,
        sku1Id,
        randomUUID(),
        merchantBetaActor.tenantId,
        listing2Id,
        sku2Id,
      ],
    );
  });

  // Helper to create checkout session
  async function setupCheckoutSession(
    customerToken: string,
    items: Array<{ listingId: string; quantity: number }>,
  ): Promise<string> {
    // Add items to cart
    for (const item of items) {
      await app.inject({
        method: 'POST',
        url: '/cart/items',
        headers: { authorization: `Bearer ${customerToken}` },
        payload: { listingId: item.listingId, quantity: item.quantity },
      });
    }

    const res = await app.inject({
      method: 'POST',
      url: '/checkout/sessions',
      headers: { authorization: `Bearer ${customerToken}` },
      payload: {},
    });
    expect(res.statusCode).toBe(201);
    return res.json().id;
  }

  // --- 1. Percentage Discount ---
  it('1. percentage discount calculates exact minor unit amount', async () => {
    await promotionService.createPromotion(adminActor, {
      name: '20% Off Everything',
      code: 'SAVE20',
      discountType: 'PERCENTAGE',
      discountValue: 20,
      scope: 'ORDER',
      startsAt: new Date(Date.now() - 3600000),
    });

    const items: CalculateDiscountItem[] = [
      {
        listingId: listing1Id,
        skuId: sku1Id,
        merchantTenantId: merchantAlphaActor.tenantId,
        quantity: 1,
        unitPriceAmount: 10000, // $100.00
        lineTotalAmount: 10000,
      },
    ];

    const result = await promotionService.previewDiscounts(customer1Actor, {
      items,
      couponCode: 'SAVE20',
      currency: 'USD',
    });

    expect(result.totalDiscountAmount).toBe(2000); // 20% of 10000 = 2000
    expect(result.finalTotalAmount).toBe(8000);
    expect(result.appliedPromotions[0]?.code).toBe('SAVE20');
  });

  // --- 2. Fixed Discount ---
  it('2. fixed discount subtracts exact monetary value', async () => {
    await promotionService.createPromotion(adminActor, {
      name: '$15 Off Flat',
      code: 'FLAT15',
      discountType: 'FIXED_AMOUNT',
      discountValue: 1500, // $15.00
      scope: 'ORDER',
      startsAt: new Date(Date.now() - 3600000),
    });

    const items: CalculateDiscountItem[] = [
      {
        listingId: listing1Id,
        skuId: sku1Id,
        merchantTenantId: merchantAlphaActor.tenantId,
        quantity: 1,
        unitPriceAmount: 10000,
        lineTotalAmount: 10000,
      },
    ];

    const result = await promotionService.previewDiscounts(customer1Actor, {
      items,
      couponCode: 'FLAT15',
      currency: 'USD',
    });

    expect(result.totalDiscountAmount).toBe(1500);
    expect(result.finalTotalAmount).toBe(8500);
  });

  // --- 3. Maximum Discount Cap ---
  it('3. maximum discount cap enforces upper limit on percentage discounts', async () => {
    await promotionService.createPromotion(adminActor, {
      name: '50% Off Capped at $25',
      code: 'HALFCAP',
      discountType: 'PERCENTAGE',
      discountValue: 50,
      maxDiscountAmount: 2500, // Cap at $25.00
      scope: 'ORDER',
      startsAt: new Date(Date.now() - 3600000),
    });

    const items: CalculateDiscountItem[] = [
      {
        listingId: listing1Id,
        skuId: sku1Id,
        merchantTenantId: merchantAlphaActor.tenantId,
        quantity: 2, // Total $200.00 (20000 minor units). 50% would be 10000, but cap is 2500.
        unitPriceAmount: 10000,
        lineTotalAmount: 20000,
      },
    ];

    const result = await promotionService.previewDiscounts(customer1Actor, {
      items,
      couponCode: 'HALFCAP',
      currency: 'USD',
    });

    expect(result.totalDiscountAmount).toBe(2500);
    expect(result.finalTotalAmount).toBe(17500);
  });

  // --- 4. Minimum Cart Value ---
  it('4. minimum cart value rejects promotion when subtotal is below threshold', async () => {
    await promotionService.createPromotion(adminActor, {
      name: 'Spend $150 Get $20 Off',
      code: 'MIN150',
      discountType: 'FIXED_AMOUNT',
      discountValue: 2000,
      minOrderAmount: 15000, // $150.00
      scope: 'ORDER',
      startsAt: new Date(Date.now() - 3600000),
    });

    const itemsBelow: CalculateDiscountItem[] = [
      {
        listingId: listing1Id,
        skuId: sku1Id,
        merchantTenantId: merchantAlphaActor.tenantId,
        quantity: 1, // Only $100.00
        unitPriceAmount: 10000,
        lineTotalAmount: 10000,
      },
    ];

    const resultBelow = await promotionService.previewDiscounts(customer1Actor, {
      items: itemsBelow,
      couponCode: 'MIN150',
      currency: 'USD',
    });
    expect(resultBelow.totalDiscountAmount).toBe(0);

    const itemsAbove: CalculateDiscountItem[] = [
      {
        listingId: listing1Id,
        skuId: sku1Id,
        merchantTenantId: merchantAlphaActor.tenantId,
        quantity: 2, // $200.00
        unitPriceAmount: 10000,
        lineTotalAmount: 20000,
      },
    ];

    const resultAbove = await promotionService.previewDiscounts(customer1Actor, {
      items: itemsAbove,
      couponCode: 'MIN150',
      currency: 'USD',
    });
    expect(resultAbove.totalDiscountAmount).toBe(2000);
    expect(resultAbove.finalTotalAmount).toBe(18000);
  });

  // --- 5. Product Promotion ---
  it('5. product promotion applies only to qualifying target product items', async () => {
    await promotionService.createPromotion(adminActor, {
      name: 'Headphones Exclusive 25% Off',
      code: 'HEADPHONE25',
      discountType: 'PERCENTAGE',
      discountValue: 25,
      scope: 'PRODUCT',
      targetIds: [product1Id],
      startsAt: new Date(Date.now() - 3600000),
    });

    const items: CalculateDiscountItem[] = [
      {
        listingId: listing1Id,
        skuId: sku1Id,
        productId: product1Id, // Qualifying: $100
        merchantTenantId: merchantAlphaActor.tenantId,
        quantity: 1,
        unitPriceAmount: 10000,
        lineTotalAmount: 10000,
      },
      {
        listingId: listing2Id,
        skuId: sku2Id,
        productId: product2Id, // Non-qualifying: $50
        merchantTenantId: merchantBetaActor.tenantId,
        quantity: 1,
        unitPriceAmount: 5000,
        lineTotalAmount: 5000,
      },
    ];

    const result = await promotionService.previewDiscounts(customer1Actor, {
      items,
      couponCode: 'HEADPHONE25',
      currency: 'USD',
    });

    // 25% of 10000 = 2500, non-qualifying item receives 0
    expect(result.totalDiscountAmount).toBe(2500);
    expect(result.finalTotalAmount).toBe(12500); // 15000 - 2500
    const headphoneDiscount = result.itemDiscounts.find((it) => it.listingId === listing1Id);
    const tshirtDiscount = result.itemDiscounts.find((it) => it.listingId === listing2Id);
    expect(headphoneDiscount?.discountAmount).toBe(2500);
    expect(tshirtDiscount?.discountAmount).toBe(0);
  });

  // --- 6. Category Promotion ---
  it('6. category promotion discounts only items belonging to specified category', async () => {
    await promotionService.createPromotion(adminActor, {
      name: 'Electronics 10% Off',
      code: 'ELEC10',
      discountType: 'PERCENTAGE',
      discountValue: 10,
      scope: 'CATEGORY',
      targetIds: [categoryElectronicsId],
      startsAt: new Date(Date.now() - 3600000),
    });

    const items: CalculateDiscountItem[] = [
      {
        listingId: listing1Id,
        skuId: sku1Id,
        productId: product1Id,
        categoryId: categoryElectronicsId, // Matches
        merchantTenantId: merchantAlphaActor.tenantId,
        quantity: 1,
        unitPriceAmount: 10000,
        lineTotalAmount: 10000,
      },
      {
        listingId: listing2Id,
        skuId: sku2Id,
        productId: product2Id,
        categoryId: categoryApparelId, // Does not match
        merchantTenantId: merchantBetaActor.tenantId,
        quantity: 1,
        unitPriceAmount: 5000,
        lineTotalAmount: 5000,
      },
    ];

    const result = await promotionService.previewDiscounts(customer1Actor, {
      items,
      couponCode: 'ELEC10',
      currency: 'USD',
    });

    expect(result.totalDiscountAmount).toBe(1000); // 10% of 10000
    expect(result.finalTotalAmount).toBe(14000);
  });

  // --- 7. Merchant Promotion ---
  it('7. merchant promotion restricts discounts strictly to that merchant items', async () => {
    // Merchant Alpha creates a $30 off promo
    await promotionService.createPromotion(merchantAlphaActor, {
      name: 'Alpha Store Special',
      code: 'ALPHA30',
      merchantTenantId: merchantAlphaActor.tenantId,
      discountType: 'FIXED_AMOUNT',
      discountValue: 3000,
      scope: 'ORDER',
      startsAt: new Date(Date.now() - 3600000),
    });

    const mixedItems: CalculateDiscountItem[] = [
      {
        listingId: listing1Id,
        skuId: sku1Id,
        merchantTenantId: merchantAlphaActor.tenantId,
        quantity: 1,
        unitPriceAmount: 10000,
        lineTotalAmount: 10000,
      },
      {
        listingId: listing2Id,
        skuId: sku2Id,
        merchantTenantId: merchantBetaActor.tenantId,
        quantity: 1,
        unitPriceAmount: 5000,
        lineTotalAmount: 5000,
      },
    ];

    const result = await promotionService.previewDiscounts(customer1Actor, {
      items: mixedItems,
      couponCode: 'ALPHA30',
      currency: 'USD',
    });

    expect(result.totalDiscountAmount).toBe(3000);
    // Merchant Alpha absorbs the entire 3000 discount
    expect(result.merchantDiscounts[merchantAlphaActor.tenantId]).toBe(3000);
    expect(result.merchantDiscounts[merchantBetaActor.tenantId] ?? 0).toBe(0);
  });

  // --- 8. Platform Promotion ---
  it('8. platform promotion applies across multi-vendor order', async () => {
    await promotionService.createPromotion(adminActor, {
      name: 'Global Platform $10 Off',
      code: 'PLATFORM10',
      discountType: 'FIXED_AMOUNT',
      discountValue: 1000,
      scope: 'ORDER',
      startsAt: new Date(Date.now() - 3600000),
    });

    const mixedItems: CalculateDiscountItem[] = [
      {
        listingId: listing1Id,
        skuId: sku1Id,
        merchantTenantId: merchantAlphaActor.tenantId,
        quantity: 1,
        unitPriceAmount: 10000,
        lineTotalAmount: 10000,
      },
      {
        listingId: listing2Id,
        skuId: sku2Id,
        merchantTenantId: merchantBetaActor.tenantId,
        quantity: 1,
        unitPriceAmount: 5000,
        lineTotalAmount: 5000,
      },
    ];

    const result = await promotionService.previewDiscounts(customer1Actor, {
      items: mixedItems,
      couponCode: 'PLATFORM10',
      currency: 'USD',
    });

    expect(result.totalDiscountAmount).toBe(1000);
    expect(result.finalTotalAmount).toBe(14000);
  });

  // --- 9. Expired Coupon ---
  it('9. expired coupon cannot be redeemed', async () => {
    await promotionService.createPromotion(adminActor, {
      name: 'Expired Coupon',
      code: 'EXPIRED10',
      discountType: 'PERCENTAGE',
      discountValue: 10,
      startsAt: new Date(Date.now() - 7200000),
      expiresAt: new Date(Date.now() - 3600000), // Expired 1 hr ago
    });

    const items: CalculateDiscountItem[] = [
      {
        listingId: listing1Id,
        skuId: sku1Id,
        merchantTenantId: merchantAlphaActor.tenantId,
        quantity: 1,
        unitPriceAmount: 10000,
        lineTotalAmount: 10000,
      },
    ];

    const result = await promotionService.previewDiscounts(customer1Actor, {
      items,
      couponCode: 'EXPIRED10',
      currency: 'USD',
    });

    expect(result.totalDiscountAmount).toBe(0);
  });

  // --- 10. Future Coupon ---
  it('10. future promotion cannot be redeemed before start date', async () => {
    await promotionService.createPromotion(adminActor, {
      name: 'Future Black Friday',
      code: 'BLACKFRIDAY',
      discountType: 'PERCENTAGE',
      discountValue: 50,
      startsAt: new Date(Date.now() + 86400000), // Starts tomorrow
    });

    const items: CalculateDiscountItem[] = [
      {
        listingId: listing1Id,
        skuId: sku1Id,
        merchantTenantId: merchantAlphaActor.tenantId,
        quantity: 1,
        unitPriceAmount: 10000,
        lineTotalAmount: 10000,
      },
    ];

    const result = await promotionService.previewDiscounts(customer1Actor, {
      items,
      couponCode: 'BLACKFRIDAY',
      currency: 'USD',
    });

    expect(result.totalDiscountAmount).toBe(0);
  });

  // --- 11. Inactive Coupon ---
  it('11. inactive coupon is rejected', async () => {
    await promotionService.createPromotion(adminActor, {
      name: 'Disabled Promo',
      code: 'DISABLED',
      discountType: 'PERCENTAGE',
      discountValue: 20,
      status: 'INACTIVE',
      startsAt: new Date(Date.now() - 3600000),
    });

    const items: CalculateDiscountItem[] = [
      {
        listingId: listing1Id,
        skuId: sku1Id,
        merchantTenantId: merchantAlphaActor.tenantId,
        quantity: 1,
        unitPriceAmount: 10000,
        lineTotalAmount: 10000,
      },
    ];

    const result = await promotionService.previewDiscounts(customer1Actor, {
      items,
      couponCode: 'DISABLED',
      currency: 'USD',
    });

    expect(result.totalDiscountAmount).toBe(0);
  });

  // --- 12. Invalid Coupon ---
  it('12. invalid coupon code returns clean error response', async () => {
    const sessionId = await setupCheckoutSession(customer1Token, [{ listingId: listing1Id, quantity: 1 }]);

    const res = await app.inject({
      method: 'POST',
      url: `/checkout/sessions/${sessionId}/coupon`,
      headers: { authorization: `Bearer ${customer1Token}` },
      payload: { couponCode: 'DOESNOTEXIST' },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().error?.message ?? res.json().message).toMatch(/Coupon code 'DOESNOTEXIST' is invalid/);
  });

  // --- 13. Wrong Merchant ---
  it('13. wrong merchant coupon is rejected when cart has no items from that merchant', async () => {
    // Merchant Alpha creates coupon
    await promotionService.createPromotion(merchantAlphaActor, {
      name: 'Alpha Exclusive',
      code: 'ALPHAONLY',
      merchantTenantId: merchantAlphaActor.tenantId,
      discountType: 'PERCENTAGE',
      discountValue: 15,
      startsAt: new Date(Date.now() - 3600000),
    });

    // Cart only contains Merchant Beta items
    const sessionId = await setupCheckoutSession(customer1Token, [{ listingId: listing2Id, quantity: 1 }]);

    const res = await app.inject({
      method: 'POST',
      url: `/checkout/sessions/${sessionId}/coupon`,
      headers: { authorization: `Bearer ${customer1Token}` },
      payload: { couponCode: 'ALPHAONLY' },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error?.message ?? res.json().message).toMatch(/Promotion is only valid for products from merchant/);
  });

  // --- 14. Cross-Tenant Access ---
  it('14. cross-tenant access prevents a merchant from modifying or reading other merchant promotions', async () => {
    const alphaPromo = await promotionService.createPromotion(merchantAlphaActor, {
      name: 'Alpha Secret Promo',
      code: 'ALPHASECRET',
      merchantTenantId: merchantAlphaActor.tenantId,
      discountType: 'PERCENTAGE',
      discountValue: 10,
      startsAt: new Date(Date.now() - 3600000),
    });

    // Merchant Beta attempts to modify Merchant Alpha's promotion
    const updateRes = await app.inject({
      method: 'PATCH',
      url: `/promotions/${alphaPromo.id}`,
      headers: { authorization: `Bearer ${merchantBetaToken}` },
      payload: { discountValue: 90 },
    });
    expect(updateRes.statusCode).toBe(403);

    // Merchant Beta attempts to view Merchant Alpha's promotion
    const getRes = await app.inject({
      method: 'GET',
      url: `/promotions/${alphaPromo.id}`,
      headers: { authorization: `Bearer ${merchantBetaToken}` },
    });
    expect(getRes.statusCode).toBe(403);
  });

  // --- 15. Global Usage Limit ---
  it('15. global usage limit blocks redemption after threshold reached', async () => {
    const promo = await promotionService.createPromotion(adminActor, {
      name: 'Limited 1 Use Coupon',
      code: 'ONEUSE',
      discountType: 'FIXED_AMOUNT',
      discountValue: 1000,
      usageLimitTotal: 1, // Only 1 total use allowed
      startsAt: new Date(Date.now() - 3600000),
    });

    // Artificially simulate 1 prior redemption
    await db.query(`UPDATE promotions SET current_usage_count = 1 WHERE id = $1`, [promo.id]);

    const sessionId = await setupCheckoutSession(customer1Token, [{ listingId: listing1Id, quantity: 1 }]);

    const res = await app.inject({
      method: 'POST',
      url: `/checkout/sessions/${sessionId}/coupon`,
      headers: { authorization: `Bearer ${customer1Token}` },
      payload: { couponCode: 'ONEUSE' },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error?.message ?? res.json().message).toMatch(/reached its global usage limit/);
  });

  // --- 16. Per-Customer Usage Limit ---
  it('16. per-customer usage limit prevents customer from exceeding individual limit', async () => {
    const promo = await promotionService.createPromotion(adminActor, {
      name: '1 Per Customer',
      code: 'ONCEPERCUST',
      discountType: 'FIXED_AMOUNT',
      discountValue: 1000,
      usageLimitPerCustomer: 1,
      startsAt: new Date(Date.now() - 3600000),
    });

    // Simulate prior redemption by customer 1
    await db.query(
      `INSERT INTO coupon_redemptions (
        id, promotion_id, coupon_code, checkout_session_id, customer_tenant_id, discount_amount, currency, status
      ) VALUES ($1, $2, 'ONCEPERCUST', 'prev_checkout', $3, 1000, 'USD', 'COMPLETED')`,
      [randomUUID(), promo.id, customer1Actor.tenantId],
    );

    // Customer 1 tries again -> rejected
    const session1Id = await setupCheckoutSession(customer1Token, [{ listingId: listing1Id, quantity: 1 }]);
    const res1 = await app.inject({
      method: 'POST',
      url: `/checkout/sessions/${session1Id}/coupon`,
      headers: { authorization: `Bearer ${customer1Token}` },
      payload: { couponCode: 'ONCEPERCUST' },
    });
    expect(res1.statusCode).toBe(400);
    expect(res1.json().error?.message ?? res1.json().message).toMatch(/Customer has reached usage limit/);

    // Customer 2 tries -> allowed!
    const session2Id = await setupCheckoutSession(customer2Token, [{ listingId: listing1Id, quantity: 1 }]);
    const res2 = await app.inject({
      method: 'POST',
      url: `/checkout/sessions/${session2Id}/coupon`,
      headers: { authorization: `Bearer ${customer2Token}` },
      payload: { couponCode: 'ONCEPERCUST' },
    });
    expect(res2.statusCode).toBe(200);
    expect(res2.json().discountAmount).toBe(1000);
  });

  // --- 17. Concurrent Redemption ---
  it('17. concurrent redemption enforces atomic locking and prevents overselling usage limits', async () => {
    const promo = await promotionService.createPromotion(adminActor, {
      name: 'Flash Sale (Only 1 Remaining)',
      code: 'RACEONE',
      discountType: 'FIXED_AMOUNT',
      discountValue: 2000,
      usageLimitTotal: 1,
      startsAt: new Date(Date.now() - 3600000),
    });

    // Both customers create checkout and apply coupon
    const s1 = await setupCheckoutSession(customer1Token, [{ listingId: listing1Id, quantity: 1 }]);
    const s2 = await setupCheckoutSession(customer2Token, [{ listingId: listing1Id, quantity: 1 }]);

    await app.inject({
      method: 'POST',
      url: `/checkout/sessions/${s1}/coupon`,
      headers: { authorization: `Bearer ${customer1Token}` },
      payload: { couponCode: 'RACEONE' },
    });

    await app.inject({
      method: 'POST',
      url: `/checkout/sessions/${s2}/coupon`,
      headers: { authorization: `Bearer ${customer2Token}` },
      payload: { couponCode: 'RACEONE' },
    });

    // Customer 1 finalizes order under transaction lock
    await db.withTransaction(async (tx) => {
      await promotionService.finalizeRedemption(tx, {
        checkoutSessionId: s1,
        customerOrderId: 'order_1',
        customerTenantId: customer1Actor.tenantId,
        actor: customer1Actor,
      });
    });

    // Customer 2 tries to finalize order -> must fail with ConflictError
    await expect(
      db.withTransaction(async (tx) => {
        await promotionService.finalizeRedemption(tx, {
          checkoutSessionId: s2,
          customerOrderId: 'order_2',
          customerTenantId: customer2Actor.tenantId,
          actor: customer2Actor,
        });
      }),
    ).rejects.toThrow(/usage limit has been reached by a concurrent order/);

    // Verify current_usage_count strictly equals 1
    const finalPromo = await promotionService.getPromotion(adminActor, promo.id);
    expect(finalPromo.currentUsageCount).toBe(1);
  });

  // --- 18. Duplicate Checkout Retry ---
  it('18. duplicate checkout retry is idempotent and never double-counts coupon usage', async () => {
    const promo = await promotionService.createPromotion(adminActor, {
      name: 'Idempotency Check',
      code: 'IDEMP10',
      discountType: 'FIXED_AMOUNT',
      discountValue: 1000,
      usageLimitTotal: 10,
      startsAt: new Date(Date.now() - 3600000),
    });

    const s1 = await setupCheckoutSession(customer1Token, [{ listingId: listing1Id, quantity: 1 }]);
    await app.inject({
      method: 'POST',
      url: `/checkout/sessions/${s1}/coupon`,
      headers: { authorization: `Bearer ${customer1Token}` },
      payload: { couponCode: 'IDEMP10' },
    });

    // Finalize first attempt
    await db.withTransaction(async (tx) => {
      await promotionService.finalizeRedemption(tx, {
        checkoutSessionId: s1,
        customerOrderId: 'order_idem_1',
        customerTenantId: customer1Actor.tenantId,
        actor: customer1Actor,
      });
    });

    const pAfterFirst = await promotionService.getPromotion(adminActor, promo.id);
    expect(pAfterFirst.currentUsageCount).toBe(1);

    // Retry with the exact same checkout session
    await db.withTransaction(async (tx) => {
      await promotionService.finalizeRedemption(tx, {
        checkoutSessionId: s1,
        customerOrderId: 'order_idem_1',
        customerTenantId: customer1Actor.tenantId,
        actor: customer1Actor,
      });
    });

    // Usage count is still 1 (never double-counted!)
    const pAfterRetry = await promotionService.getPromotion(adminActor, promo.id);
    expect(pAfterRetry.currentUsageCount).toBe(1);
  });

  // --- 19. Checkout / Payment Failure ---
  it('19. checkout / payment failure releases reservation and rolls back safely', async () => {
    const promo = await promotionService.createPromotion(adminActor, {
      name: 'Failure Rollback Test',
      code: 'ROLLBACK50',
      discountType: 'FIXED_AMOUNT',
      discountValue: 5000,
      usageLimitTotal: 5,
      startsAt: new Date(Date.now() - 3600000),
    });

    const s1 = await setupCheckoutSession(customer1Token, [{ listingId: listing1Id, quantity: 1 }]);
    await app.inject({
      method: 'POST',
      url: `/checkout/sessions/${s1}/coupon`,
      headers: { authorization: `Bearer ${customer1Token}` },
      payload: { couponCode: 'ROLLBACK50' },
    });

    // Simulate transaction crash during order placement
    try {
      await db.withTransaction(async (tx) => {
        await promotionService.finalizeRedemption(tx, {
          checkoutSessionId: s1,
          customerOrderId: 'order_fail',
          customerTenantId: customer1Actor.tenantId,
          actor: customer1Actor,
        });
        throw new Error('Simulated database crash / payment failure');
      });
    } catch {
      // Expected rollback
    }

    // Usage count must remain 0
    const pAfterCrash = await promotionService.getPromotion(adminActor, promo.id);
    expect(pAfterCrash.currentUsageCount).toBe(0);

    // Furthermore, explicit reversal mechanism works crash-safely
    await db.withTransaction(async (tx) => {
      await promotionService.finalizeRedemption(tx, {
        checkoutSessionId: s1,
        customerOrderId: 'order_to_reverse',
        customerTenantId: customer1Actor.tenantId,
        actor: customer1Actor,
      });
    });
    expect((await promotionService.getPromotion(adminActor, promo.id)).currentUsageCount).toBe(1);

    await db.withTransaction(async (tx) => {
      await promotionService.reverseRedemption(tx, {
        checkoutSessionId: s1,
        customerOrderId: 'order_to_reverse',
        reason: 'PAYMENT_FAILED',
      });
    });
    expect((await promotionService.getPromotion(adminActor, promo.id)).currentUsageCount).toBe(0);
  });

  // --- 20. Order Historical Price Snapshot ---
  it('20. order historical price snapshot persists and does not mutate when promotion is edited', async () => {
    const promo = await promotionService.createPromotion(adminActor, {
      name: 'Original 25% Off',
      code: 'ORIGINAL25',
      discountType: 'PERCENTAGE',
      discountValue: 25,
      startsAt: new Date(Date.now() - 3600000),
    });

    const s1 = await setupCheckoutSession(customer1Token, [{ listingId: listing1Id, quantity: 1 }]);
    const couponRes = await app.inject({
      method: 'POST',
      url: `/checkout/sessions/${s1}/coupon`,
      headers: { authorization: `Bearer ${customer1Token}` },
      payload: { couponCode: 'ORIGINAL25' },
    });
    expect(couponRes.statusCode).toBe(200);

    // Reserve inventory
    await app.inject({
      method: 'POST',
      url: `/checkout/sessions/${s1}/reserve`,
      headers: { authorization: `Bearer ${customer1Token}` },
    });

    // Create Payment Intent for server-authoritative total ($75.00 = 7500 minor units)
    const piRes = await app.inject({
      method: 'POST',
      url: '/payments/intents',
      headers: { authorization: `Bearer ${customer1Token}` },
      payload: { checkoutSessionId: s1 },
    });
    const paymentIntentId = piRes.json().id;

    // Submit payment attempt
    await app.inject({
      method: 'POST',
      url: `/payments/intents/${paymentIntentId}/attempts`,
      headers: { authorization: `Bearer ${customer1Token}` },
      payload: { paymentMethod: 'pm_card_visa' },
    });

    // Finalize order
    const orderRes = await app.inject({
      method: 'POST',
      url: '/orders',
      headers: { authorization: `Bearer ${customer1Token}` },
      payload: { checkoutSessionId: s1, paymentIntentId },
    });
    expect(orderRes.statusCode).toBe(201);
    const orderId = orderRes.json().id;

    // Historical order has discountAmount: 2500, totalAmount: 7500, couponCode: 'ORIGINAL25'
    const originalOrder = orderRes.json();
    expect(originalOrder.discountAmount).toBe(2500);
    expect(originalOrder.totalAmount).toBe(7500);
    expect(originalOrder.couponCode).toBe('ORIGINAL25');

    // Admin now mutates or deactivates the promotion
    await promotionService.updatePromotion(adminActor, promo.id, {
      discountValue: 5, // Changed to 5%
      status: 'INACTIVE',
    });

    // Re-query historical order from API
    const historicalOrderRes = await app.inject({
      method: 'GET',
      url: `/orders/${orderId}`,
      headers: { authorization: `Bearer ${customer1Token}` },
    });
    expect(historicalOrderRes.statusCode).toBe(200);
    const historicalOrder = historicalOrderRes.json();
    expect(historicalOrder.discountAmount).toBe(2500); // Unchanged!
    expect(historicalOrder.totalAmount).toBe(7500); // Unchanged!
    expect(historicalOrder.couponCode).toBe('ORIGINAL25');
  });

  // --- 21 & 22. Conflicting Promotions & Deterministic Precedence ---
  it('21 & 22. conflicting promotions resolve with deterministic precedence (best eligible discount)', async () => {
    // Promo A: 10% Off
    const promoA = await promotionService.createPromotion(adminActor, {
      name: 'Promo A (10%)',
      code: 'PROMO10',
      discountType: 'PERCENTAGE',
      discountValue: 10,
      stackable: false,
      startsAt: new Date(Date.now() - 3600000),
    });

    // Promo B: 25% Off
    const promoB = await promotionService.createPromotion(adminActor, {
      name: 'Promo B (25%)',
      code: 'PROMO25',
      discountType: 'PERCENTAGE',
      discountValue: 25,
      stackable: false,
      startsAt: new Date(Date.now() - 3600000),
    });

    const items: CalculateDiscountItem[] = [
      {
        listingId: listing1Id,
        skuId: sku1Id,
        merchantTenantId: merchantAlphaActor.tenantId,
        quantity: 1,
        unitPriceAmount: 10000,
        lineTotalAmount: 10000,
      },
    ];

    // Evaluate calculator directly with both non-stackable promotions
    const result = DiscountCalculator.calculateDiscounts(
      [promoA as unknown as PromotionRow, promoB as unknown as PromotionRow],
      items,
      {
        customerTenantId: customer1Actor.tenantId,
        currency: 'USD',
      },
    );

    // Precedence rule chooses the best discount for the customer (Promo B 25% = 2500)
    expect(result.totalDiscountAmount).toBe(2500);
    expect(result.appliedPromotions[0]?.promotionId).toBe(promoB.id);
  });

  // --- 23. Negative Total Prevention ---
  it('23. negative total prevention guarantees discount <= eligible subtotal and final total >= 0', async () => {
    // Fixed discount of $500 on an order of only $100
    await promotionService.createPromotion(adminActor, {
      name: 'Giant $500 Discount',
      code: 'GIANT500',
      discountType: 'FIXED_AMOUNT',
      discountValue: 50000, // $500.00
      startsAt: new Date(Date.now() - 3600000),
    });

    const items: CalculateDiscountItem[] = [
      {
        listingId: listing1Id,
        skuId: sku1Id,
        merchantTenantId: merchantAlphaActor.tenantId,
        quantity: 1,
        unitPriceAmount: 10000, // Only $100.00
        lineTotalAmount: 10000,
      },
    ];

    const result = await promotionService.previewDiscounts(customer1Actor, {
      items,
      couponCode: 'GIANT500',
      currency: 'USD',
    });

    expect(result.totalDiscountAmount).toBe(10000); // Capped at eligible amount
    expect(result.finalTotalAmount).toBe(0); // Never negative
    expect(result.finalTotalAmount).toBeGreaterThanOrEqual(0);
  });

  // --- 24. Monetary Rounding ---
  it('24. monetary rounding executes deterministic integer math without float drift', async () => {
    // 33% discount on $29.99 (2999 minor units)
    // 2999 * 33 / 100 = 989.67 -> Math.round -> 990
    await promotionService.createPromotion(adminActor, {
      name: '33% Off Odd Price',
      code: 'THIRD33',
      discountType: 'PERCENTAGE',
      discountValue: 33,
      startsAt: new Date(Date.now() - 3600000),
    });

    const items: CalculateDiscountItem[] = [
      {
        listingId: listing1Id,
        skuId: sku1Id,
        merchantTenantId: merchantAlphaActor.tenantId,
        quantity: 1,
        unitPriceAmount: 2999,
        lineTotalAmount: 2999,
      },
    ];

    const result = await promotionService.previewDiscounts(customer1Actor, {
      items,
      couponCode: 'THIRD33',
      currency: 'USD',
    });

    expect(result.totalDiscountAmount).toBe(990);
    expect(result.finalTotalAmount).toBe(2009); // 2999 - 990 = 2009
    expect(Number.isInteger(result.totalDiscountAmount)).toBe(true);
    expect(Number.isInteger(result.finalTotalAmount)).toBe(true);
  });

  // --- 25. Authorization ---
  it('25. authorization rejects customers attempting to create promotions', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/promotions',
      headers: { authorization: `Bearer ${customer1Token}` },
      payload: {
        name: 'Hacked Promo',
        code: 'HACK99',
        discountType: 'PERCENTAGE',
        discountValue: 99,
        startsAt: new Date().toISOString(),
      },
    });

    expect(res.statusCode).toBe(403);
  });

  // --- 26. Audit Events ---
  it('26. audit events are recorded for promotion creation and modification', async () => {
    const promo = await promotionService.createPromotion(adminActor, {
      name: 'Audited Campaign',
      code: 'AUDIT10',
      discountType: 'PERCENTAGE',
      discountValue: 10,
      startsAt: new Date(Date.now() - 3600000),
    });

    await promotionService.updatePromotion(adminActor, promo.id, {
      discountValue: 15,
    });

    const auditRes = await db.query<{ event_type: string; metadata: unknown }>(
      `SELECT event_type, metadata FROM security_audit_events WHERE metadata::text LIKE '%${promo.id}%'`,
    );

    expect(auditRes.rows.length).toBeGreaterThanOrEqual(2);
    const types = auditRes.rows.map((r) => r.event_type);
    expect(types).toContain('PROMOTION_CREATED');
    expect(types).toContain('PROMOTION_UPDATED');
  });

  // --- 27. Outbox Atomicity ---
  it('27. outbox atomicity publishes COUPON_REDEEMED event during redemption', async () => {
    let recordedEvent: any = null;
    const outboxService = {
      recordEvent: async (_tx: any, event: any) => {
        recordedEvent = event;
      },
    };

    const promoServiceWithOutbox = new PromotionService(db, logger, outboxService as any);

    await promoServiceWithOutbox.createPromotion(adminActor, {
      name: 'Outbox Promo',
      code: 'OUTBOX15',
      discountType: 'FIXED_AMOUNT',
      discountValue: 1500,
      startsAt: new Date(Date.now() - 3600000),
    });

    const s1 = await setupCheckoutSession(customer1Token, [{ listingId: listing1Id, quantity: 1 }]);
    await promoServiceWithOutbox.applyCouponToCheckout(customer1Actor, s1, 'OUTBOX15');

    let outboxFired = false;
    eventTransport.subscribe(EventTypes.COUPON_REDEEMED, async () => {
      outboxFired = true;
    });

    await db.withTransaction(async (tx) => {
      await promoServiceWithOutbox.finalizeRedemption(tx, {
        checkoutSessionId: s1,
        customerOrderId: 'order_outbox_1',
        customerTenantId: customer1Actor.tenantId,
        actor: customer1Actor,
      });
    });

    expect(recordedEvent).not.toBeNull();
    expect(recordedEvent.eventType).toBe(EventTypes.COUPON_REDEEMED);
    expect(recordedEvent.payload.discountAmount).toBe(1500);

    // Durable outbox relay dispatches after commit
    await eventTransport.publish(recordedEvent);
    expect(outboxFired).toBe(true);
  });

  // --- 28. Restart / Retry Recovery ---
  it('28. restart / retry recovery preserves state and permits clean retry after API cold start', async () => {
    // 1. Create promotion and apply coupon
    await promotionService.createPromotion(adminActor, {
      name: 'Restart Recovery Promo',
      code: 'RESTART20',
      discountType: 'PERCENTAGE',
      discountValue: 20,
      startsAt: new Date(Date.now() - 3600000),
    });

    const s1 = await setupCheckoutSession(customer1Token, [{ listingId: listing1Id, quantity: 1 }]);
    const applyRes = await app.inject({
      method: 'POST',
      url: `/checkout/sessions/${s1}/coupon`,
      headers: { authorization: `Bearer ${customer1Token}` },
      payload: { couponCode: 'RESTART20' },
    });
    expect(applyRes.statusCode).toBe(200);

    // 2. Cold restart: build a fresh Fastify instance with a new PromotionService instance sharing the same DB
    const freshApp = await buildApp({
      config: testConfig,
      logger,
      dbConnection: db,
      eventTransport: new InMemoryEventTransport(),
      searchStore: new InMemorySearchStore(),
      skipMigrations: true,
    });

    // 3. Verify checkout session has persisted coupon snapshot
    const sessionCheck = await freshApp.inject({
      method: 'GET',
      url: `/checkout/sessions/${s1}`,
      headers: { authorization: `Bearer ${customer1Token}` },
    });
    expect(sessionCheck.statusCode).toBe(200);
    const sessionData = sessionCheck.json();
    expect(sessionData.couponCode).toBe('RESTART20');
    expect(sessionData.discountAmount).toBe(2000);
    expect(sessionData.totalAmount).toBe(8000);

    // 4. Reserve and place order on fresh instance
    await freshApp.inject({
      method: 'POST',
      url: `/checkout/sessions/${s1}/reserve`,
      headers: { authorization: `Bearer ${customer1Token}` },
    });

    const piRes = await freshApp.inject({
      method: 'POST',
      url: '/payments/intents',
      headers: { authorization: `Bearer ${customer1Token}` },
      payload: { checkoutSessionId: s1 },
    });
    const paymentIntentId = piRes.json().id;

    await freshApp.inject({
      method: 'POST',
      url: `/payments/intents/${paymentIntentId}/attempts`,
      headers: { authorization: `Bearer ${customer1Token}` },
      payload: { paymentMethod: 'pm_card_visa' },
    });

    const orderRes = await freshApp.inject({
      method: 'POST',
      url: '/orders',
      headers: { authorization: `Bearer ${customer1Token}` },
      payload: { checkoutSessionId: s1, paymentIntentId },
    });
    expect(orderRes.statusCode).toBe(201);
    expect(orderRes.json().couponCode).toBe('RESTART20');
    expect(orderRes.json().discountAmount).toBe(2000);
    expect(orderRes.json().totalAmount).toBe(8000);
  });
});
