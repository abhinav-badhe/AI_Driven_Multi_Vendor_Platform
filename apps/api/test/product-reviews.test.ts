import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../src/app.js';
import { parseConfig } from '../src/config/index.js';
import { createMigratedTestDatabase, markAllUsersVerified, registerVerifiedUser } from './helpers/test-db.js';
import type { DatabaseConnection } from '../src/infra/database/connection.js';

const TOKEN_SECRET = 'super-secret-key-at-least-16-chars';

describe('Product Reviews & Moderation', () => {
  let app: FastifyInstance;
  let db: DatabaseConnection;

  beforeEach(async () => {
    db = await createMigratedTestDatabase();
    const config = parseConfig({
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
      ACCESS_TOKEN_SECRET: TOKEN_SECRET,
      SERVICE_NAME: 'test-api',
      LOG_PRETTY: 'false',
      REDACT_KEYS: 'password,token',
    });
    app = await buildApp({
      config,
      dbConnection: db,
      skipMigrations: true,
    });
    await app.ready();
  });

  afterEach(async () => {
    if (app) await app.close();
    if (db) await db.close();
  });

  async function registerCustomer(email: string) {
    const token = await registerVerifiedUser(app, db, {
      email,
      password: 'Password123!',
      tenantName: `Customer ${email}`,
      role: 'CUSTOMER',
    });
    const userRes = await db.query<{ id: string }>(
      `SELECT id FROM users WHERE email = $1`,
      [email],
    );
    const membershipRes = await db.query<{ tenant_id: string }>(
      `SELECT tenant_id FROM tenant_memberships WHERE user_id = $1`,
      [userRes.rows[0]!.id],
    );
    return {
      token,
      userId: userRes.rows[0]!.id,
      tenantId: membershipRes.rows[0]!.tenant_id,
    };
  }

  async function setupCatalogAndSellers() {
    // 1. Admin
    await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: {
        email: 'admin@platform.com',
        password: 'Password123!',
        tenantName: 'Admin Ops',
        role: 'MERCHANT',
      },
    });
    const adminUserRes = await db.query<{ id: string }>(
      `SELECT id FROM users WHERE email = 'admin@platform.com'`,
    );
    await db.query(`UPDATE tenant_memberships SET role = 'ADMINISTRATOR' WHERE user_id = $1`, [
      adminUserRes.rows[0]!.id,
    ]);
    await markAllUsersVerified(db);
    const adminLogin = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'admin@platform.com', password: 'Password123!' },
    });
    const { accessToken: adminToken } = adminLogin.json();

    // 2. Merchant A
    const merchantAToken = await registerVerifiedUser(app, db, {
      email: 'merchant_a@store.com',
      password: 'Password123!',
      tenantName: 'Merchant A Corp',
      role: 'MERCHANT',
    });
    const merchantAUser = await db.query<{ id: string }>(
      `SELECT id FROM users WHERE email = 'merchant_a@store.com'`,
    );
    const merchantATenant = (
      await db.query<{ tenant_id: string }>(
        `SELECT tenant_id FROM tenant_memberships WHERE user_id = $1`,
        [merchantAUser.rows[0]!.id],
      )
    ).rows[0]!.tenant_id;

    // 3. Merchant B
    const merchantBToken = await registerVerifiedUser(app, db, {
      email: 'merchant_b@store.com',
      password: 'Password123!',
      tenantName: 'Merchant B Corp',
      role: 'MERCHANT',
    });
    const merchantBUser = await db.query<{ id: string }>(
      `SELECT id FROM users WHERE email = 'merchant_b@store.com'`,
    );
    const merchantBTenant = (
      await db.query<{ tenant_id: string }>(
        `SELECT tenant_id FROM tenant_memberships WHERE user_id = $1`,
        [merchantBUser.rows[0]!.id],
      )
    ).rows[0]!.tenant_id;

    // Category
    const cat = (
      await app.inject({
        method: 'POST',
        url: '/categories',
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { name: 'Audio', slug: `audio-${Date.now()}` },
      })
    ).json();

    // Product 1 (Sold by Merchant A)
    const prod1 = (
      await app.inject({
        method: 'POST',
        url: '/products',
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { title: 'Noise Cancelling Headphones', slug: `nc-headphones-${Date.now()}`, categoryId: cat.id },
      })
    ).json();
    await app.inject({
      method: 'POST',
      url: `/products/${prod1.id}/status`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { status: 'ACTIVE' },
    });

    const sku1 = (
      await app.inject({
        method: 'POST',
        url: `/products/${prod1.id}/skus`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { skuCode: `SKU-NC-${Date.now()}`, attributes: { color: 'Black' } },
      })
    ).json();
    await app.inject({
      method: 'POST',
      url: `/skus/${sku1.id}/status`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { status: 'ACTIVE' },
    });

    const listing1 = (
      await app.inject({
        method: 'POST',
        url: '/listings',
        headers: { authorization: `Bearer ${merchantAToken}` },
        payload: { skuId: sku1.id, priceAmount: 19900, currency: 'USD' },
      })
    ).json();

    // Product 2 (Sold by Merchant B)
    const prod2 = (
      await app.inject({
        method: 'POST',
        url: '/products',
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { title: 'Bluetooth Speaker', slug: `bt-speaker-${Date.now()}`, categoryId: cat.id },
      })
    ).json();
    await app.inject({
      method: 'POST',
      url: `/products/${prod2.id}/status`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { status: 'ACTIVE' },
    });

    const sku2 = (
      await app.inject({
        method: 'POST',
        url: `/products/${prod2.id}/skus`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { skuCode: `SKU-SPK-${Date.now()}`, attributes: { color: 'Blue' } },
      })
    ).json();
    await app.inject({
      method: 'POST',
      url: `/skus/${sku2.id}/status`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { status: 'ACTIVE' },
    });

    const listing2 = (
      await app.inject({
        method: 'POST',
        url: '/listings',
        headers: { authorization: `Bearer ${merchantBToken}` },
        payload: { skuId: sku2.id, priceAmount: 7900, currency: 'USD' },
      })
    ).json();

    return {
      adminToken,
      merchantA: { token: merchantAToken, tenantId: merchantATenant },
      merchantB: { token: merchantBToken, tenantId: merchantBTenant },
      product1: { id: prod1.id, skuId: sku1.id, listingId: listing1.id },
      product2: { id: prod2.id, skuId: sku2.id, listingId: listing2.id },
    };
  }

  async function createCompletedOrder(
    customerTenantId: string,
    merchantTenantId: string,
    productId: string,
    skuId: string,
    listingId: string,
    status: 'PAID' | 'PROCESSING' | 'COMPLETED' | 'CANCELLED' | 'PENDING_PAYMENT' = 'COMPLETED',
  ) {
    const customerOrderId = randomUUID();
    const sellerOrderId = randomUUID();
    const orderItemId = randomUUID();
    const checkoutSessionId = randomUUID();

    // 1. Insert customer_orders
    await db.query(
      `INSERT INTO customer_orders (
        id, customer_tenant_id, checkout_session_id, status, currency,
        subtotal_amount, total_amount, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, 'USD', 10000, 10000, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [customerOrderId, customerTenantId, checkoutSessionId, status],
    );

    // 2. Insert seller_orders
    await db.query(
      `INSERT INTO seller_orders (
        id, customer_order_id, seller_tenant_id, status, currency,
        subtotal_amount, total_amount, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, 'USD', 10000, 10000, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [sellerOrderId, customerOrderId, merchantTenantId, status],
    );

    // 3. Insert order_items
    await db.query(
      `INSERT INTO order_items (
        id, seller_order_id, customer_order_id, listing_id, sku_id, product_id,
        merchant_tenant_id, product_name, sku_code, quantity, unit_price_amount, line_total_amount, currency
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'Test Product', 'SKU-001', 1, 10000, 10000, 'USD')`,
      [orderItemId, sellerOrderId, customerOrderId, listingId, skuId, productId, merchantTenantId],
    );

    return { customerOrderId, sellerOrderId, orderItemId };
  }

  it('1. Rejects unauthenticated review submission with 401', async () => {
    const setup = await setupCatalogAndSellers();
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/products/${setup.product1.id}/reviews`,
      payload: {
        rating: 5,
        title: 'Great headphones!',
        comment: 'These are amazing, love them.',
      },
    });
    expect(res.statusCode).toBe(401);
  });

  it('2. Verified purchase: rejects customer review if customer never purchased the product (403)', async () => {
    const setup = await setupCatalogAndSellers();
    const customer = await registerCustomer('buyer_unverified@test.com');

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/products/${setup.product1.id}/reviews`,
      headers: { authorization: `Bearer ${customer.token}` },
      payload: {
        rating: 5,
        title: 'Great headphones!',
        comment: 'I really like the look of these!',
      },
    });

    expect(res.statusCode).toBe(403);
    const body = res.json();
    const message = body.message ?? body.error?.message;
    expect(message).toContain('Verified purchase required');
  });

  it('3. Verified purchase: rejects if customer order is only PENDING_PAYMENT or CANCELLED', async () => {
    const setup = await setupCatalogAndSellers();
    const customer = await registerCustomer('buyer_cancelled@test.com');

    // Create cancelled order
    await createCompletedOrder(
      customer.tenantId,
      setup.merchantA.tenantId,
      setup.product1.id,
      setup.product1.skuId,
      setup.product1.listingId,
      'CANCELLED',
    );

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/products/${setup.product1.id}/reviews`,
      headers: { authorization: `Bearer ${customer.token}` },
      payload: {
        rating: 4,
        title: 'Decent',
        comment: 'Cancelled before receiving',
      },
    });

    expect(res.statusCode).toBe(403);
  });

  it('4. Allows review submission for verified purchase; defaults to PENDING status and records outbox event', async () => {
    const setup = await setupCatalogAndSellers();
    const customer = await registerCustomer('buyer_verified@test.com');

    // Create completed order
    const order = await createCompletedOrder(
      customer.tenantId,
      setup.merchantA.tenantId,
      setup.product1.id,
      setup.product1.skuId,
      setup.product1.listingId,
      'COMPLETED',
    );

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/products/${setup.product1.id}/reviews`,
      headers: { authorization: `Bearer ${customer.token}` },
      payload: {
        rating: 5,
        title: 'Outstanding sound quality',
        comment: 'Crystal clear treble and deep bass. Worth every penny!',
      },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.id).toBeDefined();
    expect(body.productId).toBe(setup.product1.id);
    expect(body.customerId).toBe(customer.userId);
    expect(body.orderId).toBe(order.customerOrderId);
    expect(body.rating).toBe(5);
    expect(body.status).toBe('PENDING');
    expect(body.verifiedPurchase).toBe(true);

    // Verify outbox domain event
    const outboxRes = await db.query<{ event_type: string; payload: Record<string, unknown> }>(
      `SELECT event_type, payload FROM outbox_events WHERE aggregate_id = $1`,
      [body.id],
    );
    expect(outboxRes.rows.length).toBe(1);
    expect(outboxRes.rows[0]!.event_type).toBe('review.submitted.v1');
  });

  it('5. Duplicate review prevention: enforces one review per customer per product (409)', async () => {
    const setup = await setupCatalogAndSellers();
    const customer = await registerCustomer('buyer_repeat@test.com');

    await createCompletedOrder(
      customer.tenantId,
      setup.merchantA.tenantId,
      setup.product1.id,
      setup.product1.skuId,
      setup.product1.listingId,
      'COMPLETED',
    );

    // First review
    const firstRes = await app.inject({
      method: 'POST',
      url: `/api/v1/products/${setup.product1.id}/reviews`,
      headers: { authorization: `Bearer ${customer.token}` },
      payload: {
        rating: 4,
        title: 'Very good',
        comment: 'Comfortable to wear all day.',
      },
    });
    expect(firstRes.statusCode).toBe(201);

    // Second review attempt
    const secondRes = await app.inject({
      method: 'POST',
      url: `/api/v1/products/${setup.product1.id}/reviews`,
      headers: { authorization: `Bearer ${customer.token}` },
      payload: {
        rating: 5,
        title: 'Even better',
        comment: 'Writing again to praise it.',
      },
    });
    expect(secondRes.statusCode).toBe(409);
    const body = secondRes.json();
    const message = body.message ?? body.error?.message;
    expect(message).toContain('already reviewed this product');
  });

  it('6. Rating constraints: validates rating is an integer between 1 and 5', async () => {
    const setup = await setupCatalogAndSellers();
    const customer = await registerCustomer('buyer_invalid_rating@test.com');

    await createCompletedOrder(
      customer.tenantId,
      setup.merchantA.tenantId,
      setup.product1.id,
      setup.product1.skuId,
      setup.product1.listingId,
      'COMPLETED',
    );

    const resZero = await app.inject({
      method: 'POST',
      url: `/api/v1/products/${setup.product1.id}/reviews`,
      headers: { authorization: `Bearer ${customer.token}` },
      payload: { rating: 0, comment: 'Too low rating value' },
    });
    expect(resZero.statusCode).toBe(400);

    const resSix = await app.inject({
      method: 'POST',
      url: `/api/v1/products/${setup.product1.id}/reviews`,
      headers: { authorization: `Bearer ${customer.token}` },
      payload: { rating: 6, comment: 'Too high rating value' },
    });
    expect(resSix.statusCode).toBe(400);
  });

  it('7. Customer review editing: customer can edit own review; resets to PENDING', async () => {
    const setup = await setupCatalogAndSellers();
    const customer = await registerCustomer('buyer_edit@test.com');

    await createCompletedOrder(
      customer.tenantId,
      setup.merchantA.tenantId,
      setup.product1.id,
      setup.product1.skuId,
      setup.product1.listingId,
      'COMPLETED',
    );

    const createRes = await app.inject({
      method: 'POST',
      url: `/api/v1/products/${setup.product1.id}/reviews`,
      headers: { authorization: `Bearer ${customer.token}` },
      payload: { rating: 3, comment: 'Initial comment okay' },
    });
    const reviewId = createRes.json().id;

    // Admin approves first
    await app.inject({
      method: 'POST',
      url: `/api/v1/admin/reviews/${reviewId}/approve`,
      headers: { authorization: `Bearer ${setup.adminToken}` },
    });

    // Customer edits review
    const updateRes = await app.inject({
      method: 'PATCH',
      url: `/api/v1/reviews/${reviewId}`,
      headers: { authorization: `Bearer ${customer.token}` },
      payload: {
        rating: 5,
        title: 'Updated: Actually fantastic!',
        comment: 'After breaking them in for a week, they sound incredible.',
      },
    });

    expect(updateRes.statusCode).toBe(200);
    const updated = updateRes.json();
    expect(updated.rating).toBe(5);
    expect(updated.title).toBe('Updated: Actually fantastic!');
    expect(updated.status).toBe('PENDING'); // Customer edit reverts to PENDING for moderation
  });

  it('8. Customer authorization: customer cannot edit or delete another customer review (403)', async () => {
    const setup = await setupCatalogAndSellers();
    const customer1 = await registerCustomer('buyer1@test.com');
    const customer2 = await registerCustomer('buyer2@test.com');

    await createCompletedOrder(
      customer1.tenantId,
      setup.merchantA.tenantId,
      setup.product1.id,
      setup.product1.skuId,
      setup.product1.listingId,
      'COMPLETED',
    );

    const createRes = await app.inject({
      method: 'POST',
      url: `/api/v1/products/${setup.product1.id}/reviews`,
      headers: { authorization: `Bearer ${customer1.token}` },
      payload: { rating: 5, comment: 'Buyer 1 review' },
    });
    const reviewId = createRes.json().id;

    // Customer 2 tries to PATCH customer 1 review
    const patchRes = await app.inject({
      method: 'PATCH',
      url: `/api/v1/reviews/${reviewId}`,
      headers: { authorization: `Bearer ${customer2.token}` },
      payload: { rating: 1, comment: 'Hacked by buyer 2' },
    });
    expect(patchRes.statusCode).toBe(403);

    // Customer 2 tries to DELETE customer 1 review
    const deleteRes = await app.inject({
      method: 'DELETE',
      url: `/api/v1/reviews/${reviewId}`,
      headers: { authorization: `Bearer ${customer2.token}` },
    });
    expect(deleteRes.statusCode).toBe(403);
  });

  it('9. Customer deletion: customer can delete their own review (204)', async () => {
    const setup = await setupCatalogAndSellers();
    const customer = await registerCustomer('buyer_delete@test.com');

    await createCompletedOrder(
      customer.tenantId,
      setup.merchantA.tenantId,
      setup.product1.id,
      setup.product1.skuId,
      setup.product1.listingId,
      'COMPLETED',
    );

    const createRes = await app.inject({
      method: 'POST',
      url: `/api/v1/products/${setup.product1.id}/reviews`,
      headers: { authorization: `Bearer ${customer.token}` },
      payload: { rating: 4, comment: 'About to be deleted' },
    });
    const reviewId = createRes.json().id;

    const delRes = await app.inject({
      method: 'DELETE',
      url: `/api/v1/reviews/${reviewId}`,
      headers: { authorization: `Bearer ${customer.token}` },
    });
    expect(delRes.statusCode).toBe(204);

    // Review no longer exists
    const checkRes = await app.inject({
      method: 'GET',
      url: `/api/v1/reviews/${reviewId}`,
    });
    expect(checkRes.statusCode).toBe(404);
  });

  it('10. Visibility rules: public cannot see PENDING or REJECTED reviews; only APPROVED are visible', async () => {
    const setup = await setupCatalogAndSellers();
    const customer1 = await registerCustomer('vis_cust1@test.com');
    const customer2 = await registerCustomer('vis_cust2@test.com');

    await createCompletedOrder(customer1.tenantId, setup.merchantA.tenantId, setup.product1.id, setup.product1.skuId, setup.product1.listingId, 'COMPLETED');
    await createCompletedOrder(customer2.tenantId, setup.merchantA.tenantId, setup.product1.id, setup.product1.skuId, setup.product1.listingId, 'COMPLETED');

    const rev1 = (
      await app.inject({
        method: 'POST',
        url: `/api/v1/products/${setup.product1.id}/reviews`,
        headers: { authorization: `Bearer ${customer1.token}` },
        payload: { rating: 5, comment: 'Pending review 1' },
      })
    ).json();

    const rev2 = (
      await app.inject({
        method: 'POST',
        url: `/api/v1/products/${setup.product1.id}/reviews`,
        headers: { authorization: `Bearer ${customer2.token}` },
        payload: { rating: 4, comment: 'To be approved review 2' },
      })
    ).json();

    // Public list reviews before approval: returns 0 approved reviews
    const publicBefore = (
      await app.inject({
        method: 'GET',
        url: `/api/v1/products/${setup.product1.id}/reviews`,
      })
    ).json();
    expect(publicBefore.length).toBe(0);

    // Admin approves rev2
    await app.inject({
      method: 'POST',
      url: `/api/v1/admin/reviews/${rev2.id}/approve`,
      headers: { authorization: `Bearer ${setup.adminToken}` },
    });

    // Public list reviews now: contains only rev2
    const publicAfter = (
      await app.inject({
        method: 'GET',
        url: `/api/v1/products/${setup.product1.id}/reviews`,
      })
    ).json();
    expect(publicAfter.length).toBe(1);
    expect(publicAfter[0].id).toBe(rev2.id);

    // Admin rejects rev1
    await app.inject({
      method: 'POST',
      url: `/api/v1/admin/reviews/${rev1.id}/reject`,
      headers: { authorization: `Bearer ${setup.adminToken}` },
      payload: { reason: 'Inappropriate content' },
    });

    // Anonymous GET /reviews/:id on rejected review: 404
    const getAnonRejected = await app.inject({
      method: 'GET',
      url: `/api/v1/reviews/${rev1.id}`,
    });
    expect(getAnonRejected.statusCode).toBe(404);

    // Author GET /reviews/:id on rejected review: can see own
    const getAuthorRejected = await app.inject({
      method: 'GET',
      url: `/api/v1/reviews/${rev1.id}`,
      headers: { authorization: `Bearer ${customer1.token}` },
    });
    expect(getAuthorRejected.statusCode).toBe(200);
    expect(getAuthorRejected.json().status).toBe('REJECTED');
  });

  it('11. Moderation authorization: Merchant A can moderate reviews for Product 1, but NOT Product 2 (403)', async () => {
    const setup = await setupCatalogAndSellers();
    const customer = await registerCustomer('merchant_auth_test@test.com');

    // Customer orders Product 2 (sold by Merchant B)
    await createCompletedOrder(customer.tenantId, setup.merchantB.tenantId, setup.product2.id, setup.product2.skuId, setup.product2.listingId, 'COMPLETED');

    const revRes = await app.inject({
      method: 'POST',
      url: `/api/v1/products/${setup.product2.id}/reviews`,
      headers: { authorization: `Bearer ${customer.token}` },
      payload: { rating: 5, comment: 'Product 2 speaker review' },
    });
    const reviewId = revRes.json().id;

    // Merchant A attempts to approve Product 2 review -> 403 Forbidden
    const merchantAFail = await app.inject({
      method: 'POST',
      url: `/api/v1/merchant/reviews/${reviewId}/approve`,
      headers: { authorization: `Bearer ${setup.merchantA.token}` },
    });
    expect(merchantAFail.statusCode).toBe(403);
    const failBody = merchantAFail.json();
    const message = failBody.message ?? failBody.error?.message;
    expect(message).toContain('Merchants may only moderate reviews for products they list');

    // Merchant B approves Product 2 review -> 200 OK
    const merchantBSuccess = await app.inject({
      method: 'POST',
      url: `/api/v1/merchant/reviews/${reviewId}/approve`,
      headers: { authorization: `Bearer ${setup.merchantB.token}` },
      payload: { note: 'Verified by Merchant B' },
    });
    expect(merchantBSuccess.statusCode).toBe(200);
    expect(merchantBSuccess.json().status).toBe('APPROVED');
  });

  it('12. Rating calculation & distribution: accurately computes average and star breakdown using only APPROVED reviews', async () => {
    const setup = await setupCatalogAndSellers();
    const cust1 = await registerCustomer('rate1@test.com');
    const cust2 = await registerCustomer('rate2@test.com');
    const cust3 = await registerCustomer('rate3@test.com');
    const cust4 = await registerCustomer('rate4@test.com');

    await createCompletedOrder(cust1.tenantId, setup.merchantA.tenantId, setup.product1.id, setup.product1.skuId, setup.product1.listingId, 'COMPLETED');
    await createCompletedOrder(cust2.tenantId, setup.merchantA.tenantId, setup.product1.id, setup.product1.skuId, setup.product1.listingId, 'COMPLETED');
    await createCompletedOrder(cust3.tenantId, setup.merchantA.tenantId, setup.product1.id, setup.product1.skuId, setup.product1.listingId, 'COMPLETED');
    await createCompletedOrder(cust4.tenantId, setup.merchantA.tenantId, setup.product1.id, setup.product1.skuId, setup.product1.listingId, 'COMPLETED');

    // Cust 1: 5 stars (approved)
    const r1 = (await app.inject({
      method: 'POST',
      url: `/api/v1/products/${setup.product1.id}/reviews`,
      headers: { authorization: `Bearer ${cust1.token}` },
      payload: { rating: 5, comment: '5 stars review' },
    })).json();
    await app.inject({
      method: 'POST',
      url: `/api/v1/admin/reviews/${r1.id}/approve`,
      headers: { authorization: `Bearer ${setup.adminToken}` },
    });

    // Cust 2: 4 stars (approved)
    const r2 = (await app.inject({
      method: 'POST',
      url: `/api/v1/products/${setup.product1.id}/reviews`,
      headers: { authorization: `Bearer ${cust2.token}` },
      payload: { rating: 4, comment: '4 stars review' },
    })).json();
    await app.inject({
      method: 'POST',
      url: `/api/v1/admin/reviews/${r2.id}/approve`,
      headers: { authorization: `Bearer ${setup.adminToken}` },
    });

    // Cust 3: 1 star (rejected - must not affect rating)
    const r3 = (await app.inject({
      method: 'POST',
      url: `/api/v1/products/${setup.product1.id}/reviews`,
      headers: { authorization: `Bearer ${cust3.token}` },
      payload: { rating: 1, comment: 'Spam review' },
    })).json();
    await app.inject({
      method: 'POST',
      url: `/api/v1/admin/reviews/${r3.id}/reject`,
      headers: { authorization: `Bearer ${setup.adminToken}` },
    });

    // Cust 4: 5 stars (remains pending - must not affect rating)
    await app.inject({
      method: 'POST',
      url: `/api/v1/products/${setup.product1.id}/reviews`,
      headers: { authorization: `Bearer ${cust4.token}` },
      payload: { rating: 5, comment: 'Still pending review' },
    });

    // Fetch rating summary
    const summaryRes = await app.inject({
      method: 'GET',
      url: `/api/v1/products/${setup.product1.id}/rating-summary`,
    });
    expect(summaryRes.statusCode).toBe(200);
    const summary = summaryRes.json();

    // 2 approved reviews: 5 and 4. Average = 4.5.
    expect(summary.totalReviews).toBe(2);
    expect(summary.averageRating).toBe(4.5);
    expect(summary.distribution['5']).toBe(1);
    expect(summary.distribution['4']).toBe(1);
    expect(summary.distribution['3']).toBe(0);
    expect(summary.distribution['2']).toBe(0);
    expect(summary.distribution['1']).toBe(0); // 1-star rejected is not counted
  });

  it('13. Review eligibility check: returns hasPurchased, alreadyReviewed, isEligible', async () => {
    const setup = await setupCatalogAndSellers();
    const customer = await registerCustomer('eligibility_test@test.com');

    // Before purchase: hasPurchased = false, isEligible = false
    const checkBefore = await app.inject({
      method: 'GET',
      url: `/api/v1/products/${setup.product1.id}/review-eligibility`,
      headers: { authorization: `Bearer ${customer.token}` },
    });
    expect(checkBefore.statusCode).toBe(200);
    expect(checkBefore.json()).toEqual({
      hasPurchased: false,
      alreadyReviewed: false,
      isEligible: false,
      existingReviewId: undefined,
    });

    // After purchase: hasPurchased = true, isEligible = true
    await createCompletedOrder(customer.tenantId, setup.merchantA.tenantId, setup.product1.id, setup.product1.skuId, setup.product1.listingId, 'COMPLETED');
    const checkAfterPurchase = (
      await app.inject({
        method: 'GET',
        url: `/api/v1/products/${setup.product1.id}/review-eligibility`,
        headers: { authorization: `Bearer ${customer.token}` },
      })
    ).json();
    expect(checkAfterPurchase.hasPurchased).toBe(true);
    expect(checkAfterPurchase.isEligible).toBe(true);
    expect(checkAfterPurchase.alreadyReviewed).toBe(false);

    // After review submission: alreadyReviewed = true, isEligible = false
    const rev = (
      await app.inject({
        method: 'POST',
        url: `/api/v1/products/${setup.product1.id}/reviews`,
        headers: { authorization: `Bearer ${customer.token}` },
        payload: { rating: 5, comment: 'Eligibility tested' },
      })
    ).json();

    const checkAfterReview = (
      await app.inject({
        method: 'GET',
        url: `/api/v1/products/${setup.product1.id}/review-eligibility`,
        headers: { authorization: `Bearer ${customer.token}` },
      })
    ).json();
    expect(checkAfterReview.hasPurchased).toBe(true);
    expect(checkAfterReview.alreadyReviewed).toBe(true);
    expect(checkAfterReview.isEligible).toBe(false);
    expect(checkAfterReview.existingReviewId).toBe(rev.id);
  });

  it('14. Customer review management: GET /api/v1/customer/reviews returns all reviews by customer', async () => {
    const setup = await setupCatalogAndSellers();
    const customer = await registerCustomer('my_reviews@test.com');

    await createCompletedOrder(customer.tenantId, setup.merchantA.tenantId, setup.product1.id, setup.product1.skuId, setup.product1.listingId, 'COMPLETED');

    await app.inject({
      method: 'POST',
      url: `/api/v1/products/${setup.product1.id}/reviews`,
      headers: { authorization: `Bearer ${customer.token}` },
      payload: { rating: 4, comment: 'My review text' },
    });

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/customer/reviews`,
      headers: { authorization: `Bearer ${customer.token}` },
    });

    expect(res.statusCode).toBe(200);
    const reviews = res.json();
    expect(reviews.length).toBe(1);
    expect(reviews[0].productId).toBe(setup.product1.id);
    expect(reviews[0].comment).toBe('My review text');
  });

  it('15. Regression: REJECTED and PENDING reviews with customer_id IS NULL never affect rating calculation or public visibility', async () => {
    const setup = await setupCatalogAndSellers();

    // 1. Insert an APPROVED legacy/seeded review (rating 5)
    await db.query(
      `INSERT INTO product_reviews (id, product_id, customer_id, rating, comment, reviewer_name, status)
       VALUES ('seed-approved-1', $1, NULL, 5, 'Great legacy item', 'Legacy Seeder', 'APPROVED')`,
      [setup.product1.id],
    );

    // 2. Insert a REJECTED review with customer_id IS NULL (rating 1)
    await db.query(
      `INSERT INTO product_reviews (id, product_id, customer_id, rating, comment, reviewer_name, status)
       VALUES ('seed-rejected-1', $1, NULL, 1, 'Inappropriate review', 'Legacy Seeder', 'REJECTED')`,
      [setup.product1.id],
    );

    // 3. Insert a PENDING review with customer_id IS NULL (rating 2)
    await db.query(
      `INSERT INTO product_reviews (id, product_id, customer_id, rating, comment, reviewer_name, status)
       VALUES ('seed-pending-1', $1, NULL, 2, 'Pending check', 'Legacy Seeder', 'PENDING')`,
      [setup.product1.id],
    );

    // Verify rating summary strictly uses status = 'APPROVED'
    const summaryRes = await app.inject({
      method: 'GET',
      url: `/api/v1/products/${setup.product1.id}/rating-summary`,
    });
    expect(summaryRes.statusCode).toBe(200);
    const summary = summaryRes.json();

    // Exactly 1 review is counted: the 5-star approved review
    expect(summary.totalReviews).toBe(1);
    expect(summary.averageRating).toBe(5);
    expect(summary.distribution['5']).toBe(1);
    expect(summary.distribution['4']).toBe(0);
    expect(summary.distribution['3']).toBe(0);
    expect(summary.distribution['2']).toBe(0);
    expect(summary.distribution['1']).toBe(0);

    // Public list reviews must only return the APPROVED review
    const listRes = await app.inject({
      method: 'GET',
      url: `/api/v1/products/${setup.product1.id}/reviews`,
    });
    expect(listRes.statusCode).toBe(200);
    const list = listRes.json();
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe('seed-approved-1');
  });

  it('16. Merchant moderation audit: seller cannot mutate review text/rating and cannot moderate other merchant product', async () => {
    const setup = await setupCatalogAndSellers();
    const customer = await registerCustomer('buyer_audit@test.com');

    // Customer purchases Product 1 (Merchant A)
    await createCompletedOrder(customer.tenantId, setup.merchantA.tenantId, setup.product1.id, setup.product1.skuId, setup.product1.listingId, 'COMPLETED');

    const revRes = await app.inject({
      method: 'POST',
      url: `/api/v1/products/${setup.product1.id}/reviews`,
      headers: { authorization: `Bearer ${customer.token}` },
      payload: {
        rating: 4,
        title: 'Original Title',
        comment: 'Original comment text from buyer.',
      },
    });
    const reviewId = revRes.json().id;

    // Merchant B tries to approve Merchant A's review -> 403 Forbidden
    const merchantBFail = await app.inject({
      method: 'POST',
      url: `/api/v1/merchant/reviews/${reviewId}/approve`,
      headers: { authorization: `Bearer ${setup.merchantB.token}` },
    });
    expect(merchantBFail.statusCode).toBe(403);

    // Merchant A approves review with a note
    const merchantASuccess = await app.inject({
      method: 'POST',
      url: `/api/v1/merchant/reviews/${reviewId}/approve`,
      headers: { authorization: `Bearer ${setup.merchantA.token}` },
      payload: { note: 'Verified by Merchant A Seller' },
    });
    expect(merchantASuccess.statusCode).toBe(200);
    const approved = merchantASuccess.json();

    // Verify rating, title, comment, customerId, productId, and orderId were NOT altered by merchant
    expect(approved.rating).toBe(4);
    expect(approved.title).toBe('Original Title');
    expect(approved.comment).toBe('Original comment text from buyer.');
    expect(approved.customerId).toBe(customer.userId);
    expect(approved.productId).toBe(setup.product1.id);
    expect(approved.status).toBe('APPROVED');
    expect(approved.moderationNote).toBe('Verified by Merchant A Seller');
  });
});
