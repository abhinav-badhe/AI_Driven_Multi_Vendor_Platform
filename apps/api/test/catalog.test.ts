import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { parseConfig } from '../src/config/index.js';
import { createMigratedTestDatabase, markAllUsersVerified } from './helpers/test-db.js';
import type { DatabaseConnection } from '../src/infra/database/connection.js';

const TOKEN_SECRET = 'super-secret-key-at-least-16-chars';

describe('Phase 3: Catalog Domain (Category, Product, SKU)', () => {
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

  async function getTokens() {
    // 1. Register admin as MERCHANT then elevate in database to ADMINISTRATOR
    const adminReg = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: {
        email: 'realadmin@platform.com',
        password: 'Password123!',
        tenantName: 'Platform Ops',
        role: 'MERCHANT',
      },
    });
    expect(adminReg.statusCode).toBe(201);

    const userRes = await db.query<{ id: string }>(
      `SELECT id FROM users WHERE email = 'realadmin@platform.com'`,
    );
    const adminUserId = userRes.rows[0]!.id;
    await db.query(`UPDATE tenant_memberships SET role = 'ADMINISTRATOR' WHERE user_id = $1`, [
      adminUserId,
    ]);
    await markAllUsersVerified(db);

    const adminLogin = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'realadmin@platform.com', password: 'Password123!' },
    });
    expect(adminLogin.statusCode).toBe(200);
    const { accessToken: adminToken } = adminLogin.json();

    // 2. Register merchant (verified before any sign-in)
    const merchantReg = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: {
        email: 'merchant@store.com',
        password: 'Password123!',
        tenantName: 'Apex Sports',
        role: 'MERCHANT',
      },
    });
    expect(merchantReg.statusCode).toBe(201);
    await markAllUsersVerified(db);
    const merchantLogin = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'merchant@store.com', password: 'Password123!' },
    });
    const { accessToken: merchantToken } = merchantLogin.json();

    // 3. Register customer (verified before any sign-in)
    const customerReg = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: {
        email: 'customer@buyer.com',
        password: 'Password123!',
        tenantName: 'Customer Tenant',
        role: 'CUSTOMER',
      },
    });
    expect(customerReg.statusCode).toBe(201);
    await markAllUsersVerified(db);
    const customerLogin = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'customer@buyer.com', password: 'Password123!' },
    });
    const { accessToken: customerToken } = customerLogin.json();

    return {
      adminToken,
      merchantToken,
      customerToken,
    };
  }

  describe('Category Management', () => {
    it('allows administrator to create categories and subcategories', async () => {
      const tokens = await getTokens();

      // Create parent category
      const res1 = await app.inject({
        method: 'POST',
        url: '/categories',
        headers: { authorization: `Bearer ${tokens.adminToken}` },
        payload: { name: 'Footwear', slug: 'footwear' },
      });
      expect(res1.statusCode).toBe(201);
      const cat1 = JSON.parse(res1.body);
      expect(cat1.name).toBe('Footwear');
      expect(cat1.slug).toBe('footwear');
      expect(cat1.parentId).toBeNull();

      // Create child category
      const res2 = await app.inject({
        method: 'POST',
        url: '/categories',
        headers: { authorization: `Bearer ${tokens.adminToken}` },
        payload: { name: 'Running Shoes', slug: 'running-shoes', parentId: cat1.id },
      });
      expect(res2.statusCode).toBe(201);
      const cat2 = JSON.parse(res2.body);
      expect(cat2.parentId).toBe(cat1.id);

      // List categories
      const listRes = await app.inject({
        method: 'GET',
        url: '/categories',
      });
      expect(listRes.statusCode).toBe(200);
      const list = JSON.parse(listRes.body);
      expect(list.length).toBe(2);
    });

    it('rejects duplicate category slugs', async () => {
      const tokens = await getTokens();
      await app.inject({
        method: 'POST',
        url: '/categories',
        headers: { authorization: `Bearer ${tokens.adminToken}` },
        payload: { name: 'Electronics', slug: 'electronics' },
      });

      const res = await app.inject({
        method: 'POST',
        url: '/categories',
        headers: { authorization: `Bearer ${tokens.adminToken}` },
        payload: { name: 'Electronics duplicate', slug: 'electronics' },
      });
      expect(res.statusCode).toBe(409);
    });

    it('rejects non-admin from creating categories', async () => {
      const tokens = await getTokens();
      const res = await app.inject({
        method: 'POST',
        url: '/categories',
        headers: { authorization: `Bearer ${tokens.merchantToken}` },
        payload: { name: 'Apparel', slug: 'apparel' },
      });
      expect(res.statusCode).toBe(403);
    });
  });

  describe('Product Management & Lifecycle', () => {
    it('creates canonical product in DRAFT state and enforces validation', async () => {
      const tokens = await getTokens();

      // Missing title validation
      const invalidRes = await app.inject({
        method: 'POST',
        url: '/products',
        headers: { authorization: `Bearer ${tokens.adminToken}` },
        payload: { title: '', slug: 'bad-product' },
      });
      expect(invalidRes.statusCode).toBe(400);

      // Create product
      const res = await app.inject({
        method: 'POST',
        url: '/products',
        headers: { authorization: `Bearer ${tokens.adminToken}` },
        payload: {
          title: 'Air Runner 2000',
          slug: 'air-runner-2000',
          brand: 'Nike',
          description: 'High performance running shoes',
        },
      });
      expect(res.statusCode).toBe(201);
      const prod = JSON.parse(res.body);
      expect(prod.id).toBeDefined();
      expect(prod.title).toBe('Air Runner 2000');
      expect(prod.status).toBe('DRAFT');
    });

    it('executes valid product lifecycle transitions and rejects invalid ones', async () => {
      const tokens = await getTokens();

      const createRes = await app.inject({
        method: 'POST',
        url: '/products',
        headers: { authorization: `Bearer ${tokens.adminToken}` },
        payload: { title: 'Test Shoe', slug: 'test-shoe' },
      });
      const prod = JSON.parse(createRes.body);

      // Invalid: DRAFT -> INACTIVE (must go through ACTIVE or ARCHIVED)
      const invalidTransition = await app.inject({
        method: 'POST',
        url: `/products/${prod.id}/status`,
        headers: { authorization: `Bearer ${tokens.adminToken}` },
        payload: { status: 'INACTIVE' },
      });
      expect(invalidTransition.statusCode).toBe(409);

      // Valid: DRAFT -> ACTIVE
      const activeRes = await app.inject({
        method: 'POST',
        url: `/products/${prod.id}/status`,
        headers: { authorization: `Bearer ${tokens.adminToken}` },
        payload: { status: 'ACTIVE' },
      });
      expect(activeRes.statusCode).toBe(200);
      expect(JSON.parse(activeRes.body).status).toBe('ACTIVE');

      // Valid: ACTIVE -> INACTIVE
      const inactiveRes = await app.inject({
        method: 'POST',
        url: `/products/${prod.id}/status`,
        headers: { authorization: `Bearer ${tokens.adminToken}` },
        payload: { status: 'INACTIVE' },
      });
      expect(inactiveRes.statusCode).toBe(200);
      expect(JSON.parse(inactiveRes.body).status).toBe('INACTIVE');

      // Valid: INACTIVE -> ARCHIVED (terminal)
      const archivedRes = await app.inject({
        method: 'POST',
        url: `/products/${prod.id}/status`,
        headers: { authorization: `Bearer ${tokens.adminToken}` },
        payload: { status: 'ARCHIVED' },
      });
      expect(archivedRes.statusCode).toBe(200);
      expect(JSON.parse(archivedRes.body).status).toBe('ARCHIVED');

      // Terminal: cannot transition from ARCHIVED
      const fromArchived = await app.inject({
        method: 'POST',
        url: `/products/${prod.id}/status`,
        headers: { authorization: `Bearer ${tokens.adminToken}` },
        payload: { status: 'ACTIVE' },
      });
      expect(fromArchived.statusCode).toBe(409);

      // Cannot update archived product
      const updateArchived = await app.inject({
        method: 'PATCH',
        url: `/products/${prod.id}`,
        headers: { authorization: `Bearer ${tokens.adminToken}` },
        payload: { title: 'Updated Title' },
      });
      expect(updateArchived.statusCode).toBe(409);
    });

    it('rejects duplicate product slugs', async () => {
      const tokens = await getTokens();

      await app.inject({
        method: 'POST',
        url: '/products',
        headers: { authorization: `Bearer ${tokens.adminToken}` },
        payload: { title: 'Product 1', slug: 'unique-slug' },
      });

      const res = await app.inject({
        method: 'POST',
        url: '/products',
        headers: { authorization: `Bearer ${tokens.adminToken}` },
        payload: { title: 'Product 2', slug: 'unique-slug' },
      });
      expect(res.statusCode).toBe(409);
    });
  });

  describe('Product Content & Reviews', () => {
    it('exposes enriched display fields with safe defaults on products', async () => {
      const tokens = await getTokens();

      const createRes = await app.inject({
        method: 'POST',
        url: '/products',
        headers: { authorization: `Bearer ${tokens.adminToken}` },
        payload: { title: 'Plain Mug', slug: 'plain-mug' },
      });
      expect(createRes.statusCode).toBe(201);
      const prod = JSON.parse(createRes.body);

      const getRes = await app.inject({ method: 'GET', url: `/products/${prod.id}` });
      expect(getRes.statusCode).toBe(200);
      const fetched = JSON.parse(getRes.body);
      expect(fetched.thumbnailUrl).toBeNull();
      expect(fetched.images).toEqual([]);
      expect(fetched.rating).toBeNull();
      expect(fetched.reviewCount).toBe(0);
      expect(fetched.attributes).toEqual({});
    });

    it('lists customer reviews for a product and 404s for unknown products', async () => {
      const tokens = await getTokens();

      const createRes = await app.inject({
        method: 'POST',
        url: '/products',
        headers: { authorization: `Bearer ${tokens.adminToken}` },
        payload: { title: 'Reviewable Lamp', slug: 'reviewable-lamp' },
      });
      const prod = JSON.parse(createRes.body);

      await db.query(
        `INSERT INTO product_reviews (id, product_id, rating, comment, reviewer_name, reviewer_email, reviewed_at)
         VALUES ('rev-1', $1, 5, 'Bright and sturdy', 'Asha Rao', 'asha@example.com', '2025-01-02T10:00:00.000Z')`,
        [prod.id],
      );

      const listRes = await app.inject({ method: 'GET', url: `/products/${prod.id}/reviews` });
      expect(listRes.statusCode).toBe(200);
      const reviews = JSON.parse(listRes.body);
      expect(reviews).toHaveLength(1);
      expect(reviews[0]).toMatchObject({
        productId: prod.id,
        rating: 5,
        comment: 'Bright and sturdy',
        reviewerName: 'Asha Rao',
      });

      const missingRes = await app.inject({
        method: 'GET',
        url: '/products/no-such-product/reviews',
      });
      expect(missingRes.statusCode).toBe(404);
    });
  });

  describe('Product SKU Management & Relationships', () => {
    it('creates SKUs under canonical product and enforces uniqueness', async () => {
      const tokens = await getTokens();

      const prodRes = await app.inject({
        method: 'POST',
        url: '/products',
        headers: { authorization: `Bearer ${tokens.adminToken}` },
        payload: { title: 'Running Shirt', slug: 'running-shirt' },
      });
      const prod = JSON.parse(prodRes.body);

      // Create SKU 1
      const sku1Res = await app.inject({
        method: 'POST',
        url: `/products/${prod.id}/skus`,
        headers: { authorization: `Bearer ${tokens.adminToken}` },
        payload: {
          skuCode: 'RSHIRT-BLK-M',
          barcode: '1122334455',
          attributes: { color: 'Black', size: 'M' },
        },
      });
      expect(sku1Res.statusCode).toBe(201);
      const sku1 = JSON.parse(sku1Res.body);
      expect(sku1.productId).toBe(prod.id);
      expect(sku1.skuCode).toBe('RSHIRT-BLK-M');
      expect(sku1.status).toBe('DRAFT');
      expect(sku1.attributes).toEqual({ color: 'Black', size: 'M' });

      // Duplicate SKU code should be rejected
      const dupSkuRes = await app.inject({
        method: 'POST',
        url: `/products/${prod.id}/skus`,
        headers: { authorization: `Bearer ${tokens.adminToken}` },
        payload: {
          skuCode: 'RSHIRT-BLK-M',
        },
      });
      expect(dupSkuRes.statusCode).toBe(409);

      // List SKUs for product (use admin token to see DRAFT SKUs)
      const listSkusRes = await app.inject({
        method: 'GET',
        url: `/products/${prod.id}/skus`,
        headers: { authorization: `Bearer ${tokens.adminToken}` },
      });
      expect(listSkusRes.statusCode).toBe(200);
      const skus = JSON.parse(listSkusRes.body);
      expect(skus.length).toBe(1);
    });

    it('enforces SKU lifecycle transitions and dependencies', async () => {
      const tokens = await getTokens();

      const prodRes = await app.inject({
        method: 'POST',
        url: '/products',
        headers: { authorization: `Bearer ${tokens.adminToken}` },
        payload: { title: 'Tennis Shoe', slug: 'tennis-shoe' },
      });
      const prod = JSON.parse(prodRes.body);

      const skuRes = await app.inject({
        method: 'POST',
        url: `/products/${prod.id}/skus`,
        headers: { authorization: `Bearer ${tokens.adminToken}` },
        payload: { skuCode: 'TSHOE-WHT-9' },
      });
      const sku = JSON.parse(skuRes.body);

      // DRAFT -> ACTIVE
      const activeRes = await app.inject({
        method: 'POST',
        url: `/skus/${sku.id}/status`,
        headers: { authorization: `Bearer ${tokens.adminToken}` },
        payload: { status: 'ACTIVE' },
      });
      expect(activeRes.statusCode).toBe(200);
      expect(JSON.parse(activeRes.body).status).toBe('ACTIVE');

      // ACTIVE -> INACTIVE
      const inactiveRes = await app.inject({
        method: 'POST',
        url: `/skus/${sku.id}/status`,
        headers: { authorization: `Bearer ${tokens.adminToken}` },
        payload: { status: 'INACTIVE' },
      });
      expect(inactiveRes.statusCode).toBe(200);
      expect(JSON.parse(inactiveRes.body).status).toBe('INACTIVE');
    });

    it('prevents creating SKUs on non-existent product', async () => {
      const tokens = await getTokens();
      const res = await app.inject({
        method: 'POST',
        url: '/products/non-existent-product-id/skus',
        headers: { authorization: `Bearer ${tokens.adminToken}` },
        payload: { skuCode: 'SOME-SKU' },
      });
      expect(res.statusCode).toBe(404);
    });

    it('only returns ACTIVE SKUs for public and customer requests, but returns all for administrators', async () => {
      const tokens = await getTokens();

      const prodRes = await app.inject({
        method: 'POST',
        url: '/products',
        headers: { authorization: `Bearer ${tokens.adminToken}` },
        payload: { title: 'Visibility Shoe', slug: 'visibility-shoe' },
      });
      const prod = JSON.parse(prodRes.body);

      // Create SKU A (ACTIVE)
      const skuARes = await app.inject({
        method: 'POST',
        url: `/products/${prod.id}/skus`,
        headers: { authorization: `Bearer ${tokens.adminToken}` },
        payload: { skuCode: 'VIS-A' },
      });
      const skuA = JSON.parse(skuARes.body);
      await app.inject({
        method: 'POST',
        url: `/skus/${skuA.id}/status`,
        headers: { authorization: `Bearer ${tokens.adminToken}` },
        payload: { status: 'ACTIVE' },
      });

      // Create SKU B (DRAFT)
      await app.inject({
        method: 'POST',
        url: `/products/${prod.id}/skus`,
        headers: { authorization: `Bearer ${tokens.adminToken}` },
        payload: { skuCode: 'VIS-B' },
      });

      // 1. Admin GET: expects both
      const adminRes = await app.inject({
        method: 'GET',
        url: `/products/${prod.id}/skus`,
        headers: { authorization: `Bearer ${tokens.adminToken}` },
      });
      expect(JSON.parse(adminRes.body).length).toBe(2);

      // 2. Customer GET: expects only ACTIVE (1)
      const customerRes = await app.inject({
        method: 'GET',
        url: `/products/${prod.id}/skus`,
        headers: { authorization: `Bearer ${tokens.customerToken}` },
      });
      const customerSkus = JSON.parse(customerRes.body);
      expect(customerSkus.length).toBe(1);
      expect(customerSkus[0].skuCode).toBe('VIS-A');

      // 3. Public GET: expects only ACTIVE (1)
      const publicRes = await app.inject({
        method: 'GET',
        url: `/products/${prod.id}/skus`,
      });
      const publicSkus = JSON.parse(publicRes.body);
      expect(publicSkus.length).toBe(1);
      expect(publicSkus[0].skuCode).toBe('VIS-A');

      // 4. Test all INACTIVE/DRAFT SKUs -> empty result for public
      await app.inject({
        method: 'POST',
        url: `/skus/${skuA.id}/status`,
        headers: { authorization: `Bearer ${tokens.adminToken}` },
        payload: { status: 'INACTIVE' },
      });
      const publicEmptyRes = await app.inject({
        method: 'GET',
        url: `/products/${prod.id}/skus`,
      });
      expect(JSON.parse(publicEmptyRes.body).length).toBe(0);
    });

    it('rejects unauthenticated and unauthorized requests for SKU creation (401, 403)', async () => {
      const tokens = await getTokens();

      // 401 Unauthorized
      const res401 = await app.inject({
        method: 'POST',
        url: '/products/some-id/skus',
        payload: { skuCode: 'TEST-1' },
      });
      expect(res401.statusCode).toBe(401);

      // 403 Forbidden (Merchant)
      const res403Merchant = await app.inject({
        method: 'POST',
        url: '/products/some-id/skus',
        headers: { authorization: `Bearer ${tokens.merchantToken}` },
        payload: { skuCode: 'TEST-1' },
      });
      expect(res403Merchant.statusCode).toBe(403);

      // 403 Forbidden (Customer)
      const res403Customer = await app.inject({
        method: 'POST',
        url: '/products/some-id/skus',
        headers: { authorization: `Bearer ${tokens.customerToken}` },
        payload: { skuCode: 'TEST-1' },
      });
      expect(res403Customer.statusCode).toBe(403);
    });
  });

  describe('Failure Edge-cases (404s)', () => {
    it('returns 404 for non-existent category', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/categories/99999999-9999-9999-9999-999999999999',
      });
      expect(res.statusCode).toBe(404);
    });

    it('returns 404 for non-existent product', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/products/99999999-9999-9999-9999-999999999999',
      });
      expect(res.statusCode).toBe(404);
    });

    it('returns 404 for non-existent SKU', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/skus/99999999-9999-9999-9999-999999999999',
      });
      expect(res.statusCode).toBe(404);
    });
  });
});
