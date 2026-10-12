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
import { SettlementService } from '../src/modules/settlement-ledger/index.js';
import type { Logger } from '../src/observability/logger.js';
import type { OrderService } from '../src/modules/orders/index.js';
import type { PaymentService } from '../src/modules/payment/index.js';

const TOKEN_SECRET = 'super-secret-key-at-least-16-chars';

describe('Phase 8: Marketplace Finance / Settlement & Ledger', () => {
  let app: FastifyInstance;
  let db: DatabaseConnection;

  beforeEach(async () => {
    db = await createMigratedTestDatabase();

    const config = parseConfig({
      NODE_ENV: 'test',
      PORT: '0',
      HOST: '127.0.0.1',
      LOG_LEVEL: 'error',
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
    const membershipRes = await db.query<{ tenant_id: string }>(
      `SELECT tenant_id FROM tenant_memberships WHERE user_id = $1`,
      [userRes.rows[0]!.id],
    );
    await db.query(`UPDATE tenant_memberships SET role = 'ADMINISTRATOR' WHERE user_id = $1`, [
      userRes.rows[0]!.id,
    ]);
    await db.query(`UPDATE tenants SET type = 'PLATFORM' WHERE id = $1`, [
      membershipRes.rows[0]!.tenant_id,
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

    // 3. Merchant Beta
    const betaToken = await registerVerifiedUser(app, db, {
      email: 'beta@store.com',
      password: 'Password123!',
      tenantName: 'Merchant Beta Store',
      role: 'MERCHANT',
    });

    await app.inject({
      method: 'POST',
      url: '/merchants/onboard',
      headers: { authorization: `Bearer ${betaToken}` },
      payload: { businessName: 'Beta LLC', legalName: 'Beta Legal', contactEmail: 'beta@biz.com' },
    });
    await app.inject({
      method: 'POST',
      url: '/merchants/me/submit',
      headers: { authorization: `Bearer ${betaToken}` },
    });
    const profB = (
      await app.inject({
        method: 'GET',
        url: '/merchants/me',
        headers: { authorization: `Bearer ${betaToken}` },
      })
    ).json();
    await app.inject({
      method: 'POST',
      url: `/merchants/${profB.tenantId}/approve`,
      headers: { authorization: `Bearer ${adminToken}` },
    });

    // 4. Catalog, SKUs, and Listings
    const cat = (
      await app.inject({
        method: 'POST',
        url: '/categories',
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { name: 'Electronics', slug: 'electronics' },
      })
    ).json();

    // Product & SKU Alpha
    const prodA = (
      await app.inject({
        method: 'POST',
        url: '/products',
        headers: { authorization: `Bearer ${adminToken}` },
        payload: {
          title: 'Smartphone Alpha',
          slug: 'phone-alpha',
          brand: 'BrandA',
          categoryId: cat.id,
        },
      })
    ).json();
    await app.inject({
      method: 'POST',
      url: `/products/${prodA.id}/status`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { status: 'ACTIVE' },
    });
    const skuA = (
      await app.inject({
        method: 'POST',
        url: `/products/${prodA.id}/skus`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { skuCode: 'SKU-ALPHA-01', attributes: { color: 'Black' } },
      })
    ).json();
    await app.inject({
      method: 'POST',
      url: `/skus/${skuA.id}/status`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { status: 'ACTIVE' },
    });

    const listA = (
      await app.inject({
        method: 'POST',
        url: '/listings',
        headers: { authorization: `Bearer ${alphaToken}` },
        payload: { skuId: skuA.id, priceAmount: 10000, currency: 'INR' }, // 100.00 INR
      })
    ).json();
    await app.inject({
      method: 'POST',
      url: `/listings/${listA.id}/status`,
      headers: { authorization: `Bearer ${alphaToken}` },
      payload: { status: 'ACTIVE' },
    });

    const invA = (
      await app.inject({
        method: 'POST',
        url: '/inventory',
        headers: { authorization: `Bearer ${alphaToken}` },
        payload: { listingId: listA.id, skuId: skuA.id, initialOnHandQuantity: 50 },
      })
    ).json();

    // Product & SKU Beta
    const prodB = (
      await app.inject({
        method: 'POST',
        url: '/products',
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { title: 'Laptop Beta', slug: 'laptop-beta', brand: 'BrandB', categoryId: cat.id },
      })
    ).json();
    await app.inject({
      method: 'POST',
      url: `/products/${prodB.id}/status`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { status: 'ACTIVE' },
    });
    const skuB = (
      await app.inject({
        method: 'POST',
        url: `/products/${prodB.id}/skus`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { skuCode: 'SKU-BETA-01', attributes: { ram: '16GB' } },
      })
    ).json();
    await app.inject({
      method: 'POST',
      url: `/skus/${skuB.id}/status`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { status: 'ACTIVE' },
    });

    const listB = (
      await app.inject({
        method: 'POST',
        url: '/listings',
        headers: { authorization: `Bearer ${betaToken}` },
        payload: { skuId: skuB.id, priceAmount: 20000, currency: 'INR' }, // 200.00 INR
      })
    ).json();
    await app.inject({
      method: 'POST',
      url: `/listings/${listB.id}/status`,
      headers: { authorization: `Bearer ${betaToken}` },
      payload: { status: 'ACTIVE' },
    });

    const invB = (
      await app.inject({
        method: 'POST',
        url: '/inventory',
        headers: { authorization: `Bearer ${betaToken}` },
        payload: { listingId: listB.id, skuId: skuB.id, initialOnHandQuantity: 50 },
      })
    ).json();

    // 5. Customer
    const custToken = await registerVerifiedUser(app, db, {
      email: 'buyer@example.com',
      password: 'Password123!',
      tenantName: 'Buyer Personal',
      role: 'CUSTOMER',
    });
    const custUser = await db.query<{ tenant_id: string }>(
      `SELECT tenant_id FROM tenant_memberships WHERE user_id = (SELECT id FROM users WHERE email = 'buyer@example.com')`,
    );
    const custTenantId = custUser.rows[0]!.tenant_id;

    return {
      adminToken,
      alphaToken,
      alphaTenantId: profA.tenantId as string,
      betaToken,
      betaTenantId: profB.tenantId as string,
      custToken,
      custTenantId,
      listA,
      invA,
      listB,
      invB,
    };
  }

  async function createMultiVendorPaidOrder(eco: Awaited<ReturnType<typeof setupEcosystem>>) {
    // 1. Add items from Merchant Alpha (qty 1 @ 10000) and Merchant Beta (qty 1 @ 20000)
    await app.inject({
      method: 'POST',
      url: '/cart/items',
      headers: { authorization: `Bearer ${eco.custToken}` },
      payload: { listingId: eco.listA.id, quantity: 1 },
    });
    await app.inject({
      method: 'POST',
      url: '/cart/items',
      headers: { authorization: `Bearer ${eco.custToken}` },
      payload: { listingId: eco.listB.id, quantity: 1 },
    });

    // 2. Checkout Session & Reserve
    const session = (
      await app.inject({
        method: 'POST',
        url: '/checkout/sessions',
        headers: { authorization: `Bearer ${eco.custToken}` },
      })
    ).json();

    await app.inject({
      method: 'POST',
      url: `/checkout/sessions/${session.id}/reserve`,
      headers: { authorization: `Bearer ${eco.custToken}` },
    });

    // 3. Payment Intent & Succeeded Attempt
    const intent = (
      await app.inject({
        method: 'POST',
        url: '/payments/intents',
        headers: { authorization: `Bearer ${eco.custToken}` },
        payload: { checkoutSessionId: session.id },
      })
    ).json();

    await app.inject({
      method: 'POST',
      url: `/payments/intents/${intent.id}/attempts`,
      headers: { authorization: `Bearer ${eco.custToken}` },
      payload: { paymentMethod: 'pm_card_visa' },
    });

    // 4. Create Order -> 1 Customer Order with 2 Seller Orders
    const orderRes = await app.inject({
      method: 'POST',
      url: '/orders',
      headers: { authorization: `Bearer ${eco.custToken}` },
      payload: { checkoutSessionId: session.id, paymentIntentId: intent.id },
    });
    expect(orderRes.statusCode).toBe(201);
    const order = orderRes.json();

    const sellerOrderAlpha = order.sellerOrders.find(
      (so: { sellerTenantId: string }) => so.sellerTenantId === eco.alphaTenantId,
    );
    const sellerOrderBeta = order.sellerOrders.find(
      (so: { sellerTenantId: string }) => so.sellerTenantId === eco.betaTenantId,
    );

    return { order, sellerOrderAlpha, sellerOrderBeta, intent };
  }

  describe('Multi-Vendor Financial Attribution & Ledger Creation', () => {
    it('accurately attributes gross, commission, and net earnings per seller independently', async () => {
      const eco = await setupEcosystem();
      const { sellerOrderAlpha, sellerOrderBeta } = await createMultiVendorPaidOrder(eco);

      // Ingest Order Alpha: Gross 100.00, Commission 10% (10.00), Net 90.00
      const ingestAlpha = await app.inject({
        method: 'POST',
        url: '/settlement/ingest/order',
        headers: { authorization: `Bearer ${eco.adminToken}` },
        payload: { sellerOrderId: sellerOrderAlpha.id, commissionRate: 0.1 },
      });
      if (ingestAlpha.statusCode !== 201) console.log('INGEST ERROR', ingestAlpha.body);
      expect(ingestAlpha.statusCode).toBe(201);
      const alphaResult = ingestAlpha.json();
      expect(alphaResult.earningEntry.amount).toBe(100.0);
      expect(alphaResult.earningEntry.direction).toBe('CREDIT');
      expect(alphaResult.commissionEntry.amount).toBe(10.0);
      expect(alphaResult.commissionEntry.direction).toBe('DEBIT');

      // Ingest Order Beta: Gross 200.00, Commission 15% (30.00), Net 170.00
      const ingestBeta = await app.inject({
        method: 'POST',
        url: '/settlement/ingest/order',
        headers: { authorization: `Bearer ${eco.adminToken}` },
        payload: { sellerOrderId: sellerOrderBeta.id, commissionRate: 0.15 },
      });
      expect(ingestBeta.statusCode).toBe(201);
      const betaResult = ingestBeta.json();
      expect(betaResult.earningEntry.amount).toBe(200.0);
      expect(betaResult.earningEntry.direction).toBe('CREDIT');
      expect(betaResult.commissionEntry.amount).toBe(30.0);
      expect(betaResult.commissionEntry.direction).toBe('DEBIT');

      // Verify Merchant Alpha Financial Summary: currentBalance = 90.00
      const sumAlpha = await app.inject({
        method: 'GET',
        url: `/settlement/merchants/${eco.alphaTenantId}/summary?currency=INR`,
        headers: { authorization: `Bearer ${eco.alphaToken}` },
      });
      expect(sumAlpha.statusCode).toBe(200);
      expect(sumAlpha.json().currentBalance).toBe(90.0);
      expect(sumAlpha.json().totalEarnings).toBe(100.0);
      expect(sumAlpha.json().totalCommissions).toBe(10.0);

      // Verify Merchant Beta Financial Summary: currentBalance = 170.00
      const sumBeta = await app.inject({
        method: 'GET',
        url: `/settlement/merchants/${eco.betaTenantId}/summary?currency=INR`,
        headers: { authorization: `Bearer ${eco.betaToken}` },
      });
      expect(sumBeta.statusCode).toBe(200);
      expect(sumBeta.json().currentBalance).toBe(170.0);
      expect(sumBeta.json().totalEarnings).toBe(200.0);
      expect(sumBeta.json().totalCommissions).toBe(30.0);
    }, 15000);

    it('enforces append-only immutable ledger and verifies financial invariant', async () => {
      const eco = await setupEcosystem();
      const { sellerOrderAlpha } = await createMultiVendorPaidOrder(eco);

      await app.inject({
        method: 'POST',
        url: '/settlement/ingest/order',
        headers: { authorization: `Bearer ${eco.adminToken}` },
        payload: { sellerOrderId: sellerOrderAlpha.id, commissionRate: 0.1, feeAmount: 2.0 },
      });

      // Add financial credit adjustment +15.00
      await app.inject({
        method: 'POST',
        url: '/settlement/adjustments',
        headers: { authorization: `Bearer ${eco.adminToken}` },
        payload: {
          merchantId: eco.alphaTenantId,
          amount: 15.0,
          currency: 'INR',
          type: 'CREDIT',
          reason: 'Shipping fee subsidy',
        },
      });

      // Add financial debit adjustment -5.00
      await app.inject({
        method: 'POST',
        url: '/settlement/adjustments',
        headers: { authorization: `Bearer ${eco.adminToken}` },
        payload: {
          merchantId: eco.alphaTenantId,
          amount: 5.0,
          currency: 'INR',
          type: 'DEBIT',
          reason: 'Packaging charge',
        },
      });

      // Invariant:
      // seller_net = gross (100) - commission (10) - fees (2) + adjustments (15 - 5)
      // seller_net = 100 - 10 - 2 + 10 = 98.00
      const summary = (
        await app.inject({
          method: 'GET',
          url: `/settlement/merchants/${eco.alphaTenantId}/summary`,
          headers: { authorization: `Bearer ${eco.alphaToken}` },
        })
      ).json();

      expect(summary.currentBalance).toBe(98.0);
      expect(summary.totalEarnings).toBe(100.0);
      expect(summary.totalCommissions).toBe(10.0);
      expect(summary.totalFees).toBe(2.0);
      expect(summary.totalAdjustments).toBe(10.0);

      // Verify ledger entries are strictly preserved
      const ledger = (
        await app.inject({
          method: 'GET',
          url: `/settlement/merchants/${eco.alphaTenantId}/ledger`,
          headers: { authorization: `Bearer ${eco.alphaToken}` },
        })
      ).json();
      expect(ledger.entries.length).toBe(5); // EARNING, COMMISSION, FEE, ADJUSTMENT(+), ADJUSTMENT(-)
    });
  });

  describe('Tenant Isolation & Cross-Tenant RBAC Enforcement', () => {
    it('prevents Merchant Beta from reading Merchant Alpha financial summary or ledger', async () => {
      const eco = await setupEcosystem();

      // Beta tries to access Alpha summary -> 403 Forbidden
      const res1 = await app.inject({
        method: 'GET',
        url: `/settlement/merchants/${eco.alphaTenantId}/summary`,
        headers: { authorization: `Bearer ${eco.betaToken}` },
      });
      expect(res1.statusCode).toBe(403);

      // Beta tries to access Alpha ledger -> 403 Forbidden
      const res2 = await app.inject({
        method: 'GET',
        url: `/settlement/merchants/${eco.alphaTenantId}/ledger`,
        headers: { authorization: `Bearer ${eco.betaToken}` },
      });
      expect(res2.statusCode).toBe(403);
    });

    it('prevents Customer from reading seller financial balances or settlements', async () => {
      const eco = await setupEcosystem();

      const res = await app.inject({
        method: 'GET',
        url: `/settlement/merchants/${eco.alphaTenantId}/summary`,
        headers: { authorization: `Bearer ${eco.custToken}` },
      });
      expect(res.statusCode).toBe(403);
    });

    it('prevents non-administrator from creating adjustments or calculating settlements', async () => {
      const eco = await setupEcosystem();

      const res1 = await app.inject({
        method: 'POST',
        url: '/settlement/adjustments',
        headers: { authorization: `Bearer ${eco.alphaToken}` },
        payload: {
          merchantId: eco.alphaTenantId,
          amount: 50.0,
          currency: 'INR',
          type: 'CREDIT',
          reason: 'Self-grant',
        },
      });
      expect(res1.statusCode).toBe(403);

      const res2 = await app.inject({
        method: 'POST',
        url: '/settlement/settlements/calculate',
        headers: { authorization: `Bearer ${eco.alphaToken}` },
        payload: {
          merchantId: eco.alphaTenantId,
          periodStart: new Date(Date.now() - 86400000).toISOString(),
          periodEnd: new Date().toISOString(),
          currency: 'INR',
        },
      });
      expect(res2.statusCode).toBe(403);
    });
  });

  describe('Refund Financial Compensation & Idempotent Deduplication', () => {
    it('compensates refund with seller debit and commission reimbursement, preventing double-debit on retry', async () => {
      const eco = await setupEcosystem();
      const { sellerOrderAlpha } = await createMultiVendorPaidOrder(eco);

      // 1. Initial Order Ingestion: Gross 100.00, Commission 10.00 -> Balance 90.00
      await app.inject({
        method: 'POST',
        url: '/settlement/ingest/order',
        headers: { authorization: `Bearer ${eco.adminToken}` },
        payload: { sellerOrderId: sellerOrderAlpha.id, commissionRate: 0.1 },
      });

      // 2. Customer refund occurs for 50.00 (commission reversal 5.00)
      const refundId = 'ref_alpha_test_101';
      const ingestRefund = await app.inject({
        method: 'POST',
        url: '/settlement/ingest/refund',
        headers: { authorization: `Bearer ${eco.adminToken}` },
        payload: {
          merchantId: eco.alphaTenantId,
          refundId,
          sellerOrderId: sellerOrderAlpha.id,
          refundAmount: 50.0,
          commissionRefundAmount: 5.0,
          currency: 'INR',
          reason: 'Customer return approved',
          idempotencyKey: 'idem_ref_101',
        },
      });
      expect(ingestRefund.statusCode).toBe(201);
      const refundRes = ingestRefund.json();
      expect(refundRes.refundEntry.amount).toBe(50.0);
      expect(refundRes.refundEntry.direction).toBe('DEBIT');
      expect(refundRes.commissionReversalEntry.amount).toBe(5.0);
      expect(refundRes.commissionReversalEntry.direction).toBe('CREDIT');

      // Net deduction: 50.00 - 5.00 = 45.00. Current balance: 90.00 - 45.00 = 45.00
      const summaryAfter = (
        await app.inject({
          method: 'GET',
          url: `/settlement/merchants/${eco.alphaTenantId}/summary`,
          headers: { authorization: `Bearer ${eco.alphaToken}` },
        })
      ).json();
      expect(summaryAfter.currentBalance).toBe(45.0);
      expect(summaryAfter.totalRefunds).toBe(50.0);
      expect(summaryAfter.totalCommissions).toBe(5.0); // 10.00 initial - 5.00 reversal

      // 3. Retry identical refund request -> Returns existing result with ZERO balance mutation
      const retryRefund = await app.inject({
        method: 'POST',
        url: '/settlement/ingest/refund',
        headers: { authorization: `Bearer ${eco.adminToken}` },
        payload: {
          merchantId: eco.alphaTenantId,
          refundId,
          sellerOrderId: sellerOrderAlpha.id,
          refundAmount: 50.0,
          commissionRefundAmount: 5.0,
          currency: 'INR',
          reason: 'Customer return approved',
          idempotencyKey: 'idem_ref_101',
        },
      });
      expect(retryRefund.statusCode).toBe(201);

      const summaryAfterRetry = (
        await app.inject({
          method: 'GET',
          url: `/settlement/merchants/${eco.alphaTenantId}/summary`,
          headers: { authorization: `Bearer ${eco.alphaToken}` },
        })
      ).json();
      expect(summaryAfterRetry.currentBalance).toBe(45.0); // NOT deducted again!
    });
  });

  describe('Settlement Calculation, Lifecycle State Machine & Payouts', () => {
    it('executes full settlement lifecycle: CALCULATED -> APPROVED -> PROCESSING -> SETTLED with payout debit', async () => {
      const eco = await setupEcosystem();
      const { sellerOrderAlpha } = await createMultiVendorPaidOrder(eco);

      // Ingest Order: Gross 100.00, Commission 10.00, Net 90.00
      await app.inject({
        method: 'POST',
        url: '/settlement/ingest/order',
        headers: { authorization: `Bearer ${eco.adminToken}` },
        payload: { sellerOrderId: sellerOrderAlpha.id, commissionRate: 0.1 },
      });

      const periodStart = new Date(Date.now() - 3600000).toISOString();
      const periodEnd = new Date(Date.now() + 3600000).toISOString();

      // 1. Calculate Settlement
      const calcRes = await app.inject({
        method: 'POST',
        url: '/settlement/settlements/calculate',
        headers: { authorization: `Bearer ${eco.adminToken}` },
        payload: {
          merchantId: eco.alphaTenantId,
          periodStart,
          periodEnd,
          currency: 'INR',
          idempotencyKey: 'settle_batch_01',
        },
      });
      expect(calcRes.statusCode).toBe(201);
      const settlement = calcRes.json();
      expect(settlement.status).toBe('CALCULATED');
      expect(settlement.grossAmount).toBe(100.0);
      expect(settlement.commissionAmount).toBe(10.0);
      expect(settlement.netPayableAmount).toBe(90.0);
      expect(settlement.items.length).toBe(2); // EARNING and COMMISSION entries linked

      // 2. Reject invalid jump: CALCULATED -> SETTLED directly
      const invalidJump = await app.inject({
        method: 'POST',
        url: `/settlement/settlements/${settlement.id}/transition`,
        headers: { authorization: `Bearer ${eco.adminToken}` },
        payload: { targetStatus: 'SETTLED' },
      });
      expect(invalidJump.statusCode).toBe(409); // InvalidStateTransitionError

      // 3. Valid transition: CALCULATED -> APPROVED
      const approvedRes = await app.inject({
        method: 'POST',
        url: `/settlement/settlements/${settlement.id}/transition`,
        headers: { authorization: `Bearer ${eco.adminToken}` },
        payload: { targetStatus: 'APPROVED' },
      });
      expect(approvedRes.statusCode).toBe(200);
      expect(approvedRes.json().status).toBe('APPROVED');

      // 4. Valid transition: APPROVED -> PROCESSING
      const processingRes = await app.inject({
        method: 'POST',
        url: `/settlement/settlements/${settlement.id}/transition`,
        headers: { authorization: `Bearer ${eco.adminToken}` },
        payload: { targetStatus: 'PROCESSING' },
      });
      expect(processingRes.statusCode).toBe(200);
      expect(processingRes.json().status).toBe('PROCESSING');

      // 5. Valid transition: PROCESSING -> SETTLED
      const settledRes = await app.inject({
        method: 'POST',
        url: `/settlement/settlements/${settlement.id}/transition`,
        headers: { authorization: `Bearer ${eco.adminToken}` },
        payload: { targetStatus: 'SETTLED' },
      });
      expect(settledRes.statusCode).toBe(200);
      expect(settledRes.json().status).toBe('SETTLED');

      // 6. Verify balances after SETTLED:
      // currentBalance = 90.00 - 90.00 = 0.00
      // settledBalance = 90.00
      const summaryFinal = (
        await app.inject({
          method: 'GET',
          url: `/settlement/merchants/${eco.alphaTenantId}/summary`,
          headers: { authorization: `Bearer ${eco.alphaToken}` },
        })
      ).json();
      expect(summaryFinal.currentBalance).toBe(0.0);
      expect(summaryFinal.settledBalance).toBe(90.0);

      // Verify PAYOUT ledger entry is posted
      const ledger = (
        await app.inject({
          method: 'GET',
          url: `/settlement/merchants/${eco.alphaTenantId}/ledger`,
          headers: { authorization: `Bearer ${eco.alphaToken}` },
        })
      ).json();
      const payoutEntry = ledger.entries.find(
        (e: { entryType: string }) => e.entryType === 'PAYOUT',
      );
      expect(payoutEntry).toBeDefined();
      expect(payoutEntry.amount).toBe(90.0);
      expect(payoutEntry.direction).toBe('DEBIT');
    });
  });

  describe('Concurrency & Failure Recovery Matrix (Cases A - I)', () => {
    it('Case A/B/C: handles concurrent duplicate order ingestion safely without duplicating balance or ledger entries', async () => {
      const eco = await setupEcosystem();
      const { sellerOrderAlpha } = await createMultiVendorPaidOrder(eco);

      // Fire 2 concurrent ingestion requests with the same idempotency key
      const [res1, res2] = await Promise.all([
        app.inject({
          method: 'POST',
          url: '/settlement/ingest/order',
          headers: { authorization: `Bearer ${eco.adminToken}` },
          payload: {
            sellerOrderId: sellerOrderAlpha.id,
            commissionRate: 0.1,
            idempotencyKey: 'idem_race_order_01',
          },
        }),
        app.inject({
          method: 'POST',
          url: '/settlement/ingest/order',
          headers: { authorization: `Bearer ${eco.adminToken}` },
          payload: {
            sellerOrderId: sellerOrderAlpha.id,
            commissionRate: 0.1,
            idempotencyKey: 'idem_race_order_01',
          },
        }),
      ]);

      expect(res1.statusCode).toBe(201);
      expect(res2.statusCode).toBe(201);

      // Verify balance is only incremented ONCE (90.00, not 180.00)
      const summary = (
        await app.inject({
          method: 'GET',
          url: `/settlement/merchants/${eco.alphaTenantId}/summary`,
          headers: { authorization: `Bearer ${eco.alphaToken}` },
        })
      ).json();
      expect(summary.currentBalance).toBe(90.0);

      // Verify exactly 2 ledger entries exist for this order (1 EARNING + 1 COMMISSION)
      const ledger = (
        await app.inject({
          method: 'GET',
          url: `/settlement/merchants/${eco.alphaTenantId}/ledger`,
          headers: { authorization: `Bearer ${eco.alphaToken}` },
        })
      ).json();
      expect(ledger.entries.length).toBe(2);
    });

    it('Case G: concurrent seller balance mutations do not lose balance updates', async () => {
      const eco = await setupEcosystem();

      // Concurrently dispatch 5 credit adjustments of 10.00 each
      const promises = Array.from({ length: 5 }).map((_, i) =>
        app.inject({
          method: 'POST',
          url: '/settlement/adjustments',
          headers: { authorization: `Bearer ${eco.adminToken}` },
          payload: {
            merchantId: eco.alphaTenantId,
            amount: 10.0,
            currency: 'INR',
            type: 'CREDIT',
            reason: `Parallel adjustment #${i}`,
            idempotencyKey: `adj_parallel_${i}`,
          },
        }),
      );

      const results = await Promise.all(promises);
      for (const r of results) {
        expect(r.statusCode).toBe(201);
      }

      // 5 * 10.00 = exactly 50.00
      const summary = (
        await app.inject({
          method: 'GET',
          url: `/settlement/merchants/${eco.alphaTenantId}/summary`,
          headers: { authorization: `Bearer ${eco.alphaToken}` },
        })
      ).json();
      expect(summary.currentBalance).toBe(50.0);
      expect(summary.totalAdjustments).toBe(50.0);
    });

    it('Case H: rejects idempotency key reuse with different amount or payload', async () => {
      const eco = await setupEcosystem();

      // First adjustment with key 'adj_same_key_100' for 20.00
      const res1 = await app.inject({
        method: 'POST',
        url: '/settlement/adjustments',
        headers: { authorization: `Bearer ${eco.adminToken}` },
        payload: {
          merchantId: eco.alphaTenantId,
          amount: 20.0,
          currency: 'INR',
          type: 'CREDIT',
          reason: 'Initial adjustment',
          idempotencyKey: 'adj_same_key_100',
        },
      });
      expect(res1.statusCode).toBe(201);

      // Reusing same key with different amount (40.00) -> 409 Conflict
      const res2 = await app.inject({
        method: 'POST',
        url: '/settlement/adjustments',
        headers: { authorization: `Bearer ${eco.adminToken}` },
        payload: {
          merchantId: eco.alphaTenantId,
          amount: 40.0,
          currency: 'INR',
          type: 'CREDIT',
          reason: 'Altered adjustment',
          idempotencyKey: 'adj_same_key_100',
        },
      });
      expect(res2.statusCode).toBe(409);
    });

    it('Case D & E: transaction rollback during settlement calculation leaves zero partial settlement records or items', async () => {
      const eco = await setupEcosystem();
      const { sellerOrderAlpha } = await createMultiVendorPaidOrder(eco);

      await app.inject({
        method: 'POST',
        url: '/settlement/ingest/order',
        headers: { authorization: `Bearer ${eco.adminToken}` },
        payload: { sellerOrderId: sellerOrderAlpha.id },
      });

      // Pass periodEnd earlier than periodStart -> triggers ValidationError, rolls back
      const res = await app.inject({
        method: 'POST',
        url: '/settlement/settlements/calculate',
        headers: { authorization: `Bearer ${eco.adminToken}` },
        payload: {
          merchantId: eco.alphaTenantId,
          periodStart: new Date(Date.now() + 86400000).toISOString(),
          periodEnd: new Date(Date.now() - 86400000).toISOString(),
          currency: 'INR',
        },
      });
      expect(res.statusCode).toBe(400);

      // Verify no settlement record was inserted
      const dbRes = await db.query('SELECT count(*) as count FROM settlements');
      expect(Number((dbRes.rows[0] as { count: string | number }).count)).toBe(0);

      // Verify no settlement item was inserted
      const itemRes = await db.query('SELECT count(*) as count FROM settlement_items');
      expect(Number((itemRes.rows[0] as { count: string | number }).count)).toBe(0);
    });

    it('Case I: terminal settlement states (SETTLED, REJECTED) reject further transitions', async () => {
      const eco = await setupEcosystem();
      const { sellerOrderAlpha } = await createMultiVendorPaidOrder(eco);

      await app.inject({
        method: 'POST',
        url: '/settlement/ingest/order',
        headers: { authorization: `Bearer ${eco.adminToken}` },
        payload: { sellerOrderId: sellerOrderAlpha.id },
      });

      const calcRes = await app.inject({
        method: 'POST',
        url: '/settlement/settlements/calculate',
        headers: { authorization: `Bearer ${eco.adminToken}` },
        payload: {
          merchantId: eco.alphaTenantId,
          periodStart: new Date(Date.now() - 3600000).toISOString(),
          periodEnd: new Date(Date.now() + 3600000).toISOString(),
          currency: 'INR',
        },
      });
      const settlement = calcRes.json();

      // Reject the settlement
      const rejectRes = await app.inject({
        method: 'POST',
        url: `/settlement/settlements/${settlement.id}/transition`,
        headers: { authorization: `Bearer ${eco.adminToken}` },
        payload: { targetStatus: 'REJECTED' },
      });
      expect(rejectRes.statusCode).toBe(200);

      // Attempting to approve an already REJECTED settlement must fail
      const tryApprove = await app.inject({
        method: 'POST',
        url: `/settlement/settlements/${settlement.id}/transition`,
        headers: { authorization: `Bearer ${eco.adminToken}` },
        payload: { targetStatus: 'APPROVED' },
      });
      expect(tryApprove.statusCode).toBe(409); // InvalidStateTransitionError
    });

    it('validates adjustment input bounds and enforces non-negative amount constraint', async () => {
      const eco = await setupEcosystem();

      // Negative amount rejected
      const res1 = await app.inject({
        method: 'POST',
        url: '/settlement/adjustments',
        headers: { authorization: `Bearer ${eco.adminToken}` },
        payload: {
          merchantId: eco.alphaTenantId,
          amount: -25.0,
          currency: 'INR',
          type: 'CREDIT',
          reason: 'Negative test',
        },
      });
      expect(res1.statusCode).toBe(400);

      // Empty reason rejected
      const res2 = await app.inject({
        method: 'POST',
        url: '/settlement/adjustments',
        headers: { authorization: `Bearer ${eco.adminToken}` },
        payload: {
          merchantId: eco.alphaTenantId,
          amount: 25.0,
          currency: 'INR',
          type: 'CREDIT',
          reason: '',
        },
      });
      expect(res2.statusCode).toBe(400);
    });

    it('Case K: concurrent SETTLED requests create exactly one payout ledger entry and one balance debit', async () => {
      const eco = await setupEcosystem();
      const { sellerOrderAlpha } = await createMultiVendorPaidOrder(eco);

      await app.inject({
        method: 'POST',
        url: '/settlement/ingest/order',
        headers: { authorization: `Bearer ${eco.adminToken}` },
        payload: { sellerOrderId: sellerOrderAlpha.id },
      });

      const calcRes = await app.inject({
        method: 'POST',
        url: '/settlement/settlements/calculate',
        headers: { authorization: `Bearer ${eco.adminToken}` },
        payload: {
          merchantId: eco.alphaTenantId,
          periodStart: new Date(Date.now() - 3600000).toISOString(),
          periodEnd: new Date(Date.now() + 3600000).toISOString(),
          currency: 'INR',
        },
      });
      const settlement = calcRes.json();

      // Approve -> PROCESSING
      await app.inject({
        method: 'POST',
        url: `/settlement/settlements/${settlement.id}/transition`,
        headers: { authorization: `Bearer ${eco.adminToken}` },
        payload: { targetStatus: 'APPROVED' },
      });
      await app.inject({
        method: 'POST',
        url: `/settlement/settlements/${settlement.id}/transition`,
        headers: { authorization: `Bearer ${eco.adminToken}` },
        payload: { targetStatus: 'PROCESSING' },
      });

      // Dispatch 2 concurrent transition requests to SETTLED
      const [res1, res2] = await Promise.all([
        app.inject({
          method: 'POST',
          url: `/settlement/settlements/${settlement.id}/transition`,
          headers: { authorization: `Bearer ${eco.adminToken}` },
          payload: { targetStatus: 'SETTLED' },
        }),
        app.inject({
          method: 'POST',
          url: `/settlement/settlements/${settlement.id}/transition`,
          headers: { authorization: `Bearer ${eco.adminToken}` },
          payload: { targetStatus: 'SETTLED' },
        }),
      ]);

      // Both should succeed (one transitions, one idempotently returns existing state)
      expect(res1.statusCode).toBe(200);
      expect(res2.statusCode).toBe(200);

      // Verify that exactly ONE balanced PAYOUT journal (2 entries: merchant DEBIT + platform CREDIT) exists
      const payoutEntries = await db.query<{
        tenant_id: string;
        direction: string;
        amount: string;
        financial_transaction_id: string;
      }>(
        "SELECT * FROM ledger_entries WHERE source_type = 'SETTLEMENT' AND source_id = $1 AND entry_type = 'PAYOUT'",
        [settlement.id],
      );
      expect(payoutEntries.rows.length).toBe(2);
      const merchantEntry = payoutEntries.rows.find((r) => r.tenant_id === eco.alphaTenantId);
      const platformEntry = payoutEntries.rows.find((r) => r.tenant_id !== eco.alphaTenantId);
      expect(merchantEntry).toBeDefined();
      expect(platformEntry).toBeDefined();
      expect(merchantEntry!.direction).toBe('DEBIT');
      expect(platformEntry!.direction).toBe('CREDIT');
      expect(merchantEntry!.financial_transaction_id).toBe(platformEntry!.financial_transaction_id);

      // Verify seller account balances: settled_balance equals net_payable, current_balance is 0
      const summary = await app.inject({
        method: 'GET',
        url: `/settlement/merchants/${eco.alphaTenantId}/summary`,
        headers: { authorization: `Bearer ${eco.adminToken}` },
      });
      const balances = summary.json();
      expect(balances.settledBalance).toBe(settlement.netPayableAmount);
      expect(balances.currentBalance).toBe(0);
    });

    it('Case L: retry of SETTLED transition is idempotent and produces zero duplicate financial mutations', async () => {
      const eco = await setupEcosystem();
      const { sellerOrderAlpha } = await createMultiVendorPaidOrder(eco);

      await app.inject({
        method: 'POST',
        url: '/settlement/ingest/order',
        headers: { authorization: `Bearer ${eco.adminToken}` },
        payload: { sellerOrderId: sellerOrderAlpha.id },
      });

      const calcRes = await app.inject({
        method: 'POST',
        url: '/settlement/settlements/calculate',
        headers: { authorization: `Bearer ${eco.adminToken}` },
        payload: {
          merchantId: eco.alphaTenantId,
          periodStart: new Date(Date.now() - 3600000).toISOString(),
          periodEnd: new Date(Date.now() + 3600000).toISOString(),
          currency: 'INR',
        },
      });
      const settlement = calcRes.json();

      await app.inject({
        method: 'POST',
        url: `/settlement/settlements/${settlement.id}/transition`,
        headers: { authorization: `Bearer ${eco.adminToken}` },
        payload: { targetStatus: 'APPROVED' },
      });
      await app.inject({
        method: 'POST',
        url: `/settlement/settlements/${settlement.id}/transition`,
        headers: { authorization: `Bearer ${eco.adminToken}` },
        payload: { targetStatus: 'PROCESSING' },
      });
      const settledFirst = await app.inject({
        method: 'POST',
        url: `/settlement/settlements/${settlement.id}/transition`,
        headers: { authorization: `Bearer ${eco.adminToken}` },
        payload: { targetStatus: 'SETTLED' },
      });
      expect(settledFirst.statusCode).toBe(200);

      // Retry the SETTLED transition
      const settledRetry = await app.inject({
        method: 'POST',
        url: `/settlement/settlements/${settlement.id}/transition`,
        headers: { authorization: `Bearer ${eco.adminToken}` },
        payload: { targetStatus: 'SETTLED' },
      });
      expect(settledRetry.statusCode).toBe(200);
      expect(settledRetry.json().status).toBe('SETTLED');

      // Zero duplicate entries: exactly 2 entries forming 1 balanced journal
      const payoutEntries = await db.query(
        "SELECT * FROM ledger_entries WHERE source_type = 'SETTLEMENT' AND source_id = $1 AND entry_type = 'PAYOUT'",
        [settlement.id],
      );
      expect(payoutEntries.rows.length).toBe(2);
    });

    it('Case M: different merchants using the same idempotency key string do not collide', async () => {
      const eco = await setupEcosystem();
      const sharedKey = 'common_shared_external_idempotency_key';

      // Admin creates adjustment for Alpha
      const adjAlpha = await app.inject({
        method: 'POST',
        url: '/settlement/adjustments',
        headers: { authorization: `Bearer ${eco.adminToken}` },
        payload: {
          merchantId: eco.alphaTenantId,
          amount: 15.0,
          currency: 'INR',
          type: 'CREDIT',
          reason: 'Alpha promotion support',
          idempotencyKey: sharedKey,
        },
      });
      expect(adjAlpha.statusCode).toBe(201);

      // Admin creates adjustment for Beta with the SAME idempotency key string
      const adjBeta = await app.inject({
        method: 'POST',
        url: '/settlement/adjustments',
        headers: { authorization: `Bearer ${eco.adminToken}` },
        payload: {
          merchantId: eco.betaTenantId,
          amount: 25.0,
          currency: 'INR',
          type: 'CREDIT',
          reason: 'Beta logistics credit',
          idempotencyKey: sharedKey,
        },
      });
      // Must succeed and not collide because idempotency is tenant-scoped
      expect(adjBeta.statusCode).toBe(201);
      expect(adjAlpha.json().adjustment.tenantId).toBe(eco.alphaTenantId);
      expect(adjBeta.json().adjustment.tenantId).toBe(eco.betaTenantId);
    });

    it('proves SettlementRepository has zero update or delete methods on ledger_entries', async () => {
      const repo = new (
        await import('../src/modules/settlement-ledger/internal/settlement-repository.js')
      ).SettlementRepository(db);
      const proto = Object.getOwnPropertyNames(Object.getPrototypeOf(repo));

      const mutationMethods = proto.filter(
        (m) =>
          m.toLowerCase().includes('delete') ||
          (m.toLowerCase().includes('update') && m.toLowerCase().includes('ledger')),
      );

      expect(mutationMethods).toEqual([]);
    });
  });

  describe('Mandatory Phase 8 Double-Entry & Negative Tests (Tests A - L)', () => {
    it('Test A — Order journal balance: SUM(DEBIT) = SUM(CREDIT)', async () => {
      const eco = await setupEcosystem();
      const { sellerOrderAlpha } = await createMultiVendorPaidOrder(eco);

      const ingestRes = await app.inject({
        method: 'POST',
        url: '/settlement/ingest/order',
        headers: { authorization: `Bearer ${eco.adminToken}` },
        payload: { sellerOrderId: sellerOrderAlpha.id, commissionRate: 0.1 },
      });
      expect(ingestRes.statusCode).toBe(201);
      const earningDto = ingestRes.json().earningEntry;

      const entries = await db.query<{ direction: string; amount: string }>(
        `SELECT direction, amount FROM ledger_entries WHERE financial_transaction_id = $1`,
        [earningDto.financialTransactionId],
      );
      expect(entries.rows.length).toBe(2);

      let debitSum = 0;
      let creditSum = 0;
      for (const row of entries.rows) {
        if (row.direction === 'DEBIT') debitSum += Number(row.amount);
        if (row.direction === 'CREDIT') creditSum += Number(row.amount);
      }
      expect(debitSum).toBe(100.0);
      expect(creditSum).toBe(100.0);
      expect(debitSum).toBe(creditSum);
    });

    it('Test B — Commission journal balance: SUM(DEBIT) = SUM(CREDIT)', async () => {
      const eco = await setupEcosystem();
      const { sellerOrderAlpha } = await createMultiVendorPaidOrder(eco);

      const ingestRes = await app.inject({
        method: 'POST',
        url: '/settlement/ingest/order',
        headers: { authorization: `Bearer ${eco.adminToken}` },
        payload: { sellerOrderId: sellerOrderAlpha.id, commissionRate: 0.1 },
      });
      expect(ingestRes.statusCode).toBe(201);
      const commDto = ingestRes.json().commissionEntry;

      const entries = await db.query<{ direction: string; amount: string }>(
        `SELECT direction, amount FROM ledger_entries WHERE financial_transaction_id = $1`,
        [commDto.financialTransactionId],
      );
      expect(entries.rows.length).toBe(2);

      let debitSum = 0;
      let creditSum = 0;
      for (const row of entries.rows) {
        if (row.direction === 'DEBIT') debitSum += Number(row.amount);
        if (row.direction === 'CREDIT') creditSum += Number(row.amount);
      }
      expect(debitSum).toBe(10.0);
      expect(creditSum).toBe(10.0);
      expect(debitSum).toBe(creditSum);
    });

    it('Test C — Fee journal balance: SUM(DEBIT) = SUM(CREDIT)', async () => {
      const eco = await setupEcosystem();
      const { sellerOrderAlpha } = await createMultiVendorPaidOrder(eco);

      const ingestRes = await app.inject({
        method: 'POST',
        url: '/settlement/ingest/order',
        headers: { authorization: `Bearer ${eco.adminToken}` },
        payload: { sellerOrderId: sellerOrderAlpha.id, commissionRate: 0.1, feeAmount: 3.5 },
      });
      expect(ingestRes.statusCode).toBe(201);
      const feeDto = ingestRes.json().feeEntry;
      expect(feeDto).toBeDefined();

      const entries = await db.query<{ direction: string; amount: string }>(
        `SELECT direction, amount FROM ledger_entries WHERE financial_transaction_id = $1`,
        [feeDto.financialTransactionId],
      );
      expect(entries.rows.length).toBe(2);

      let debitSum = 0;
      let creditSum = 0;
      for (const row of entries.rows) {
        if (row.direction === 'DEBIT') debitSum += Number(row.amount);
        if (row.direction === 'CREDIT') creditSum += Number(row.amount);
      }
      expect(debitSum).toBe(3.5);
      expect(creditSum).toBe(3.5);
      expect(debitSum).toBe(creditSum);
    });

    it('Test D — Refund journal balance: SUM(DEBIT) = SUM(CREDIT)', async () => {
      const eco = await setupEcosystem();
      const { sellerOrderAlpha } = await createMultiVendorPaidOrder(eco);

      await app.inject({
        method: 'POST',
        url: '/settlement/ingest/order',
        headers: { authorization: `Bearer ${eco.adminToken}` },
        payload: { sellerOrderId: sellerOrderAlpha.id },
      });

      const refundRes = await app.inject({
        method: 'POST',
        url: '/settlement/ingest/refund',
        headers: { authorization: `Bearer ${eco.adminToken}` },
        payload: {
          merchantId: eco.alphaTenantId,
          refundId: 'ref_mandatory_d',
          sellerOrderId: sellerOrderAlpha.id,
          refundAmount: 40.0,
          currency: 'INR',
        },
      });
      expect(refundRes.statusCode).toBe(201);
      const refundDto = refundRes.json().refundEntry;

      const entries = await db.query<{ direction: string; amount: string }>(
        `SELECT direction, amount FROM ledger_entries WHERE financial_transaction_id = $1`,
        [refundDto.financialTransactionId],
      );
      expect(entries.rows.length).toBe(2);

      let debitSum = 0;
      let creditSum = 0;
      for (const row of entries.rows) {
        if (row.direction === 'DEBIT') debitSum += Number(row.amount);
        if (row.direction === 'CREDIT') creditSum += Number(row.amount);
      }
      expect(debitSum).toBe(40.0);
      expect(creditSum).toBe(40.0);
      expect(debitSum).toBe(creditSum);
    });

    it('Test E — Adjustment journal balance: SUM(DEBIT) = SUM(CREDIT)', async () => {
      const eco = await setupEcosystem();

      const adjRes = await app.inject({
        method: 'POST',
        url: '/settlement/adjustments',
        headers: { authorization: `Bearer ${eco.adminToken}` },
        payload: {
          merchantId: eco.alphaTenantId,
          amount: 55.0,
          currency: 'INR',
          type: 'CREDIT',
          reason: 'Manual goodwill credit',
        },
      });
      expect(adjRes.statusCode).toBe(201);
      const entryDto = adjRes.json().ledgerEntry;

      const entries = await db.query<{ direction: string; amount: string }>(
        `SELECT direction, amount FROM ledger_entries WHERE financial_transaction_id = $1`,
        [entryDto.financialTransactionId],
      );
      expect(entries.rows.length).toBe(2);

      let debitSum = 0;
      let creditSum = 0;
      for (const row of entries.rows) {
        if (row.direction === 'DEBIT') debitSum += Number(row.amount);
        if (row.direction === 'CREDIT') creditSum += Number(row.amount);
      }
      expect(debitSum).toBe(55.0);
      expect(creditSum).toBe(55.0);
      expect(debitSum).toBe(creditSum);
    });

    it('Test F — Payout journal balance: proves merchant payout DEBIT + platform payout CREDIT', async () => {
      const eco = await setupEcosystem();
      const { sellerOrderAlpha } = await createMultiVendorPaidOrder(eco);

      await app.inject({
        method: 'POST',
        url: '/settlement/ingest/order',
        headers: { authorization: `Bearer ${eco.adminToken}` },
        payload: { sellerOrderId: sellerOrderAlpha.id },
      });

      const calcRes = await app.inject({
        method: 'POST',
        url: '/settlement/settlements/calculate',
        headers: { authorization: `Bearer ${eco.adminToken}` },
        payload: {
          merchantId: eco.alphaTenantId,
          periodStart: new Date(Date.now() - 3600000).toISOString(),
          periodEnd: new Date(Date.now() + 3600000).toISOString(),
          currency: 'INR',
        },
      });
      const settlement = calcRes.json();

      await app.inject({
        method: 'POST',
        url: `/settlement/settlements/${settlement.id}/transition`,
        headers: { authorization: `Bearer ${eco.adminToken}` },
        payload: { targetStatus: 'APPROVED' },
      });
      await app.inject({
        method: 'POST',
        url: `/settlement/settlements/${settlement.id}/transition`,
        headers: { authorization: `Bearer ${eco.adminToken}` },
        payload: { targetStatus: 'PROCESSING' },
      });
      const settledRes = await app.inject({
        method: 'POST',
        url: `/settlement/settlements/${settlement.id}/transition`,
        headers: { authorization: `Bearer ${eco.adminToken}` },
        payload: { targetStatus: 'SETTLED' },
      });
      expect(settledRes.statusCode).toBe(200);

      // Directly inspect database rows for payout
      const payoutRows = await db.query<{
        tenant_id: string;
        direction: string;
        amount: string;
        financial_transaction_id: string;
      }>(
        `SELECT tenant_id, direction, amount, financial_transaction_id
         FROM ledger_entries
         WHERE source_type = 'SETTLEMENT' AND source_id = $1`,
        [settlement.id],
      );

      // Must fail if platform offset is missing: exactly 2 rows
      expect(payoutRows.rows.length).toBe(2);

      const merchantRow = payoutRows.rows.find((r) => r.tenant_id === eco.alphaTenantId)!;
      const platformRow = payoutRows.rows.find((r) => r.tenant_id !== eco.alphaTenantId)!;

      expect(merchantRow).toBeDefined();
      expect(platformRow).toBeDefined();

      // Proves: merchant payout DEBIT + platform payout CREDIT
      expect(merchantRow.direction).toBe('DEBIT');
      expect(platformRow.direction).toBe('CREDIT');
      expect(Number(merchantRow.amount)).toBe(settlement.netPayableAmount);
      expect(Number(platformRow.amount)).toBe(settlement.netPayableAmount);
      expect(merchantRow.financial_transaction_id).toBe(platformRow.financial_transaction_id);
    });

    it('Test G — Every journal balance: generic DB assertion SUM(DEBIT) = SUM(CREDIT) for all transactions', async () => {
      const eco = await setupEcosystem();
      const { sellerOrderAlpha } = await createMultiVendorPaidOrder(eco);

      // Run multiple diverse financial operations: order, refund, adjustment
      await app.inject({
        method: 'POST',
        url: '/settlement/ingest/order',
        headers: { authorization: `Bearer ${eco.adminToken}` },
        payload: { sellerOrderId: sellerOrderAlpha.id, commissionRate: 0.1, feeAmount: 2.0 },
      });

      await app.inject({
        method: 'POST',
        url: '/settlement/ingest/refund',
        headers: { authorization: `Bearer ${eco.adminToken}` },
        payload: {
          merchantId: eco.alphaTenantId,
          refundId: 'ref_test_g',
          sellerOrderId: sellerOrderAlpha.id,
          refundAmount: 20.0,
          commissionRefundAmount: 2.0,
          currency: 'INR',
        },
      });

      await app.inject({
        method: 'POST',
        url: '/settlement/adjustments',
        headers: { authorization: `Bearer ${eco.adminToken}` },
        payload: {
          merchantId: eco.alphaTenantId,
          amount: 10.0,
          currency: 'INR',
          type: 'CREDIT',
          reason: 'Test G Adjustment',
        },
      });

      // Generic database assertion over all financial transactions in the DB
      const result = await db.query<{
        financial_transaction_id: string;
        sum_debit: string;
        sum_credit: string;
        entry_count: string;
      }>(
        `SELECT
           financial_transaction_id,
           COUNT(*) as entry_count,
           SUM(CASE WHEN direction = 'DEBIT' THEN amount ELSE 0 END) AS sum_debit,
           SUM(CASE WHEN direction = 'CREDIT' THEN amount ELSE 0 END) AS sum_credit
         FROM ledger_entries
         WHERE financial_transaction_id IS NOT NULL
         GROUP BY financial_transaction_id`,
      );

      expect(result.rows.length).toBeGreaterThan(0);
      for (const row of result.rows) {
        expect(Number(row.entry_count)).toBeGreaterThanOrEqual(2);
        const sumDebit = Math.round((Number(row.sum_debit) + Number.EPSILON) * 100) / 100;
        const sumCredit = Math.round((Number(row.sum_credit) + Number.EPSILON) * 100) / 100;
        expect(sumDebit).toBe(sumCredit);
      }
    });

    it('Test H — Cross-currency journal rejection: USD DEBIT with EUR CREDIT must be rejected', async () => {
      const eco = await setupEcosystem();

      const accountA = await db.query<{ id: string }>(
        `SELECT id FROM financial_accounts WHERE tenant_id = $1 LIMIT 1`,
        [eco.alphaTenantId],
      );

      const service = new SettlementService(
        db,
        app.log as unknown as Logger,
        {} as unknown as OrderService,
        {} as unknown as PaymentService,
      );

      const postPromise = service.postJournal({
        tenantId: eco.alphaTenantId,
        transactionType: 'ORDER_EARNING',
        sourceType: 'TEST',
        sourceId: 'test_cross_curr',
        currency: 'USD',
        entries: [
          {
            tenantId: eco.alphaTenantId,
            accountId: accountA.rows[0]?.id ?? 'acc-test-1',
            entryType: 'EARNING',
            direction: 'DEBIT',
            amount: 100,
            currency: 'USD',
            description: 'USD side',
          },
          {
            tenantId: eco.alphaTenantId,
            accountId: accountA.rows[0]?.id ?? 'acc-test-2',
            entryType: 'CLEARING',
            direction: 'CREDIT',
            amount: 100,
            currency: 'EUR', // Cross-currency violation!
            description: 'EUR side',
          },
        ],
      });

      await expect(postPromise).rejects.toThrow(/cross-currency/i);

      // Verify zero transactions created for this test source
      const txCheck = await db.query(
        `SELECT * FROM financial_transactions WHERE source_id = 'test_cross_curr'`,
      );
      expect(txCheck.rows.length).toBe(0);
    });

    it('Test I — Duplicate payout: submitting the same payout twice creates exactly one financial transaction', async () => {
      const eco = await setupEcosystem();
      const { sellerOrderAlpha } = await createMultiVendorPaidOrder(eco);

      await app.inject({
        method: 'POST',
        url: '/settlement/ingest/order',
        headers: { authorization: `Bearer ${eco.adminToken}` },
        payload: { sellerOrderId: sellerOrderAlpha.id },
      });

      const calcRes = await app.inject({
        method: 'POST',
        url: '/settlement/settlements/calculate',
        headers: { authorization: `Bearer ${eco.adminToken}` },
        payload: {
          merchantId: eco.alphaTenantId,
          periodStart: new Date(Date.now() - 3600000).toISOString(),
          periodEnd: new Date(Date.now() + 3600000).toISOString(),
          currency: 'INR',
        },
      });
      const settlement = calcRes.json();

      await app.inject({
        method: 'POST',
        url: `/settlement/settlements/${settlement.id}/transition`,
        headers: { authorization: `Bearer ${eco.adminToken}` },
        payload: { targetStatus: 'APPROVED' },
      });
      await app.inject({
        method: 'POST',
        url: `/settlement/settlements/${settlement.id}/transition`,
        headers: { authorization: `Bearer ${eco.adminToken}` },
        payload: { targetStatus: 'PROCESSING' },
      });

      // Submit payout transition 1
      const res1 = await app.inject({
        method: 'POST',
        url: `/settlement/settlements/${settlement.id}/transition`,
        headers: { authorization: `Bearer ${eco.adminToken}` },
        payload: { targetStatus: 'SETTLED' },
      });
      expect(res1.statusCode).toBe(200);

      // Submit payout transition 2 (duplicate)
      const res2 = await app.inject({
        method: 'POST',
        url: `/settlement/settlements/${settlement.id}/transition`,
        headers: { authorization: `Bearer ${eco.adminToken}` },
        payload: { targetStatus: 'SETTLED' },
      });
      expect(res2.statusCode).toBe(200);

      // Assert exactly ONE financial transaction in the database
      const txRows = await db.query(
        `SELECT * FROM financial_transactions WHERE source_type = 'SETTLEMENT' AND source_id = $1`,
        [settlement.id],
      );
      expect(txRows.rows.length).toBe(1);

      // Assert exactly 2 ledger entries (1 balanced journal)
      const entryRows = await db.query(
        `SELECT * FROM ledger_entries WHERE source_type = 'SETTLEMENT' AND source_id = $1`,
        [settlement.id],
      );
      expect(entryRows.rows.length).toBe(2);
    });

    it('Test J — Concurrent payout: concurrent SETTLED requests result in exactly one payout journal', async () => {
      const eco = await setupEcosystem();
      const { sellerOrderAlpha } = await createMultiVendorPaidOrder(eco);

      await app.inject({
        method: 'POST',
        url: '/settlement/ingest/order',
        headers: { authorization: `Bearer ${eco.adminToken}` },
        payload: { sellerOrderId: sellerOrderAlpha.id },
      });

      const calcRes = await app.inject({
        method: 'POST',
        url: '/settlement/settlements/calculate',
        headers: { authorization: `Bearer ${eco.adminToken}` },
        payload: {
          merchantId: eco.alphaTenantId,
          periodStart: new Date(Date.now() - 3600000).toISOString(),
          periodEnd: new Date(Date.now() + 3600000).toISOString(),
          currency: 'INR',
        },
      });
      const settlement = calcRes.json();

      await app.inject({
        method: 'POST',
        url: `/settlement/settlements/${settlement.id}/transition`,
        headers: { authorization: `Bearer ${eco.adminToken}` },
        payload: { targetStatus: 'APPROVED' },
      });
      await app.inject({
        method: 'POST',
        url: `/settlement/settlements/${settlement.id}/transition`,
        headers: { authorization: `Bearer ${eco.adminToken}` },
        payload: { targetStatus: 'PROCESSING' },
      });

      // Fire 3 concurrent settlement transition requests
      const [r1, r2, r3] = await Promise.all([
        app.inject({
          method: 'POST',
          url: `/settlement/settlements/${settlement.id}/transition`,
          headers: { authorization: `Bearer ${eco.adminToken}` },
          payload: { targetStatus: 'SETTLED' },
        }),
        app.inject({
          method: 'POST',
          url: `/settlement/settlements/${settlement.id}/transition`,
          headers: { authorization: `Bearer ${eco.adminToken}` },
          payload: { targetStatus: 'SETTLED' },
        }),
        app.inject({
          method: 'POST',
          url: `/settlement/settlements/${settlement.id}/transition`,
          headers: { authorization: `Bearer ${eco.adminToken}` },
          payload: { targetStatus: 'SETTLED' },
        }),
      ]);

      expect(r1.statusCode).toBe(200);
      expect(r2.statusCode).toBe(200);
      expect(r3.statusCode).toBe(200);

      // Assert exactly one financial transaction in DB
      const txRows = await db.query(
        `SELECT * FROM financial_transactions WHERE source_type = 'SETTLEMENT' AND source_id = $1`,
        [settlement.id],
      );
      expect(txRows.rows.length).toBe(1);

      // Assert exactly 2 ledger entries in DB
      const entryRows = await db.query(
        `SELECT * FROM ledger_entries WHERE source_type = 'SETTLEMENT' AND source_id = $1`,
        [settlement.id],
      );
      expect(entryRows.rows.length).toBe(2);
    });

    it('Test K — Cumulative refund overflow: rejects refunds exceeding refundable amount with no partial journal', async () => {
      const eco = await setupEcosystem();
      const { sellerOrderAlpha } = await createMultiVendorPaidOrder(eco);

      // Order total is 100.00 INR
      await app.inject({
        method: 'POST',
        url: '/settlement/ingest/order',
        headers: { authorization: `Bearer ${eco.adminToken}` },
        payload: { sellerOrderId: sellerOrderAlpha.id },
      });

      // Refund 1: 60.00 INR -> Must succeed
      const ref1 = await app.inject({
        method: 'POST',
        url: '/settlement/ingest/refund',
        headers: { authorization: `Bearer ${eco.adminToken}` },
        payload: {
          merchantId: eco.alphaTenantId,
          refundId: 'ref_overflow_1',
          sellerOrderId: sellerOrderAlpha.id,
          refundAmount: 60.0,
          currency: 'INR',
        },
      });
      expect(ref1.statusCode).toBe(201);

      // Refund 2: 50.00 INR (Cumulative 110.00 > 100.00) -> Must fail
      const ref2 = await app.inject({
        method: 'POST',
        url: '/settlement/ingest/refund',
        headers: { authorization: `Bearer ${eco.adminToken}` },
        payload: {
          merchantId: eco.alphaTenantId,
          refundId: 'ref_overflow_2',
          sellerOrderId: sellerOrderAlpha.id,
          refundAmount: 50.0,
          currency: 'INR',
        },
      });
      expect(ref2.statusCode).toBe(400);
      expect(ref2.json().error.message).toMatch(/exceeds original refundable amount/i);

      // Assert zero ledger entries or transactions for the failed refund
      const failedEntries = await db.query(
        `SELECT * FROM ledger_entries WHERE source_id = 'ref_overflow_2'`,
      );
      expect(failedEntries.rows.length).toBe(0);

      const failedTx = await db.query(
        `SELECT * FROM financial_transactions WHERE source_id = 'ref_overflow_2'`,
      );
      expect(failedTx.rows.length).toBe(0);
    });

    it('Test L — Rollback: failure after journal construction but before commit leaves zero rows and mutations', async () => {
      const eco = await setupEcosystem();
      const { sellerOrderAlpha } = await createMultiVendorPaidOrder(eco);

      await app.inject({
        method: 'POST',
        url: '/settlement/ingest/order',
        headers: { authorization: `Bearer ${eco.adminToken}` },
        payload: { sellerOrderId: sellerOrderAlpha.id },
      });

      const accountRes = await db.query<{ id: string; current_balance: string }>(
        `SELECT id, current_balance FROM financial_accounts WHERE tenant_id = $1 AND account_type = 'MERCHANT_BALANCE' LIMIT 1`,
        [eco.alphaTenantId],
      );
      expect(accountRes.rows.length).toBeGreaterThan(0);
      const initialBalance = Number(accountRes.rows[0]?.current_balance ?? 0);

      const service = new SettlementService(
        db,
        app.log as unknown as Logger,
        {} as unknown as OrderService,
        {} as unknown as PaymentService,
      );

      // Force failure during journal construction before commit (unbalanced journal)
      const errorPromise = service.postJournal({
        tenantId: eco.alphaTenantId,
        transactionType: 'ADJUSTMENT',
        sourceType: 'TEST_ROLLBACK',
        sourceId: 'src_rollback_fail',
        currency: 'INR',
        entries: [
          {
            tenantId: eco.alphaTenantId,
            accountId: accountRes.rows[0]!.id,
            entryType: 'ADJUSTMENT',
            direction: 'CREDIT',
            amount: 100,
            currency: 'INR',
            description: 'Rollback test side A',
          },
          {
            tenantId: eco.alphaTenantId,
            accountId: accountRes.rows[0]!.id,
            entryType: 'ADJUSTMENT',
            direction: 'DEBIT',
            amount: 50, // Unbalanced: 100 !== 50!
            currency: 'INR',
            description: 'Rollback test side B',
          },
        ],
      });

      await expect(errorPromise).rejects.toThrow(/unbalanced journal/i);

      // Assert zero ledger entries created
      const entries = await db.query(
        `SELECT * FROM ledger_entries WHERE source_id = 'src_rollback_fail'`,
      );
      expect(entries.rows.length).toBe(0);

      // Assert zero financial transactions created
      const txRows = await db.query(
        `SELECT * FROM financial_transactions WHERE source_id = 'src_rollback_fail'`,
      );
      expect(txRows.rows.length).toBe(0);

      // Assert balance has not mutated
      const afterRes = await db.query<{ current_balance: string }>(
        `SELECT current_balance FROM financial_accounts WHERE id = $1`,
        [accountRes.rows[0]!.id],
      );
      expect(Number(afterRes.rows[0]?.current_balance ?? 0)).toBe(initialBalance);
    });
  });
});
