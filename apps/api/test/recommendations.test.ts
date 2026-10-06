import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { parseConfig } from '../src/config/index.js';
import { createMigratedTestDatabase, markAllUsersVerified, registerVerifiedUser } from './helpers/test-db.js';
import type { DatabaseConnection } from '../src/infra/database/connection.js';
import { JsonLogger } from '../src/observability/logger.js';
import {
  InMemoryEventTransport,
  OutboxRepository,
  createDomainEvent,
  EventTypes,
} from '../src/modules/events/index.js';
import { InMemorySearchStore } from '../src/modules/search/index.js';
import {
  RecommendationService,
  DeterministicRuleBasedRanker,
  SqlRecommendationStore,
  RecommendationEventConsumer,
  type IRecommendationRanker,
  type RecommendationCandidate,
  type RecommendationContext,
  type RankedRecommendation,
} from '../src/modules/recommendations/index.js';
import { CatalogService } from '../src/modules/catalog/index.js';
import { ListingService } from '../src/modules/marketplace/index.js';
import { MerchantService } from '../src/modules/merchant/index.js';
import { AnalyticsService, AnalyticsRepository } from '../src/modules/analytics/index.js';

const TOKEN_SECRET = 'test-token-secret-must-be-at-least-32-characters-long!';

describe('Phase 12: Recommendations Bounded Context & Architecture', () => {
  let app: FastifyInstance;
  let db: DatabaseConnection;
  let transport: InMemoryEventTransport;
  let logger: JsonLogger;
  let outboxRepo: OutboxRepository;
  let searchStore: InMemorySearchStore;
  let catalogService: CatalogService;
  let merchantService: MerchantService;
  let listingService: ListingService;
  let analyticsService: AnalyticsService;
  let recommendationStore: SqlRecommendationStore;
  let recommendationService: RecommendationService;
  let recommendationConsumer: RecommendationEventConsumer;

  beforeEach(async () => {
    db = await createMigratedTestDatabase();
    searchStore = new InMemorySearchStore();
    transport = new InMemoryEventTransport();
    logger = new JsonLogger({ serviceName: 'test-recommendations', level: 'fatal' });

    catalogService = new CatalogService(db, logger);
    merchantService = new MerchantService(db, logger);
    listingService = new ListingService(db, logger, catalogService, merchantService);
    analyticsService = new AnalyticsService(db, logger, new AnalyticsRepository());
    recommendationStore = new SqlRecommendationStore(db);
    recommendationService = new RecommendationService({
      logger,
      catalogService,
      listingService,
      analyticsReader: analyticsService,
      store: recommendationStore,
    });

    outboxRepo = new OutboxRepository();
    recommendationConsumer = new RecommendationEventConsumer(
      db,
      outboxRepo,
      transport,
      logger,
      recommendationService,
    );
    recommendationConsumer.registerSubscriptions();

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
      searchStore,
      eventTransport: transport,
      skipMigrations: true,
    });
    await app.ready();
  });

  afterEach(async () => {
    if (app) await app.close();
    if (db) await db.close();
  });

  async function getAdminToken() {
    await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: {
        email: 'admin@platform.com',
        password: 'Password123!',
        tenantName: 'Platform Tenant',
        role: 'MERCHANT',
      },
    });

    const userRes = await db.query<{ id: string }>(`SELECT id FROM users WHERE email = $1`, [
      'admin@platform.com',
    ]);
    const userId = userRes.rows[0]!.id;
    await db.query(`UPDATE tenant_memberships SET role = 'ADMINISTRATOR' WHERE user_id = $1`, [
      userId,
    ]);
    await markAllUsersVerified(db);
    const memberRes = await db.query<{ tenant_id: string }>(
      `SELECT tenant_id FROM tenant_memberships WHERE user_id = $1`,
      [userId],
    );
    const tenantId = memberRes.rows[0]!.tenant_id;

    const adminLogin = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'admin@platform.com', password: 'Password123!' },
    });
    return { token: adminLogin.json().accessToken, tenantId, userId };
  }

  async function getCustomerToken(email = 'buyer@customer.com', tenantName = 'Customer Tenant') {
    const token = await registerVerifiedUser(app, db, {
      email,
      password: 'Password123!',
      tenantName,
      role: 'CUSTOMER',
    });
    const userRes = await db.query<{ id: string }>(`SELECT id FROM users WHERE email = $1`, [email]);
    const userId = userRes.rows[0]!.id;
    const memberRes = await db.query<{ tenant_id: string }>(
      `SELECT tenant_id FROM tenant_memberships WHERE user_id = $1`,
      [userId],
    );
    const tenantId = memberRes.rows[0]!.tenant_id;
    return { token, tenantId, userId };
  }

  async function seedCatalogAndListings(tenantId: string) {
    // 1. Categories
    await db.query(`
      INSERT INTO categories (id, name, slug)
      VALUES
        ('cat-phones', 'Smartphones', 'smartphones'),
        ('cat-audio', 'Audio & Headphones', 'audio-headphones')
      ON CONFLICT (slug) DO NOTHING;
    `);

    // 2. Canonical Products
    await db.query(`
      INSERT INTO products (id, title, slug, brand, category_id, status)
      VALUES
        ('prod-1', 'Nexus Smartphone Pro', 'nexus-pro', 'NexusBrand', 'cat-phones', 'ACTIVE'),
        ('prod-2', 'Nexus Smartphone Standard', 'nexus-standard', 'NexusBrand', 'cat-phones', 'ACTIVE'),
        ('prod-3', 'Aura Wireless Headphones', 'aura-headphones', 'AuraBrand', 'cat-audio', 'ACTIVE'),
        ('prod-4', 'Nexus Wireless Earbuds', 'nexus-earbuds', 'NexusBrand', 'cat-audio', 'ACTIVE'),
        ('prod-inactive', 'Legacy Inactive Phone', 'legacy-phone', 'OldBrand', 'cat-phones', 'INACTIVE')
      ON CONFLICT (slug) DO NOTHING;
    `);

    // 3. SKUs
    await db.query(`
      INSERT INTO product_skus (id, product_id, sku_code, status)
      VALUES
        ('sku-1', 'prod-1', 'NEX-PRO-128', 'ACTIVE'),
        ('sku-2', 'prod-2', 'NEX-STD-64', 'ACTIVE'),
        ('sku-3', 'prod-3', 'AURA-HEAD-BLK', 'ACTIVE'),
        ('sku-4', 'prod-4', 'NEX-EAR-WHT', 'ACTIVE')
      ON CONFLICT (sku_code) DO NOTHING;
    `);

    // 4. Merchant Listings
    await db.query(`
      INSERT INTO merchant_listings (id, tenant_id, sku_id, price_amount, currency, status)
      VALUES
        ('list-1', $1, 'sku-1', 49999, 'INR', 'ACTIVE'),
        ('list-2', $1, 'sku-2', 29999, 'INR', 'ACTIVE'),
        ('list-3', $1, 'sku-3', 9999, 'INR', 'ACTIVE'),
        ('list-4', $1, 'sku-4', 4999, 'INR', 'ACTIVE')
      ON CONFLICT (tenant_id, sku_id) DO NOTHING;
    `, [tenantId]);
  }

  // =========================================================================
  // 1. CANDIDATE GENERATION & RANKING
  // =========================================================================
  describe('Candidate Generation & Deterministic Ranking', () => {
    it('generates trending recommendations from historical analytics order facts', async () => {
      const { token, tenantId } = await getCustomerToken();
      await seedCatalogAndListings(tenantId);

      // Seed analytics facts: prod-1 has 15 units sold, prod-2 has 5 units sold
      await db.query(`
        INSERT INTO analytics_order_facts (
          fact_id, event_id, tenant_id, order_id, customer_id, product_id,
          sku, quantity, unit_price, total_amount, currency, order_status,
          ordered_at, occurred_at
        ) VALUES
          ('fact-1', 'evt-1', $1, 'ord-1', 'cust-x', 'prod-1', 'sku-1', 10, 49999, 499990, 'INR', 'COMPLETED', NOW(), NOW()),
          ('fact-2', 'evt-2', $1, 'ord-2', 'cust-y', 'prod-1', 'sku-1', 5, 49999, 249995, 'INR', 'COMPLETED', NOW(), NOW()),
          ('fact-3', 'evt-3', $1, 'ord-3', 'cust-z', 'prod-2', 'sku-2', 5, 29999, 149995, 'INR', 'COMPLETED', NOW(), NOW());
      `, [tenantId]);

      const res = await app.inject({
        method: 'GET',
        url: '/recommendations/trending',
        headers: { authorization: `Bearer ${token}` },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.recommendationType).toBe('TRENDING');
      expect(body.items.length).toBeGreaterThanOrEqual(2);
      expect(body.items[0].productId).toBe('prod-1');
      expect(body.items[0].reasonCode).toBe('TRENDING');
      expect(body.items[0].score).toBeGreaterThan(body.items[1].score);
    });

    it('generates similar products matching category and brand deterministically', async () => {
      const { token, tenantId } = await getCustomerToken();
      await seedCatalogAndListings(tenantId);

      const res = await app.inject({
        method: 'GET',
        url: '/recommendations/similar/prod-1',
        headers: { authorization: `Bearer ${token}` },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.recommendationType).toBe('SIMILAR');
      expect(body.sourceProductId).toBe('prod-1');

      // prod-2 has same category and brand as prod-1 -> top candidate
      expect(body.items[0].productId).toBe('prod-2');
      expect(body.items[0].reasonCode).toMatch(/SIMILAR_PRODUCT|CATEGORY_MATCH/);
      expect(body.items.find((i: { productId: string }) => i.productId === 'prod-1')).toBeUndefined();
    });

    it('generates frequently bought together recommendations from order co-occurrences', async () => {
      const { token, tenantId } = await getCustomerToken();
      await seedCatalogAndListings(tenantId);

      // Seed co-occurrences: prod-1 and prod-4 bought together in ord-1 and ord-2
      await db.query(`
        INSERT INTO analytics_order_facts (
          fact_id, event_id, tenant_id, order_id, customer_id, product_id,
          sku, quantity, unit_price, total_amount, currency, order_status,
          ordered_at, occurred_at
        ) VALUES
          ('fact-10', 'evt-10', $1, 'ord-combo-1', 'c-1', 'prod-1', 'sku-1', 1, 49999, 49999, 'INR', 'COMPLETED', NOW(), NOW()),
          ('fact-11', 'evt-11', $1, 'ord-combo-1', 'c-1', 'prod-4', 'sku-4', 1, 4999, 4999, 'INR', 'COMPLETED', NOW(), NOW()),
          ('fact-12', 'evt-12', $1, 'ord-combo-2', 'c-2', 'prod-1', 'sku-1', 1, 49999, 49999, 'INR', 'COMPLETED', NOW(), NOW()),
          ('fact-13', 'evt-13', $1, 'ord-combo-2', 'c-2', 'prod-4', 'sku-4', 1, 4999, 4999, 'INR', 'COMPLETED', NOW(), NOW());
      `, [tenantId]);

      const res = await app.inject({
        method: 'GET',
        url: '/recommendations/frequently-bought-together/prod-1',
        headers: { authorization: `Bearer ${token}` },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.recommendationType).toBe('FREQUENTLY_BOUGHT_TOGETHER');
      expect(body.items.length).toBeGreaterThanOrEqual(1);
      expect(body.items[0].productId).toBe('prod-4');
      expect(body.items[0].reasonCode).toBe('FREQUENTLY_BOUGHT_TOGETHER');
    });

    it('generates personalized recommendations using customer purchase history', async () => {
      const { token, tenantId, userId } = await getCustomerToken('regular@customer.com');
      await seedCatalogAndListings(tenantId);

      // Customer previously bought audio product prod-3
      await db.query(`
        INSERT INTO analytics_order_facts (
          fact_id, event_id, tenant_id, order_id, customer_id, product_id,
          sku, quantity, unit_price, total_amount, currency, order_status,
          ordered_at, occurred_at
        ) VALUES (
          'fact-pers-1', 'evt-pers-1', $1, 'ord-p1', $2, 'prod-3', 'sku-3', 1, 9999, 9999, 'INR', 'COMPLETED', NOW(), NOW()
        );
      `, [tenantId, userId]);

      const res = await app.inject({
        method: 'GET',
        url: '/recommendations/personalized',
        headers: { authorization: `Bearer ${token}` },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.recommendationType).toBe('PERSONALIZED');
      expect(body.items.length).toBeGreaterThan(0);
      // prod-4 is in category 'cat-audio' and brand 'NexusBrand' -> candidate for customer interested in audio
      expect(body.metadata.coldStartApplied).toBe(false);
    });

    it('enforces deterministic tie-breaking: identical score sorted by product ID ascending', async () => {
      const ranker = new DeterministicRuleBasedRanker();
      const candidates: RecommendationCandidate[] = [
        {
          productId: 'prod-z',
          baseScore: 50.0,
          reasonCode: 'TRENDING',
          explanation: 'Tied item Z',
        },
        {
          productId: 'prod-a',
          baseScore: 50.0,
          reasonCode: 'TRENDING',
          explanation: 'Tied item A',
        },
        {
          productId: 'prod-m',
          baseScore: 50.0,
          reasonCode: 'TRENDING',
          explanation: 'Tied item M',
        },
      ];

      const ranked = await ranker.rank(candidates, { tenantId: 't-test', limit: 10 });
      expect(ranked.length).toBe(3);
      expect(ranked[0]!.productId).toBe('prod-a');
      expect(ranked[1]!.productId).toBe('prod-m');
      expect(ranked[2]!.productId).toBe('prod-z');
      expect(ranked[0]!.rankPosition).toBe(1);
      expect(ranked[1]!.rankPosition).toBe(2);
      expect(ranked[2]!.rankPosition).toBe(3);
    });
  });

  // =========================================================================
  // 2. COLD START BEHAVIOR
  // =========================================================================
  describe('Cold-Start Strategy & Deterministic Fallbacks', () => {
    it('applies cold-start fallback when customer has zero purchase history', async () => {
      const { token, tenantId } = await getCustomerToken('newuser@customer.com');
      await seedCatalogAndListings(tenantId);

      const res = await app.inject({
        method: 'GET',
        url: '/recommendations/personalized',
        headers: { authorization: `Bearer ${token}` },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.recommendationType).toBe('PERSONALIZED');
      expect(body.metadata.coldStartApplied).toBe(true);
      expect(body.items.length).toBeGreaterThan(0);
      // Fallback items are deterministically provided from active catalog
      expect(body.items[0].isAvailable).toBe(true);
    });

    it('applies deterministic fallback when product has no co-purchases or similarity', async () => {
      const { token, tenantId } = await getCustomerToken();
      await seedCatalogAndListings(tenantId);

      // Add a standalone product in a brand new isolated category
      await db.query(`
        INSERT INTO categories (id, name, slug) VALUES ('cat-isolated', 'Isolated Category', 'cat-isolated')
        ON CONFLICT (slug) DO NOTHING;
      `);
      await db.query(`
        INSERT INTO products (id, title, slug, brand, category_id, status)
        VALUES ('prod-isolated', 'Unique Item', 'unique-item', 'SoloBrand', 'cat-isolated', 'ACTIVE')
        ON CONFLICT (slug) DO NOTHING;
      `);

      const res = await app.inject({
        method: 'GET',
        url: '/recommendations/frequently-bought-together/prod-isolated',
        headers: { authorization: `Bearer ${token}` },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.recommendationType).toBe('FREQUENTLY_BOUGHT_TOGETHER');
      expect(body.metadata.coldStartApplied).toBe(true);
      // Does not contain itself
      expect(body.items.find((i: { productId: string }) => i.productId === 'prod-isolated')).toBeUndefined();
    });

    it('returns a safe empty result when catalog has no active items', async () => {
      const { token } = await getCustomerToken('empty@customer.com');
      // Do not seed any catalog products

      const res = await app.inject({
        method: 'GET',
        url: '/recommendations/trending',
        headers: { authorization: `Bearer ${token}` },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.items).toEqual([]);
      expect(body.metadata.count).toBe(0);
    });
  });

  // =========================================================================
  // 3. MULTI-VENDOR MODEL & DERIVED PRICING
  // =========================================================================
  describe('Multi-Vendor Integrity & Non-Authoritative Derived Data', () => {
    it('preserves canonical product as recommended entity with distinct seller offers', async () => {
      const { token, tenantId } = await getCustomerToken();
      await seedCatalogAndListings(tenantId);

      // Register second merchant offering the same SKU
      await db.query(`
        INSERT INTO tenants (id, type, name, status) VALUES ('merchant-beta', 'MERCHANT', 'Beta Stores', 'ACTIVE')
        ON CONFLICT (id) DO NOTHING;
      `);
      await db.query(`
        INSERT INTO merchant_listings (id, tenant_id, sku_id, price_amount, currency, status)
        VALUES ('list-beta-1', 'merchant-beta', 'sku-1', 47999, 'INR', 'ACTIVE')
        ON CONFLICT (id) DO NOTHING;
      `);

      const res = await app.inject({
        method: 'GET',
        url: '/recommendations/trending',
        headers: { authorization: `Bearer ${token}` },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      const prod1Rec = body.items.find((i: { productId: string }) => i.productId === 'prod-1');

      expect(prod1Rec).toBeDefined();
      // Canonical product is not duplicated
      const prod1Matches = body.items.filter((i: { productId: string }) => i.productId === 'prod-1');
      expect(prod1Matches.length).toBe(1);

      // Has 2 distinct seller offers
      expect(prod1Rec.activeOffers.length).toBe(2);
      expect(prod1Rec.activeOffers.map((o: { tenantId: string }) => o.tenantId)).toContain(tenantId);
      expect(prod1Rec.activeOffers.map((o: { tenantId: string }) => o.tenantId)).toContain('merchant-beta');
    });

    it('excludes inactive seller listings from active offers', async () => {
      const { token, tenantId } = await getCustomerToken();
      await seedCatalogAndListings(tenantId);

      // Deactivate list-1
      await db.query(`UPDATE merchant_listings SET status = 'INACTIVE' WHERE id = 'list-1'`);

      const res = await app.inject({
        method: 'GET',
        url: '/recommendations/similar/prod-2',
        headers: { authorization: `Bearer ${token}` },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      const prod1Rec = body.items.find((i: { productId: string }) => i.productId === 'prod-1');
      if (prod1Rec) {
        expect(prod1Rec.activeOffers.length).toBe(0);
        expect(prod1Rec.isAvailable).toBe(false);
      }
    });

    it('excludes inactive/draft canonical products from recommendations', async () => {
      const { token, tenantId } = await getCustomerToken();
      await seedCatalogAndListings(tenantId);

      const res = await app.inject({
        method: 'GET',
        url: '/recommendations/trending',
        headers: { authorization: `Bearer ${token}` },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      // 'prod-inactive' is INACTIVE and must be strictly excluded
      const inactive = body.items.find((i: { productId: string }) => i.productId === 'prod-inactive');
      expect(inactive).toBeUndefined();
    });
  });

  // =========================================================================
  // 4. PRIVACY & TENANT ISOLATION
  // =========================================================================
  describe('Privacy & Tenant Isolation', () => {
    it('prevents Customer A from accessing Customer B recommendations', async () => {
      const customerA = await getCustomerToken('alice@customer.com', 'Tenant Alpha');
      const customerB = await getCustomerToken('bob@customer.com', 'Tenant Beta');

      // Calling /recommendations/personalized automatically derives customer identity from token
      const resA = await app.inject({
        method: 'GET',
        url: '/recommendations/personalized',
        headers: { authorization: `Bearer ${customerA.token}` },
      });

      const resB = await app.inject({
        method: 'GET',
        url: '/recommendations/personalized',
        headers: { authorization: `Bearer ${customerB.token}` },
      });

      expect(resA.statusCode).toBe(200);
      expect(resB.statusCode).toBe(200);
      expect(resA.json().customerId).toBe(customerA.userId);
      expect(resB.json().customerId).toBe(customerB.userId);
      expect(resA.json().tenantId).toBe(customerA.tenantId);
      expect(resB.json().tenantId).toBe(customerB.tenantId);
    });

    it('enforces tenant isolation across trending and similar recommendations', async () => {
      const tenant1 = await getCustomerToken('t1@customer.com', 'Tenant One');
      const tenant2 = await getCustomerToken('t2@customer.com', 'Tenant Two');

      await seedCatalogAndListings(tenant1.tenantId);

      // Seed order facts only in tenant 1
      await db.query(`
        INSERT INTO analytics_order_facts (
          fact_id, event_id, tenant_id, order_id, customer_id, product_id,
          sku, quantity, unit_price, total_amount, currency, order_status,
          ordered_at, occurred_at
        ) VALUES (
          'f-t1', 'evt-t1', $1, 'ord-t1', 'c-1', 'prod-1', 'sku-1', 100, 49999, 4999900, 'INR', 'COMPLETED', NOW(), NOW()
        );
      `, [tenant1.tenantId]);

      const res1 = await app.inject({
        method: 'GET',
        url: '/recommendations/trending',
        headers: { authorization: `Bearer ${tenant1.token}` },
      });

      const res2 = await app.inject({
        method: 'GET',
        url: '/recommendations/trending',
        headers: { authorization: `Bearer ${tenant2.token}` },
      });

      expect(res1.statusCode).toBe(200);
      expect(res2.statusCode).toBe(200);
      // Tenant 1 has trending item with high score
      expect(res1.json().items[0].productId).toBe('prod-1');
      // Tenant 2 has no orders in their tenant, so prod-1 is not boosted by tenant 1's sales
      expect(res1.json().tenantId).toBe(tenant1.tenantId);
      expect(res2.json().tenantId).toBe(tenant2.tenantId);
    });
  });

  // =========================================================================
  // 5. EVENT-DRIVEN INVALIDATION & IDEMPOTENCY
  // =========================================================================
  describe('Event-Driven Invalidation & Consumer Idempotency', () => {
    it('invalidates recommendations when product is archived via catalog event', async () => {
      const { tenantId } = await getCustomerToken();
      await seedCatalogAndListings(tenantId);

      // Pre-populate derived recommendations
      await recommendationStore.saveRecommendations([
        {
          id: 'rec-test-1',
          scopeKey: `${tenantId}:TRENDING:NONE:NONE:prod-1`,
          tenantId,
          recommendationType: 'TRENDING',
          recommendedProductId: 'prod-1',
          rankPosition: 1,
          score: 80.0,
          reasonCode: 'TRENDING',
          explanation: 'Popular item',
          derivedMetadata: {},
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ]);

      const preCheck = await recommendationStore.getRecommendations(tenantId, 'TRENDING');
      expect(preCheck.length).toBe(1);

      // Publish CATALOG_PRODUCT_ARCHIVED event
      const archiveEvent = createDomainEvent({
        eventType: EventTypes.CATALOG_PRODUCT_ARCHIVED,
        aggregateType: 'product',
        aggregateId: 'prod-1',
        tenantId,
        occurredAt: new Date().toISOString(),
        payload: { productId: 'prod-1' },
      });

      await transport.publish(archiveEvent);

      // Verify derived recommendation was invalidated
      const postCheck = await recommendationStore.getRecommendations(tenantId, 'TRENDING');
      expect(postCheck.length).toBe(0);
    });

    it('tolerates duplicate events idempotently via consumer receipts', async () => {
      const tenantId = 't-idemp';
      const event = createDomainEvent({
        eventType: EventTypes.CATALOG_PRODUCT_ARCHIVED,
        aggregateType: 'product',
        aggregateId: 'prod-x',
        tenantId,
        occurredAt: new Date().toISOString(),
        payload: { productId: 'prod-x' },
      });

      // Process twice
      await recommendationConsumer.process(event);
      await recommendationConsumer.process(event);

      // Only one consumer receipt recorded
      const receiptRes = await db.query(
        `SELECT COUNT(*) as count FROM event_consumer_receipts WHERE consumer_name = 'recommendations-ingestor' AND event_id = $1`,
        [event.eventId],
      );
      expect(Number((receiptRes.rows[0] as { count: string }).count)).toBe(1);
    });
  });

  // =========================================================================
  // 6. ADMINISTRATIVE REBUILD
  // =========================================================================
  describe('Administrative Rebuild Mechanism', () => {
    it('successfully rebuilds recommendations for a tenant and records audit', async () => {
      const admin = await getAdminToken();
      await seedCatalogAndListings(admin.tenantId);

      const res = await app.inject({
        method: 'POST',
        url: '/recommendations/rebuild',
        headers: { authorization: `Bearer ${admin.token}` },
        payload: { tenantId: admin.tenantId },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.status).toBe('COMPLETED');
      expect(body.recommendationsGenerated).toBeGreaterThan(0);
      expect(body.rebuiltByActorId).toBe(admin.userId);

      // Verify audit log row
      const auditRes = await db.query<{ status: string; recommendations_generated: number }>(
        `SELECT status, recommendations_generated FROM recommendation_rebuild_audit WHERE tenant_id = $1`,
        [admin.tenantId],
      );
      expect(auditRes.rows.length).toBe(1);
      expect(auditRes.rows[0]!.status).toBe('COMPLETED');
      expect(Number(auditRes.rows[0]!.recommendations_generated)).toBe(body.recommendationsGenerated);
    });

    it('forbids non-administrators from triggering rebuild', async () => {
      const customer = await getCustomerToken();

      const res = await app.inject({
        method: 'POST',
        url: '/recommendations/rebuild',
        headers: { authorization: `Bearer ${customer.token}` },
        payload: { tenantId: customer.tenantId },
      });

      expect(res.statusCode).toBe(403);
    });

    it('records failed audit when rebuild encounters an error', async () => {
      const admin = await getAdminToken();

      // Mock catalog service to fail during rebuild
      const failingCatalog = {
        ...catalogService,
        listProducts: async () => {
          throw new Error('Database connection aborted during rebuild');
        },
      } as unknown as CatalogService;

      const failingService = new RecommendationService({
        logger,
        catalogService: failingCatalog,
        listingService,
        analyticsReader: analyticsService,
        store: recommendationStore,
      });

      await expect(
        failingService.rebuildRecommendations({
          userId: admin.userId,
          tenantId: admin.tenantId,
          role: 'ADMINISTRATOR',
        }),
      ).rejects.toThrow('Database connection aborted during rebuild');

      const auditRes = await db.query<{ status: string; error_message: string }>(
        `SELECT status, error_message FROM recommendation_rebuild_audit WHERE tenant_id = $1 AND status = 'FAILED'`,
        [admin.tenantId],
      );
      expect(auditRes.rows.length).toBe(1);
      expect(auditRes.rows[0]!.error_message).toContain('Database connection aborted');
    });
  });

  // =========================================================================
  // 7. FUTURE EXTENSIBILITY (PHASE 13 ML RANKER PLUGGABILITY)
  // =========================================================================
  describe('Future Extensibility (Provider Abstraction)', () => {
    it('allows a custom/ML ranker implementing IRecommendationRanker to replace the deterministic ranker', async () => {
      // Mock future Phase 13 ML Ranker
      class MockPhase13MlRanker implements IRecommendationRanker {
        readonly providerName = 'ml-xgboost-ranker-v1';

        async rank(
          candidates: RecommendationCandidate[],
          _context: RecommendationContext,
        ): Promise<RankedRecommendation[]> {
          // Sort reverse or by ML predicted probability
          return candidates.map((c, i) => ({
            productId: c.productId,
            rankPosition: i + 1,
            score: 99.9999 - i,
            reasonCode: 'PERSONALIZED_HISTORY',
            explanation: 'Ranked by Phase 13 ML predictor model.',
            metadata: { model: 'v1.0' },
          }));
        }
      }

      const mlService = new RecommendationService({
        logger,
        catalogService,
        listingService,
        analyticsReader: analyticsService,
        store: recommendationStore,
        ranker: new MockPhase13MlRanker(),
      });

      const { tenantId, userId } = await getCustomerToken();
      await seedCatalogAndListings(tenantId);

      const res = await mlService.getTrendingRecommendations({
        userId,
        tenantId,
        role: 'CUSTOMER',
      });

      expect(res.metadata.rankerProvider).toBe('ml-xgboost-ranker-v1');
      expect(res.items[0]!.explanation).toBe('Ranked by Phase 13 ML predictor model.');
      expect(res.items[0]!.score).toBe(99.9999);
    });
  });

  // =========================================================================
  // 8. AUTHORITATIVE COMMERCE TRUTH INVARIANT
  // =========================================================================
  describe('Authoritative Commerce Truth & Display-Time Staleness Revalidation', () => {
    it('proves recommendations cannot override current authoritative price or inventory', async () => {
      const { token, tenantId } = await getCustomerToken();
      await seedCatalogAndListings(tenantId);

      // Get initial recommendation displaying price 49999
      const recRes = await app.inject({
        method: 'GET',
        url: '/recommendations/trending',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(recRes.statusCode).toBe(200);
      const recItem = recRes.json().items.find((i: { productId: string }) => i.productId === 'prod-1');
      expect(recItem.activeOffers[0].priceAmount).toBe(49999);

      // Mutate authoritative listing price in marketplace domain to 39999
      await db.query(`UPDATE merchant_listings SET price_amount = 39999 WHERE id = 'list-1'`);

      // Authoritative read from marketplace service shows updated price immediately
      const authoritativeListings = await listingService.getActiveListingsForSku('sku-1');
      expect(authoritativeListings[0]!.priceAmount).toBe(39999);

      // Recommendation display fetches live derived offers at display time and reflects 39999
      const updatedRecRes = await app.inject({
        method: 'GET',
        url: '/recommendations/trending',
        headers: { authorization: `Bearer ${token}` },
      });
      const updatedRecItem = updatedRecRes.json().items.find((i: { productId: string }) => i.productId === 'prod-1');
      expect(updatedRecItem.activeOffers[0].priceAmount).toBe(39999);
    });
  });
});

