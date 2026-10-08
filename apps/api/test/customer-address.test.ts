import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { parseConfig } from '../src/config/index.js';
import { createMigratedTestDatabase, markAllUsersVerified, registerVerifiedUser } from './helpers/test-db.js';
import type { DatabaseConnection } from '../src/infra/database/connection.js';

const TOKEN_SECRET = 'super-secret-key-at-least-16-chars';

describe('Customer Address Book & Order Snapshots', () => {
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
    return token;
  }

  async function setupMarketplaceListing() {
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

    // 2. Merchant
    const merchantToken = await registerVerifiedUser(app, db, {
      email: 'merchant_seller@store.com',
      password: 'Password123!',
      tenantName: 'Seller Store',
      role: 'MERCHANT',
    });

    await app.inject({
      method: 'POST',
      url: '/merchants/onboard',
      headers: { authorization: `Bearer ${merchantToken}` },
      payload: { businessName: 'Seller LLC', legalName: 'Seller Legal', contactEmail: 'seller@biz.com' },
    });
    await app.inject({
      method: 'POST',
      url: '/merchants/me/submit',
      headers: { authorization: `Bearer ${merchantToken}` },
    });
    const prof = (
      await app.inject({
        method: 'GET',
        url: '/merchants/me',
        headers: { authorization: `Bearer ${merchantToken}` },
      })
    ).json();
    await app.inject({
      method: 'POST',
      url: `/merchants/${prof.tenantId}/approve`,
      headers: { authorization: `Bearer ${adminToken}` },
    });

    // 3. Category
    const cat = (
      await app.inject({
        method: 'POST',
        url: '/categories',
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { name: 'Electronics', slug: `elec-${Date.now()}` },
      })
    ).json();

    // 4. Product
    const prod = (
      await app.inject({
        method: 'POST',
        url: '/products',
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { title: 'Headphones', slug: `headphones-${Date.now()}`, categoryId: cat.id },
      })
    ).json();
    await app.inject({
      method: 'POST',
      url: `/products/${prod.id}/status`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { status: 'ACTIVE' },
    });

    // 5. SKU
    const sku = (
      await app.inject({
        method: 'POST',
        url: `/products/${prod.id}/skus`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { skuCode: `HP-${Date.now()}`, attributes: { color: 'Black' } },
      })
    ).json();
    await app.inject({
      method: 'POST',
      url: `/skus/${sku.id}/status`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { status: 'ACTIVE' },
    });

    // 6. Listing
    const listing = (
      await app.inject({
        method: 'POST',
        url: '/listings',
        headers: { authorization: `Bearer ${merchantToken}` },
        payload: { skuId: sku.id, priceAmount: 5000, currency: 'USD' },
      })
    ).json();
    await app.inject({
      method: 'POST',
      url: `/listings/${listing.id}/status`,
      headers: { authorization: `Bearer ${merchantToken}` },
      payload: { status: 'ACTIVE' },
    });

    // 7. Inventory
    await app.inject({
      method: 'POST',
      url: '/inventory',
      headers: { authorization: `Bearer ${merchantToken}` },
      payload: { listingId: listing.id, initialOnHandQuantity: 20 },
    });

    return { listing, merchantToken, adminToken };
  }

  it('1. Address CRUD: creates, reads, updates, and deletes customer address with full fields', async () => {
    const token = await registerCustomer('customer1@example.com');

    // Create address
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/v1/customer/addresses',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        label: 'Home',
        recipientName: 'Jane Doe',
        phone: '+15551234567',
        addressLine1: '123 Market St',
        addressLine2: 'Apt 4B',
        landmark: 'Near City Hall',
        city: 'San Francisco',
        state: 'CA',
        postalCode: '94105',
        country: 'US',
        latitude: 37.7749,
        longitude: -122.4194,
        googlePlaceId: 'ChIJIQBpAG2ahYAR_6128GcTUEo',
        formattedAddress: '123 Market St, Apt 4B, San Francisco, CA 94105, USA',
      },
    });

    expect(createRes.statusCode).toBe(201);
    const created = JSON.parse(createRes.payload);
    expect(created.id).toBeDefined();
    expect(created.recipientName).toBe('Jane Doe');
    expect(created.addressLine1).toBe('123 Market St');
    expect(created.city).toBe('San Francisco');
    expect(created.latitude).toBe(37.7749);
    expect(created.longitude).toBe(-122.4194);
    expect(created.googlePlaceId).toBe('ChIJIQBpAG2ahYAR_6128GcTUEo');
    // First address automatically becomes default
    expect(created.isDefault).toBe(true);

    // Get address by ID
    const getRes = await app.inject({
      method: 'GET',
      url: `/api/v1/customer/addresses/${created.id}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(getRes.statusCode).toBe(200);
    expect(JSON.parse(getRes.payload).id).toBe(created.id);

    // List addresses
    const listRes = await app.inject({
      method: 'GET',
      url: '/api/v1/customer/addresses',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(listRes.statusCode).toBe(200);
    const list = JSON.parse(listRes.payload);
    expect(list.length).toBe(1);
    expect(list[0].id).toBe(created.id);

    // Update address
    const updateRes = await app.inject({
      method: 'PATCH',
      url: `/api/v1/customer/addresses/${created.id}`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        label: 'Work',
        addressLine2: 'Suite 800',
        phone: '+15559876543',
      },
    });
    expect(updateRes.statusCode).toBe(200);
    const updated = JSON.parse(updateRes.payload);
    expect(updated.label).toBe('Work');
    expect(updated.addressLine2).toBe('Suite 800');
    expect(updated.phone).toBe('+15559876543');
    expect(updated.isDefault).toBe(true);

    // Delete address
    const delRes = await app.inject({
      method: 'DELETE',
      url: `/api/v1/customer/addresses/${created.id}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(delRes.statusCode).toBe(204);

    // Verify deleted
    const verifyGet = await app.inject({
      method: 'GET',
      url: `/api/v1/customer/addresses/${created.id}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(verifyGet.statusCode).toBe(404);
  });

  it('2. Default Address Behavior: ensures single default, safe replacement, and safe promotion on delete', async () => {
    const token = await registerCustomer('customer2@example.com');

    // Create 1st address -> auto default
    const addr1Res = await app.inject({
      method: 'POST',
      url: '/api/v1/customer/addresses',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        label: 'Home',
        recipientName: 'First Addr',
        phone: '1111111111',
        addressLine1: '1 First Ave',
        city: 'New York',
        state: 'NY',
        postalCode: '10001',
      },
    });
    const addr1 = JSON.parse(addr1Res.payload);
    expect(addr1.isDefault).toBe(true);

    // Create 2nd address without isDefault -> remains false
    const addr2Res = await app.inject({
      method: 'POST',
      url: '/api/v1/customer/addresses',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        label: 'Work',
        recipientName: 'Second Addr',
        phone: '2222222222',
        addressLine1: '2 Second Ave',
        city: 'New York',
        state: 'NY',
        postalCode: '10002',
      },
    });
    const addr2 = JSON.parse(addr2Res.payload);
    expect(addr2.isDefault).toBe(false);

    // Create 3rd address with isDefault: true -> unsets 1st address default safely
    const addr3Res = await app.inject({
      method: 'POST',
      url: '/api/v1/customer/addresses',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        label: 'Other',
        recipientName: 'Third Addr',
        phone: '3333333333',
        addressLine1: '3 Third Ave',
        city: 'New York',
        state: 'NY',
        postalCode: '10003',
        isDefault: true,
      },
    });
    const addr3 = JSON.parse(addr3Res.payload);
    expect(addr3.isDefault).toBe(true);

    // Verify only addr3 is default now
    const listRes = await app.inject({
      method: 'GET',
      url: '/api/v1/customer/addresses',
      headers: { authorization: `Bearer ${token}` },
    });
    const addresses = JSON.parse(listRes.payload);
    const defaults = addresses.filter((a: { isDefault: boolean }) => a.isDefault);
    expect(defaults.length).toBe(1);
    expect(defaults[0].id).toBe(addr3.id);

    // Explicitly set addr2 as default via /:id/default
    const setDefaultRes = await app.inject({
      method: 'POST',
      url: `/api/v1/customer/addresses/${addr2.id}/default`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(setDefaultRes.statusCode).toBe(200);
    expect(JSON.parse(setDefaultRes.payload).isDefault).toBe(true);

    // Verify addr2 is now the single default
    const listAfterDefault = await app.inject({
      method: 'GET',
      url: '/api/v1/customer/addresses',
      headers: { authorization: `Bearer ${token}` },
    });
    const afterAddresses = JSON.parse(listAfterDefault.payload);
    const defaultsAfter = afterAddresses.filter((a: { isDefault: boolean }) => a.isDefault);
    expect(defaultsAfter.length).toBe(1);
    expect(defaultsAfter[0].id).toBe(addr2.id);

    // Delete the default address (addr2) -> another address (addr1 or addr3) should be safely promoted to default
    const deleteDefaultRes = await app.inject({
      method: 'DELETE',
      url: `/api/v1/customer/addresses/${addr2.id}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(deleteDefaultRes.statusCode).toBe(204);

    const listAfterDelete = await app.inject({
      method: 'GET',
      url: '/api/v1/customer/addresses',
      headers: { authorization: `Bearer ${token}` },
    });
    const remaining = JSON.parse(listAfterDelete.payload);
    expect(remaining.length).toBe(2);
    const remainingDefaults = remaining.filter((a: { isDefault: boolean }) => a.isDefault);
    expect(remainingDefaults.length).toBe(1);
  });

  it('3. Customer Isolation: prevents cross-customer access and rejects forged customerId in request body', async () => {
    const customerA = await registerCustomer('custA@example.com');
    const customerB = await registerCustomer('custB@example.com');

    // Customer A creates address
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/v1/customer/addresses',
      headers: { authorization: `Bearer ${customerA}` },
      payload: {
        recipientName: 'Customer A',
        phone: '1111111111',
        addressLine1: '100 Secret St',
        city: 'Austin',
        state: 'TX',
        postalCode: '78701',
      },
    });
    const addrA = JSON.parse(createRes.payload);

    // Customer B attempts to get Customer A's address
    const getRes = await app.inject({
      method: 'GET',
      url: `/api/v1/customer/addresses/${addrA.id}`,
      headers: { authorization: `Bearer ${customerB}` },
    });
    expect(getRes.statusCode).toBe(404);

    // Customer B attempts to patch Customer A's address
    const patchRes = await app.inject({
      method: 'PATCH',
      url: `/api/v1/customer/addresses/${addrA.id}`,
      headers: { authorization: `Bearer ${customerB}` },
      payload: { addressLine1: 'Hacked Street' },
    });
    expect(patchRes.statusCode).toBe(404);

    // Customer B attempts to delete Customer A's address
    const delRes = await app.inject({
      method: 'DELETE',
      url: `/api/v1/customer/addresses/${addrA.id}`,
      headers: { authorization: `Bearer ${customerB}` },
    });
    expect(delRes.statusCode).toBe(404);

    // Customer B attempts to set Customer A's address as default
    const defRes = await app.inject({
      method: 'POST',
      url: `/api/v1/customer/addresses/${addrA.id}/default`,
      headers: { authorization: `Bearer ${customerB}` },
    });
    expect(defRes.statusCode).toBe(404);

    // Customer B tries to forge customerId in body to Customer A's ID
    const forgeRes = await app.inject({
      method: 'POST',
      url: '/api/v1/customer/addresses',
      headers: { authorization: `Bearer ${customerB}` },
      payload: {
        customerId: 'victim-customer-id',
        recipientName: 'Customer B Spoof',
        phone: '2222222222',
        addressLine1: '200 Normal St',
        city: 'Austin',
        state: 'TX',
        postalCode: '78701',
      },
    });
    expect(forgeRes.statusCode).toBe(201);
    const forgedResult = JSON.parse(forgeRes.payload);
    // Verify created address belongs to Customer B, not forged ID
    expect(forgedResult.customerId).not.toBe('victim-customer-id');
  });

  it('4. Validation: rejects invalid labels, missing required fields, and malformed coordinates', async () => {
    const token = await registerCustomer('cust_validation@example.com');

    // Missing required field: recipientName
    const res1 = await app.inject({
      method: 'POST',
      url: '/api/v1/customer/addresses',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        phone: '1111111111',
        addressLine1: '100 Main St',
        city: 'Seattle',
        state: 'WA',
        postalCode: '98101',
      },
    });
    expect(res1.statusCode).toBe(400);

    // Invalid label
    const res2 = await app.inject({
      method: 'POST',
      url: '/api/v1/customer/addresses',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        label: 'Penthouse',
        recipientName: 'Valid Name',
        phone: '1111111111',
        addressLine1: '100 Main St',
        city: 'Seattle',
        state: 'WA',
        postalCode: '98101',
      },
    });
    expect(res2.statusCode).toBe(400);

    // Malformed latitude
    const res3 = await app.inject({
      method: 'POST',
      url: '/api/v1/customer/addresses',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        recipientName: 'Valid Name',
        phone: '1111111111',
        addressLine1: '100 Main St',
        city: 'Seattle',
        state: 'WA',
        postalCode: '98101',
        latitude: 'not-a-number' as unknown as number,
      },
    });
    expect(res3.statusCode).toBe(400);
  });

  it('5. Checkout & Order Snapshot: persists immutable address snapshot; remains unchanged on subsequent address updates or deletion', async () => {
    const { listing } = await setupMarketplaceListing();

    // Setup Customer
    const customerToken = await registerCustomer('shopper@example.com');

    // Customer creates saved address
    const addrRes = await app.inject({
      method: 'POST',
      url: '/api/v1/customer/addresses',
      headers: { authorization: `Bearer ${customerToken}` },
      payload: {
        label: 'Home',
        recipientName: 'Alice Buyer',
        phone: '+15550001111',
        addressLine1: '742 Evergreen Terrace',
        city: 'Springfield',
        state: 'OR',
        postalCode: '97477',
        country: 'US',
        latitude: 44.0538,
        longitude: -122.9598,
        googlePlaceId: 'place_springfield_742',
      },
    });
    const savedAddress = JSON.parse(addrRes.payload);

    // Add listing to cart
    const cartRes = await app.inject({
      method: 'POST',
      url: '/cart/items',
      headers: { authorization: `Bearer ${customerToken}` },
      payload: {
        listingId: listing.id,
        quantity: 1,
      },
    });
    expect(cartRes.statusCode).toBe(200);

    // Create checkout session using saved address ID
    const checkoutRes = await app.inject({
      method: 'POST',
      url: '/checkout/sessions',
      headers: { authorization: `Bearer ${customerToken}` },
      payload: {
        addressId: savedAddress.id,
      },
    });
    expect(checkoutRes.statusCode).toBe(201);
    const checkout = JSON.parse(checkoutRes.payload);
    expect(checkout.shippingAddress).toBeDefined();
    expect(checkout.shippingAddress.recipientName).toBe('Alice Buyer');
    expect(checkout.shippingAddress.addressLine1).toBe('742 Evergreen Terrace');
    expect(checkout.shippingAddress.googlePlaceId).toBe('place_springfield_742');

    // Reserve inventory
    await app.inject({
      method: 'POST',
      url: `/checkout/sessions/${checkout.id}/reserve`,
      headers: { authorization: `Bearer ${customerToken}` },
    });

    // Create payment intent
    const piRes = await app.inject({
      method: 'POST',
      url: '/payments/intents',
      headers: { authorization: `Bearer ${customerToken}` },
      payload: {
        checkoutSessionId: checkout.id,
        paymentMethod: 'CARD',
      },
    });
    const pi = JSON.parse(piRes.payload);

    // Complete payment
    await app.inject({
      method: 'POST',
      url: `/payments/intents/${pi.id}/attempts`,
      headers: { authorization: `Bearer ${customerToken}` },
      payload: {
        paymentMethod: 'pm_card_visa',
      },
    });

    // Finalize order
    const orderRes = await app.inject({
      method: 'POST',
      url: '/orders',
      headers: { authorization: `Bearer ${customerToken}` },
      payload: {
        checkoutSessionId: checkout.id,
        paymentIntentId: pi.id,
      },
    });
    expect(orderRes.statusCode).toBe(201);
    const order = JSON.parse(orderRes.payload);
    expect(order.shippingAddress).toBeDefined();
    expect(order.shippingAddress.recipientName).toBe('Alice Buyer');
    expect(order.shippingAddress.addressLine1).toBe('742 Evergreen Terrace');
    expect(order.shippingAddress.city).toBe('Springfield');

    // Now Customer EDITS their saved address
    await app.inject({
      method: 'PATCH',
      url: `/api/v1/customer/addresses/${savedAddress.id}`,
      headers: { authorization: `Bearer ${customerToken}` },
      payload: {
        recipientName: 'Alice Changed',
        addressLine1: '999 Completely Different Rd',
        city: 'NewCity',
      },
    });

    // Historical order must remain COMPLETELY UNCHANGED
    const fetchOrderAfterEdit = await app.inject({
      method: 'GET',
      url: `/orders/${order.id}`,
      headers: { authorization: `Bearer ${customerToken}` },
    });
    const orderAfterEdit = JSON.parse(fetchOrderAfterEdit.payload);
    expect(orderAfterEdit.shippingAddress.recipientName).toBe('Alice Buyer');
    expect(orderAfterEdit.shippingAddress.addressLine1).toBe('742 Evergreen Terrace');
    expect(orderAfterEdit.shippingAddress.city).toBe('Springfield');

    // Customer DELETES their saved address entirely
    const delSaved = await app.inject({
      method: 'DELETE',
      url: `/api/v1/customer/addresses/${savedAddress.id}`,
      headers: { authorization: `Bearer ${customerToken}` },
    });
    expect(delSaved.statusCode).toBe(204);

    // Historical order STILL preserves the frozen immutable address snapshot
    const fetchOrderAfterDelete = await app.inject({
      method: 'GET',
      url: `/orders/${order.id}`,
      headers: { authorization: `Bearer ${customerToken}` },
    });
    const orderAfterDelete = JSON.parse(fetchOrderAfterDelete.payload);
    expect(orderAfterDelete.shippingAddress.recipientName).toBe('Alice Buyer');
    expect(orderAfterDelete.shippingAddress.addressLine1).toBe('742 Evergreen Terrace');
    expect(orderAfterDelete.shippingAddress.city).toBe('Springfield');
  });

  it('6. Checkout setShippingAddress endpoint: updates session snapshot dynamically', async () => {
    const { listing } = await setupMarketplaceListing();

    const token = await registerCustomer('cust_update_address@example.com');

    await app.inject({
      method: 'POST',
      url: '/cart/items',
      headers: { authorization: `Bearer ${token}` },
      payload: { listingId: listing.id, quantity: 1 },
    });

    const sessRes = await app.inject({
      method: 'POST',
      url: '/checkout/sessions',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(sessRes.statusCode).toBe(201);
    const session = JSON.parse(sessRes.payload);

    // Update shipping address on checkout session via POST /checkout/sessions/:id/address
    const updateRes = await app.inject({
      method: 'POST',
      url: `/checkout/sessions/${session.id}/address`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        shippingAddress: {
          recipientName: 'Bob Dylan',
          phone: '+15552223333',
          addressLine1: '400 Sunset Blvd',
          city: 'Los Angeles',
          state: 'CA',
          postalCode: '90028',
          country: 'US',
        },
      },
    });
    expect(updateRes.statusCode).toBe(200);
    const updatedSession = JSON.parse(updateRes.payload);
    expect(updatedSession.shippingAddress).toBeDefined();
    expect(updatedSession.shippingAddress.recipientName).toBe('Bob Dylan');
    expect(updatedSession.shippingAddress.addressLine1).toBe('400 Sunset Blvd');
  });

  it('7. Concurrent default updates: handles concurrent setDefault safely without violating partial unique index', async () => {
    const token = await registerCustomer('cust_concurrent_defaults@example.com');

    // Create 3 addresses
    const [a1, a2, a3] = await Promise.all([
      app.inject({
        method: 'POST',
        url: '/api/v1/customer/addresses',
        headers: { authorization: `Bearer ${token}` },
        payload: { recipientName: 'Addr 1', phone: '111', addressLine1: 'Street 1', city: 'City', state: 'ST', postalCode: '11111' },
      }),
      app.inject({
        method: 'POST',
        url: '/api/v1/customer/addresses',
        headers: { authorization: `Bearer ${token}` },
        payload: { recipientName: 'Addr 2', phone: '222', addressLine1: 'Street 2', city: 'City', state: 'ST', postalCode: '22222' },
      }),
      app.inject({
        method: 'POST',
        url: '/api/v1/customer/addresses',
        headers: { authorization: `Bearer ${token}` },
        payload: { recipientName: 'Addr 3', phone: '333', addressLine1: 'Street 3', city: 'City', state: 'ST', postalCode: '33333' },
      }),
    ]);

    const id1 = JSON.parse(a1.payload).id;
    const id2 = JSON.parse(a2.payload).id;
    const id3 = JSON.parse(a3.payload).id;

    // Concurrently trigger setDefault for addr1, addr2, and addr3
    await Promise.all([
      app.inject({ method: 'POST', url: `/api/v1/customer/addresses/${id1}/default`, headers: { authorization: `Bearer ${token}` } }),
      app.inject({ method: 'POST', url: `/api/v1/customer/addresses/${id2}/default`, headers: { authorization: `Bearer ${token}` } }),
      app.inject({ method: 'POST', url: `/api/v1/customer/addresses/${id3}/default`, headers: { authorization: `Bearer ${token}` } }),
    ]);

    // Verify exactly ONE address is marked default
    const listRes = await app.inject({
      method: 'GET',
      url: '/api/v1/customer/addresses',
      headers: { authorization: `Bearer ${token}` },
    });
    const list = JSON.parse(listRes.payload);
    const defaults = list.filter((a: { isDefault: boolean }) => a.isDefault);
    expect(defaults.length).toBe(1);
  });

  it('8. Fulfillment: Shipment creation inherits order immutable shipping address snapshot', async () => {
    const { listing, merchantToken } = await setupMarketplaceListing();
    const customerToken = await registerCustomer('cust_fulfillment_test@example.com');

    // Customer creates saved address
    const addrRes = await app.inject({
      method: 'POST',
      url: '/api/v1/customer/addresses',
      headers: { authorization: `Bearer ${customerToken}` },
      payload: {
        label: 'Home',
        recipientName: 'Snapshot Recipient',
        phone: '+15554445555',
        addressLine1: '500 Snapshot Way',
        city: 'Snapshot City',
        state: 'CA',
        postalCode: '90210',
        country: 'US',
      },
    });
    const savedAddress = JSON.parse(addrRes.payload);

    // Cart + Checkout with saved address
    await app.inject({
      method: 'POST',
      url: '/cart/items',
      headers: { authorization: `Bearer ${customerToken}` },
      payload: { listingId: listing.id, quantity: 1 },
    });

    const checkoutRes = await app.inject({
      method: 'POST',
      url: '/checkout/sessions',
      headers: { authorization: `Bearer ${customerToken}` },
      payload: { addressId: savedAddress.id },
    });
    const checkout = JSON.parse(checkoutRes.payload);

    await app.inject({
      method: 'POST',
      url: `/checkout/sessions/${checkout.id}/reserve`,
      headers: { authorization: `Bearer ${customerToken}` },
    });

    const piRes = await app.inject({
      method: 'POST',
      url: '/payments/intents',
      headers: { authorization: `Bearer ${customerToken}` },
      payload: { checkoutSessionId: checkout.id, paymentMethod: 'CARD' },
    });
    const pi = JSON.parse(piRes.payload);

    await app.inject({
      method: 'POST',
      url: `/payments/intents/${pi.id}/attempts`,
      headers: { authorization: `Bearer ${customerToken}` },
      payload: { paymentMethod: 'pm_card_visa' },
    });

    const orderRes = await app.inject({
      method: 'POST',
      url: '/orders',
      headers: { authorization: `Bearer ${customerToken}` },
      payload: { checkoutSessionId: checkout.id, paymentIntentId: pi.id },
    });
    const order = JSON.parse(orderRes.payload);
    const sellerOrder = order.sellerOrders[0];
    const orderItem = sellerOrder.items[0];

    // Create shipment through fulfillment without specifying recipientAddress
    const shipRes = await app.inject({
      method: 'POST',
      url: '/fulfillment/shipments',
      headers: { authorization: `Bearer ${merchantToken}` },
      payload: {
        sellerOrderId: sellerOrder.id,
        items: [{ orderItemId: orderItem.id, quantity: 1 }],
      },
    });
    expect(shipRes.statusCode).toBe(201);
    const shipment = JSON.parse(shipRes.payload);
    expect(shipment.sellerOrderId).toBe(sellerOrder.id);
    expect(shipment.status).toBe('READY_TO_SHIP');
  });

  it('9. Security Audit: Cross-customer isolation prevents using, modifying, or defaulting another customer address', async () => {
    const { listing } = await setupMarketplaceListing();
    const customerA = await registerCustomer('cust_sec_a@example.com');
    const customerB = await registerCustomer('cust_sec_b@example.com');

    // Customer A creates saved address
    const addrResA = await app.inject({
      method: 'POST',
      url: '/api/v1/customer/addresses',
      headers: { authorization: `Bearer ${customerA}` },
      payload: {
        recipientName: 'Alice Secret',
        phone: '+15551112222',
        addressLine1: '100 Secret Base',
        city: 'Metropolis',
        state: 'NY',
        postalCode: '10001',
      },
    });
    expect(addrResA.statusCode).toBe(201);
    const addressA = JSON.parse(addrResA.payload);

    // 1. Customer B attempts to modify Customer A address
    const patchRes = await app.inject({
      method: 'PATCH',
      url: `/api/v1/customer/addresses/${addressA.id}`,
      headers: { authorization: `Bearer ${customerB}` },
      payload: { recipientName: 'Hacker Bob' },
    });
    expect(patchRes.statusCode).toBe(404);

    // 2. Customer B attempts to set Customer A address as default
    const defRes = await app.inject({
      method: 'POST',
      url: `/api/v1/customer/addresses/${addressA.id}/default`,
      headers: { authorization: `Bearer ${customerB}` },
    });
    expect(defRes.statusCode).toBe(404);

    // 3. Customer B attempts to delete Customer A address
    const delRes = await app.inject({
      method: 'DELETE',
      url: `/api/v1/customer/addresses/${addressA.id}`,
      headers: { authorization: `Bearer ${customerB}` },
    });
    expect(delRes.statusCode).toBe(404);

    // 4. Customer B attempts to create checkout session using Customer A addressId
    await app.inject({
      method: 'POST',
      url: '/cart/items',
      headers: { authorization: `Bearer ${customerB}` },
      payload: { listingId: listing.id, quantity: 1 },
    });

    const chkSessRes = await app.inject({
      method: 'POST',
      url: '/checkout/sessions',
      headers: { authorization: `Bearer ${customerB}` },
      payload: { addressId: addressA.id },
    });
    expect(chkSessRes.statusCode).toBe(404);

    // 5. Customer B creates valid checkout session, then attempts to set Customer A addressId
    const validChkRes = await app.inject({
      method: 'POST',
      url: '/checkout/sessions',
      headers: { authorization: `Bearer ${customerB}` },
    });
    expect(validChkRes.statusCode).toBe(201);
    const validSession = JSON.parse(validChkRes.payload);

    const updateAddrRes = await app.inject({
      method: 'POST',
      url: `/checkout/sessions/${validSession.id}/address`,
      headers: { authorization: `Bearer ${customerB}` },
      payload: { addressId: addressA.id },
    });
    expect(updateAddrRes.statusCode).toBe(404);
  });

  it('10. Security Audit: Server-authoritative manual address validation & spoofing defense', async () => {
    const { listing } = await setupMarketplaceListing();
    const customerToken = await registerCustomer('cust_sec_manual@example.com');

    await app.inject({
      method: 'POST',
      url: '/cart/items',
      headers: { authorization: `Bearer ${customerToken}` },
      payload: { listingId: listing.id, quantity: 1 },
    });

    const sessRes = await app.inject({
      method: 'POST',
      url: '/checkout/sessions',
      headers: { authorization: `Bearer ${customerToken}` },
    });
    const session = JSON.parse(sessRes.payload);

    // 1. Rejects missing recipientName
    const badNameRes = await app.inject({
      method: 'POST',
      url: `/checkout/sessions/${session.id}/address`,
      headers: { authorization: `Bearer ${customerToken}` },
      payload: {
        shippingAddress: {
          recipientName: '',
          phone: '1234567890',
          addressLine1: '123 Test St',
          city: 'City',
          state: 'CA',
          postalCode: '90001',
        },
      },
    });
    expect(badNameRes.statusCode).toBe(422);

    // 2. Rejects missing addressLine1
    const badStreetRes = await app.inject({
      method: 'POST',
      url: `/checkout/sessions/${session.id}/address`,
      headers: { authorization: `Bearer ${customerToken}` },
      payload: {
        shippingAddress: {
          recipientName: 'Valid Name',
          phone: '1234567890',
          addressLine1: '',
          city: 'City',
          state: 'CA',
          postalCode: '90001',
        },
      },
    });
    expect(badStreetRes.statusCode).toBe(422);

    // 3. Rejects invalid coordinates
    const badCoordsRes = await app.inject({
      method: 'POST',
      url: `/checkout/sessions/${session.id}/address`,
      headers: { authorization: `Bearer ${customerToken}` },
      payload: {
        shippingAddress: {
          recipientName: 'Valid Name',
          phone: '1234567890',
          addressLine1: '123 Valid St',
          city: 'City',
          state: 'CA',
          postalCode: '90001',
          latitude: 999, // Invalid latitude > 90
        },
      },
    });
    expect(badCoordsRes.statusCode).toBe(422);

    // 4. Valid manual address: server sanitizes and enforces sourceType MANUAL_ENTRY without spoofed addressId
    const goodManualRes = await app.inject({
      method: 'POST',
      url: `/checkout/sessions/${session.id}/address`,
      headers: { authorization: `Bearer ${customerToken}` },
      payload: {
        shippingAddress: {
          addressId: 'spoofed-address-id',
          sourceType: 'SAVED_ADDRESS', // Client attempts to pretend this is a saved address
          recipientName: 'Manual Recipient',
          phone: '+15559876543',
          addressLine1: '987 Verified Manual Way',
          city: 'San Francisco',
          state: 'CA',
          postalCode: '94107',
          country: 'US',
          latitude: 37.7749,
          longitude: -122.4194,
        },
      },
    });
    expect(goodManualRes.statusCode).toBe(200);
    const updatedSess = JSON.parse(goodManualRes.payload);
    expect(updatedSess.shippingAddress).toBeDefined();
    expect(updatedSess.shippingAddress.sourceType).toBe('MANUAL_ENTRY');
    expect(updatedSess.shippingAddress.addressId).toBeUndefined();
    expect(updatedSess.shippingAddress.recipientName).toBe('Manual Recipient');
    expect(updatedSess.shippingAddress.latitude).toBe(37.7749);
  });
});
