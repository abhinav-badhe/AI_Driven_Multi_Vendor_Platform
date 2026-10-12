import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { parseConfig } from '../src/config/index.js';
import {
  createMigratedTestDatabase,
  markAllUsersVerified,
  registerVerifiedUser,
} from './helpers/test-db.js';
import type { DatabaseConnection } from '../src/infra/database/connection.js';

const TOKEN_SECRET = 'super-secret-key-at-least-16-chars';

describe('Customer Wishlist & Save for Later', () => {
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

  async function setupEcosystem() {
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
    const userRes = await db.query<{ id: string }>(
      `SELECT id FROM users WHERE email = 'admin@platform.com'`,
    );
    await db.query(`UPDATE tenant_memberships SET role = 'ADMINISTRATOR' WHERE user_id = $1`, [
      userRes.rows[0]!.id,
    ]);
    await markAllUsersVerified(db);
    const adminLogin = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'admin@platform.com', password: 'Password123!' },
    });
    const { accessToken: adminToken } = adminLogin.json();

    // 2. Merchant Alpha
    const alphaToken = await registerVerifiedUser(app, db, {
      email: 'alpha@store.com',
      password: 'Password123!',
      tenantName: 'Merchant Alpha Store',
      role: 'MERCHANT',
    });
    await app.inject({
      method: 'POST',
      url: '/merchants/onboard',
      headers: { authorization: `Bearer ${alphaToken}` },
      payload: {
        businessName: 'Alpha LLC',
        legalName: 'Alpha Legal',
        contactEmail: 'alpha@biz.com',
      },
    });
    await app.inject({
      method: 'POST',
      url: '/merchants/me/submit',
      headers: { authorization: `Bearer ${alphaToken}` },
    });
    const profA = (
      await app.inject({
        method: 'GET',
        url: '/merchants/me',
        headers: { authorization: `Bearer ${alphaToken}` },
      })
    ).json();
    await app.inject({
      method: 'POST',
      url: `/merchants/${profA.tenantId}/approve`,
      headers: { authorization: `Bearer ${adminToken}` },
    });

    // 3. Customers
    const customer1Token = await registerVerifiedUser(app, db, {
      email: 'customer1@user.com',
      password: 'Password123!',
      tenantName: 'Customer 1 Tenant',
      role: 'CUSTOMER',
    });

    const customer2Token = await registerVerifiedUser(app, db, {
      email: 'customer2@user.com',
      password: 'Password123!',
      tenantName: 'Customer 2 Tenant',
      role: 'CUSTOMER',
    });

    // 4. Products and SKUs
    const cat = (
      await app.inject({
        method: 'POST',
        url: '/categories',
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { name: 'Audio', slug: 'audio' },
      })
    ).json();

    const prod1 = (
      await app.inject({
        method: 'POST',
        url: '/products',
        headers: { authorization: `Bearer ${adminToken}` },
        payload: {
          title: 'Wireless Headphones',
          slug: 'wireless-headphones',
          categoryId: cat.id,
          brand: 'SoundWave',
          thumbnailUrl: 'https://images.example.com/headphones.jpg',
        },
      })
    ).json();

    const sku1 = (
      await app.inject({
        method: 'POST',
        url: `/products/${prod1.id}/skus`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { skuCode: 'WH-BLK-01', attributes: { color: 'Black' } },
      })
    ).json();

    // Activate product and SKU
    await app.inject({
      method: 'POST',
      url: `/products/${prod1.id}/status`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { status: 'ACTIVE' },
    });
    await app.inject({
      method: 'POST',
      url: `/skus/${sku1.id}/status`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { status: 'ACTIVE' },
    });

    // 5. Merchant Listing for SKU 1
    const listing1 = (
      await app.inject({
        method: 'POST',
        url: '/listings',
        headers: { authorization: `Bearer ${alphaToken}` },
        payload: { skuId: sku1.id, priceAmount: 4999, currency: 'INR', compareAtPrice: 5999 },
      })
    ).json();

    await app.inject({
      method: 'POST',
      url: `/listings/${listing1.id}/status`,
      headers: { authorization: `Bearer ${alphaToken}` },
      payload: { status: 'ACTIVE' },
    });

    // 6. Inventory for Listing 1
    await app.inject({
      method: 'POST',
      url: '/inventory',
      headers: { authorization: `Bearer ${alphaToken}` },
      payload: { listingId: listing1.id, initialOnHandQuantity: 10, initialNonSellableQuantity: 0 },
    });

    return {
      adminToken,
      alphaToken,
      customer1Token,
      customer2Token,
      cat,
      prod1,
      sku1,
      listing1,
    };
  }

  it('1. Authenticated customer can add product to wishlist', async () => {
    const { customer1Token, prod1, sku1 } = await setupEcosystem();

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/customer/wishlist',
      headers: { authorization: `Bearer ${customer1Token}` },
      payload: { productId: prod1.id, skuId: sku1.id },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.productId).toBe(prod1.id);
    expect(body.skuId).toBe(sku1.id);
    expect(body.product.title).toBe('Wireless Headphones');
    expect(body.offer.priceAmount).toBe(4999);
    expect(body.availability.isAvailable).toBe(true);
    expect(body.availability.status).toBe('IN_STOCK');
  });

  it('2. Unauthenticated request is rejected (401)', async () => {
    const { prod1 } = await setupEcosystem();

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/customer/wishlist',
      payload: { productId: prod1.id },
    });

    expect(res.statusCode).toBe(401);
  });

  it('3. Product existence validation rejects invalid product (404)', async () => {
    const { customer1Token } = await setupEcosystem();

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/customer/wishlist',
      headers: { authorization: `Bearer ${customer1Token}` },
      payload: { productId: 'non-existent-product-id' },
    });

    expect(res.statusCode).toBe(404);
  });

  it('4. Sku validation rejects sku not belonging to product (400)', async () => {
    const { customer1Token, prod1, adminToken, cat } = await setupEcosystem();

    // Create a 2nd product with its own SKU
    const prod2 = (
      await app.inject({
        method: 'POST',
        url: '/products',
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { title: 'Product 2', slug: 'product-2', categoryId: cat.id },
      })
    ).json();

    const sku2 = (
      await app.inject({
        method: 'POST',
        url: `/products/${prod2.id}/skus`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { skuCode: 'PROD-2-SKU' },
      })
    ).json();

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/customer/wishlist',
      headers: { authorization: `Bearer ${customer1Token}` },
      payload: { productId: prod1.id, skuId: sku2.id },
    });

    expect(res.statusCode).toBe(400);
  });

  it('5. Duplicate add is idempotent and prevents multiple database records', async () => {
    const { customer1Token, prod1 } = await setupEcosystem();

    // 1st add
    const res1 = await app.inject({
      method: 'POST',
      url: '/api/v1/customer/wishlist',
      headers: { authorization: `Bearer ${customer1Token}` },
      payload: { productId: prod1.id },
    });
    expect(res1.statusCode).toBe(201);

    // 2nd add (same product)
    const res2 = await app.inject({
      method: 'POST',
      url: '/api/v1/customer/wishlist',
      headers: { authorization: `Bearer ${customer1Token}` },
      payload: { productId: prod1.id },
    });
    expect(res2.statusCode).toBe(201);

    // Verify DB count is exactly 1
    const countRes = await db.query<{ count: string }>(
      `SELECT count(*) FROM wishlist_items WHERE product_id = $1`,
      [prod1.id],
    );
    expect(parseInt(countRes.rows[0]!.count, 10)).toBe(1);
  });

  it('6. Customer can list own wishlist with live marketplace details and availability', async () => {
    const { customer1Token, prod1, sku1 } = await setupEcosystem();

    await app.inject({
      method: 'POST',
      url: '/api/v1/customer/wishlist',
      headers: { authorization: `Bearer ${customer1Token}` },
      payload: { productId: prod1.id, skuId: sku1.id },
    });

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/customer/wishlist',
      headers: { authorization: `Bearer ${customer1Token}` },
    });

    expect(res.statusCode).toBe(200);
    const items = res.json();
    expect(Array.isArray(items)).toBe(true);
    expect(items.length).toBe(1);
    expect(items[0].productId).toBe(prod1.id);
    expect(items[0].product.title).toBe('Wireless Headphones');
    expect(items[0].offer.priceAmount).toBe(4999);
    expect(items[0].availability.isAvailable).toBe(true);
    expect(items[0].availability.availableQuantity).toBe(10);
  });

  it('7. Customer can remove own item from wishlist (204)', async () => {
    const { customer1Token, prod1 } = await setupEcosystem();

    await app.inject({
      method: 'POST',
      url: '/api/v1/customer/wishlist',
      headers: { authorization: `Bearer ${customer1Token}` },
      payload: { productId: prod1.id },
    });

    const delRes = await app.inject({
      method: 'DELETE',
      url: `/api/v1/customer/wishlist/${prod1.id}`,
      headers: { authorization: `Bearer ${customer1Token}` },
    });
    expect(delRes.statusCode).toBe(204);

    const listRes = await app.inject({
      method: 'GET',
      url: '/api/v1/customer/wishlist',
      headers: { authorization: `Bearer ${customer1Token}` },
    });
    expect(listRes.json().length).toBe(0);
  });

  it('8. Customer cannot access another customer wishlist items', async () => {
    const { customer1Token, customer2Token, prod1 } = await setupEcosystem();

    // Customer 1 adds item
    await app.inject({
      method: 'POST',
      url: '/api/v1/customer/wishlist',
      headers: { authorization: `Bearer ${customer1Token}` },
      payload: { productId: prod1.id },
    });

    // Customer 2 lists wishlist: should be empty
    const res2 = await app.inject({
      method: 'GET',
      url: '/api/v1/customer/wishlist',
      headers: { authorization: `Bearer ${customer2Token}` },
    });
    expect(res2.statusCode).toBe(200);
    expect(res2.json().length).toBe(0);
  });

  it('9. Customer cannot delete another customer wishlist item', async () => {
    const { customer1Token, customer2Token, prod1 } = await setupEcosystem();

    // Customer 1 adds item
    await app.inject({
      method: 'POST',
      url: '/api/v1/customer/wishlist',
      headers: { authorization: `Bearer ${customer1Token}` },
      payload: { productId: prod1.id },
    });

    // Customer 2 attempts to delete Customer 1's product
    await app.inject({
      method: 'DELETE',
      url: `/api/v1/customer/wishlist/${prod1.id}`,
      headers: { authorization: `Bearer ${customer2Token}` },
    });

    // Customer 1's wishlist item remains intact
    const res1 = await app.inject({
      method: 'GET',
      url: '/api/v1/customer/wishlist',
      headers: { authorization: `Bearer ${customer1Token}` },
    });
    expect(res1.json().length).toBe(1);
  });

  it('10. Dynamically reflects inventory stock changes without mutating wishlist record', async () => {
    const { customer1Token, alphaToken, prod1, listing1 } = await setupEcosystem();

    await app.inject({
      method: 'POST',
      url: '/api/v1/customer/wishlist',
      headers: { authorization: `Bearer ${customer1Token}` },
      payload: { productId: prod1.id },
    });

    // Inventory initially 10
    const res1 = await app.inject({
      method: 'GET',
      url: '/api/v1/customer/wishlist',
      headers: { authorization: `Bearer ${customer1Token}` },
    });
    expect(res1.json()[0].availability.isAvailable).toBe(true);
    expect(res1.json()[0].availability.status).toBe('IN_STOCK');

    // Merchant adjusts inventory down to 0
    const invRes = await app.inject({
      method: 'GET',
      url: `/inventory/by-listing/${listing1.id}`,
      headers: { authorization: `Bearer ${alphaToken}` },
    });
    const inv = invRes.json();
    await app.inject({
      method: 'POST',
      url: `/inventory/${inv.id}/decrease-stock`,
      headers: { authorization: `Bearer ${alphaToken}` },
      payload: {
        quantity: 10,
        notes: 'Sold out',
      },
    });

    // Wishlist read now dynamically returns OUT_OF_STOCK, but item is preserved
    const res2 = await app.inject({
      method: 'GET',
      url: '/api/v1/customer/wishlist',
      headers: { authorization: `Bearer ${customer1Token}` },
    });
    expect(res2.json().length).toBe(1);
    expect(res2.json()[0].availability.isAvailable).toBe(false);
    expect(res2.json()[0].availability.status).toBe('OUT_OF_STOCK');
  });

  it('11. Inactive or archived product dynamically returns UNAVAILABLE without deleting record', async () => {
    const { customer1Token, adminToken, prod1 } = await setupEcosystem();

    await app.inject({
      method: 'POST',
      url: '/api/v1/customer/wishlist',
      headers: { authorization: `Bearer ${customer1Token}` },
      payload: { productId: prod1.id },
    });

    // Admin deactivates product
    await app.inject({
      method: 'POST',
      url: `/products/${prod1.id}/status`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { status: 'INACTIVE' },
    });

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/customer/wishlist',
      headers: { authorization: `Bearer ${customer1Token}` },
    });
    expect(res.json().length).toBe(1);
    expect(res.json()[0].product.status).toBe('INACTIVE');
    expect(res.json()[0].availability.isAvailable).toBe(false);
    expect(res.json()[0].availability.status).toBe('UNAVAILABLE');
  });

  it('12. Save for Later removes item from active cart and adds to wishlist', async () => {
    const { customer1Token, listing1, prod1 } = await setupEcosystem();

    // 1. Add item to cart
    const addCartRes = await app.inject({
      method: 'POST',
      url: '/cart/items',
      headers: { authorization: `Bearer ${customer1Token}` },
      payload: { listingId: listing1.id, quantity: 2 },
    });
    expect(addCartRes.statusCode).toBe(200);
    const cart = addCartRes.json();
    expect(cart.items.length).toBe(1);
    const cartItemId = cart.items[0].id;

    // 2. Call Save for Later
    const saveRes = await app.inject({
      method: 'POST',
      url: '/api/v1/customer/wishlist/save-for-later',
      headers: { authorization: `Bearer ${customer1Token}` },
      payload: { cartItemId },
    });
    expect(saveRes.statusCode).toBe(200);
    const saveBody = saveRes.json();
    expect(saveBody.wishlistItem.productId).toBe(prod1.id);
    expect(saveBody.cart.items.length).toBe(0);
    expect(saveBody.cart.itemCount).toBe(0);

    // 3. Verify wishlist contains the item
    const wishRes = await app.inject({
      method: 'GET',
      url: '/api/v1/customer/wishlist',
      headers: { authorization: `Bearer ${customer1Token}` },
    });
    expect(wishRes.json().length).toBe(1);
    expect(wishRes.json()[0].productId).toBe(prod1.id);
  });

  it('13. Move to Cart verifies authoritative pricing/inventory, adds to cart, and removes from wishlist', async () => {
    const { customer1Token, prod1, listing1 } = await setupEcosystem();

    // Add to wishlist
    await app.inject({
      method: 'POST',
      url: '/api/v1/customer/wishlist',
      headers: { authorization: `Bearer ${customer1Token}` },
      payload: { productId: prod1.id },
    });

    // Move to cart
    const moveRes = await app.inject({
      method: 'POST',
      url: `/api/v1/customer/wishlist/${prod1.id}/move-to-cart`,
      headers: { authorization: `Bearer ${customer1Token}` },
      payload: { listingId: listing1.id },
    });
    expect(moveRes.statusCode).toBe(200);
    const moveBody = moveRes.json();
    expect(moveBody.cart.items.length).toBe(1);
    expect(moveBody.cart.items[0].listingId).toBe(listing1.id);
    expect(moveBody.cart.items[0].quantity).toBe(1);

    // Wishlist should now be empty
    const wishRes = await app.inject({
      method: 'GET',
      url: '/api/v1/customer/wishlist',
      headers: { authorization: `Bearer ${customer1Token}` },
    });
    expect(wishRes.json().length).toBe(0);
  });

  it('14. Transactional Outbox records WISHLIST_ITEM_ADDED and WISHLIST_ITEM_REMOVED events', async () => {
    const { customer1Token, prod1 } = await setupEcosystem();

    // Add to wishlist
    await app.inject({
      method: 'POST',
      url: '/api/v1/customer/wishlist',
      headers: { authorization: `Bearer ${customer1Token}` },
      payload: { productId: prod1.id },
    });

    // Check outbox
    const addEvents = await db.query<{ event_type: string; payload: Record<string, unknown> }>(
      `SELECT event_type, payload FROM outbox_events WHERE event_type = 'wishlist.item_added.v1'`,
    );
    expect(addEvents.rows.length).toBeGreaterThanOrEqual(1);
    expect(addEvents.rows[0]!.payload.productId).toBe(prod1.id);

    // Remove from wishlist
    await app.inject({
      method: 'DELETE',
      url: `/api/v1/customer/wishlist/${prod1.id}`,
      headers: { authorization: `Bearer ${customer1Token}` },
    });

    const removeEvents = await db.query<{ event_type: string; payload: Record<string, unknown> }>(
      `SELECT event_type, payload FROM outbox_events WHERE event_type = 'wishlist.item_removed.v1'`,
    );
    expect(removeEvents.rows.length).toBeGreaterThanOrEqual(1);
    expect(removeEvents.rows[0]!.payload.productId).toBe(prod1.id);
  });

  it('15. Check endpoint reports whether product is in wishlist', async () => {
    const { customer1Token, prod1 } = await setupEcosystem();

    // Initially false
    const check1 = await app.inject({
      method: 'GET',
      url: `/api/v1/customer/wishlist/check/${prod1.id}`,
      headers: { authorization: `Bearer ${customer1Token}` },
    });
    expect(check1.statusCode).toBe(200);
    expect(check1.json().isWishlisted).toBe(false);

    // Add to wishlist
    await app.inject({
      method: 'POST',
      url: '/api/v1/customer/wishlist',
      headers: { authorization: `Bearer ${customer1Token}` },
      payload: { productId: prod1.id },
    });

    // Now true
    const check2 = await app.inject({
      method: 'GET',
      url: `/api/v1/customer/wishlist/check/${prod1.id}`,
      headers: { authorization: `Bearer ${customer1Token}` },
    });
    expect(check2.statusCode).toBe(200);
    expect(check2.json().isWishlisted).toBe(true);
    expect(typeof check2.json().wishlistItemId).toBe('string');
  });
});
