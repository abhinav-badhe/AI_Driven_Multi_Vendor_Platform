import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { parseConfig } from '../src/config/index.js';
import { createMigratedTestDatabase, markAllUsersVerified, registerVerifiedUser } from './helpers/test-db.js';
import type { DatabaseConnection } from '../src/infra/database/connection.js';
import { InMemorySearchStore, SearchService } from '../src/modules/search/index.js';
import { JsonLogger } from '../src/observability/logger.js';

const TOKEN_SECRET = 'super-secret-key-at-least-16-chars';

describe('Phase 9: Derived Read-Model Search', () => {
  let app: FastifyInstance;
  let db: DatabaseConnection;
  let searchStore: InMemorySearchStore;
  let searchService: SearchService;

  beforeEach(async () => {
    db = await createMigratedTestDatabase();
    searchStore = new InMemorySearchStore();
    searchService = new SearchService(searchStore, new JsonLogger({ serviceName: 'test-search', level: 'info' }));

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
      skipMigrations: true,
    });
    await app.ready();
  });

  afterEach(async () => {
    if (app) await app.close();
    if (db) await db.close();
  });

  async function setupEcosystem() {
    // 1. Platform Administrator
    await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: {
        email: 'admin@platform.com',
        password: 'Password123!',
        tenantName: 'Platform Ops',
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
      email: 'alpha@merchants.com',
      password: 'Password123!',
      tenantName: 'Merchant Alpha Store',
      role: 'MERCHANT',
    });

    await app.inject({
      method: 'POST',
      url: '/merchants/onboard',
      headers: { authorization: `Bearer ${alphaToken}` },
      payload: { businessName: 'Alpha Electronics', legalName: 'Alpha LLC', contactEmail: 'alpha@biz.com' },
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
      email: 'beta@merchants.com',
      password: 'Password123!',
      tenantName: 'Merchant Beta Store',
      role: 'MERCHANT',
    });

    await app.inject({
      method: 'POST',
      url: '/merchants/onboard',
      headers: { authorization: `Bearer ${betaToken}` },
      payload: { businessName: 'Beta Mobiles', legalName: 'Beta Retail', contactEmail: 'beta@biz.com' },
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

    // 4. Customer
    const custToken = await registerVerifiedUser(app, db, {
      email: 'customer@buyer.com',
      password: 'Password123!',
      tenantName: 'Customer Tenant',
      role: 'CUSTOMER',
    });

    return {
      adminToken,
      alphaToken,
      alphaTenantId: profA.tenantId,
      betaToken,
      betaTenantId: profB.tenantId,
      custToken,
    };
  }

  async function createCatalogAndMultiVendorListings(eco: Awaited<ReturnType<typeof setupEcosystem>>) {
    // 1. Category
    const catRes = await app.inject({
      method: 'POST',
      url: '/categories',
      headers: { authorization: `Bearer ${eco.adminToken}` },
      payload: { name: 'Smartphones', slug: 'smartphones' },
    });
    const category = catRes.json();

    // 2. Canonical Product
    const prodRes = await app.inject({
      method: 'POST',
      url: '/products',
      headers: { authorization: `Bearer ${eco.adminToken}` },
      payload: {
        title: 'Apple iPhone 15 Pro',
        slug: 'apple-iphone-15-pro',
        description: 'Titanium design with A17 Pro chip and super retina XDR display',
        brand: 'Apple',
        categoryId: category.id,
      },
    });
    const product = prodRes.json();

    // 3. Canonical SKU
    const skuRes = await app.inject({
      method: 'POST',
      url: `/products/${product.id}/skus`,
      headers: { authorization: `Bearer ${eco.adminToken}` },
      payload: {
        skuCode: 'IPHONE-15-PRO-128-BLK',
        barcode: '194253123456',
        attributes: { color: 'Black Titanium', storage: '128GB' },
      },
    });
    const sku = skuRes.json();

    // Activate Product & SKU
    await app.inject({
      method: 'POST',
      url: `/products/${product.id}/status`,
      headers: { authorization: `Bearer ${eco.adminToken}` },
      payload: { status: 'ACTIVE' },
    });
    await app.inject({
      method: 'POST',
      url: `/skus/${sku.id}/status`,
      headers: { authorization: `Bearer ${eco.adminToken}` },
      payload: { status: 'ACTIVE' },
    });

    // 4. Seller Alpha Listing (₹100,000 -> 10000000 minor units)
    const listingARes = await app.inject({
      method: 'POST',
      url: '/listings',
      headers: { authorization: `Bearer ${eco.alphaToken}` },
      payload: {
        skuId: sku.id,
        priceAmount: 10000000,
        currency: 'INR',
        compareAtPrice: 10990000,
      },
    });
    const listingAlpha = listingARes.json();
    await app.inject({
      method: 'POST',
      url: `/listings/${listingAlpha.id}/status`,
      headers: { authorization: `Bearer ${eco.alphaToken}` },
      payload: { status: 'ACTIVE' },
    });
    await app.inject({
      method: 'POST',
      url: '/inventory',
      headers: { authorization: `Bearer ${eco.alphaToken}` },
      payload: { listingId: listingAlpha.id, skuId: sku.id, initialOnHandQuantity: 10 },
    });

    // 5. Seller Beta Listing (₹95,000 -> 9500000 minor units)
    const listingBRes = await app.inject({
      method: 'POST',
      url: '/listings',
      headers: { authorization: `Bearer ${eco.betaToken}` },
      payload: {
        skuId: sku.id,
        priceAmount: 9500000,
        currency: 'INR',
        compareAtPrice: 10500000,
      },
    });
    const listingBeta = listingBRes.json();
    await app.inject({
      method: 'POST',
      url: `/listings/${listingBeta.id}/status`,
      headers: { authorization: `Bearer ${eco.betaToken}` },
      payload: { status: 'ACTIVE' },
    });
    await app.inject({
      method: 'POST',
      url: '/inventory',
      headers: { authorization: `Bearer ${eco.betaToken}` },
      payload: { listingId: listingBeta.id, skuId: sku.id, initialOnHandQuantity: 5 },
    });

    return { category, product, sku, listingAlpha, listingBeta };
  }

  describe('Multi-Vendor Search Projection & Aggregation', () => {
    it('indexes canonical product and preserves multiple distinct seller offers without collapsing sellers', async () => {
      const eco = await setupEcosystem();
      const setup = await createCatalogAndMultiVendorListings(eco);

      // Rebuild projection from authoritative services
      const rebuildRes = await app.inject({
        method: 'POST',
        url: '/search/rebuild',
        headers: { authorization: `Bearer ${eco.adminToken}` },
      });
      expect(rebuildRes.statusCode).toBe(200);
      const rebuild = rebuildRes.json();
      expect(rebuild.indexedProductsCount).toBe(1);
      expect(rebuild.indexedOffersCount).toBe(2);

      // Query search as public customer
      const searchRes = await app.inject({
        method: 'GET',
        url: '/search?q=iPhone',
      });
      expect(searchRes.statusCode).toBe(200);
      const search = searchRes.json();

      expect(search.total).toBe(1);
      expect(search.items.length).toBe(1);

      const item = search.items[0];
      // Canonical product verification
      expect(item.productId).toBe(setup.product.id);
      expect(item.title).toBe('Apple iPhone 15 Pro');
      expect(item.brand).toBe('Apple');
      expect(item.categoryName).toBe('Smartphones');

      // Price range & stock
      expect(item.minPrice).toBe(9500000);
      expect(item.maxPrice).toBe(10000000);
      expect(item.hasInStockOffer).toBe(true);
      expect(item.totalOffersCount).toBe(2);

      // Best offer is Seller Beta (₹95,000)
      expect(item.bestOffer).toBeDefined();
      expect(item.bestOffer.merchantId).toBe(eco.betaTenantId);
      expect(item.bestOffer.priceAmount).toBe(9500000);

      // Preserves both seller offers in offers array
      expect(item.offers.length).toBe(2);
      const alphaOffer = item.offers.find((o: { merchantId: string }) => o.merchantId === eco.alphaTenantId);
      const betaOffer = item.offers.find((o: { merchantId: string }) => o.merchantId === eco.betaTenantId);
      expect(alphaOffer).toBeDefined();
      expect(alphaOffer.priceAmount).toBe(10000000);
      expect(betaOffer).toBeDefined();
      expect(betaOffer.priceAmount).toBe(9500000);
    });

    it('attaches matchedOffer when filtered specifically by merchantId', async () => {
      const eco = await setupEcosystem();
      await createCatalogAndMultiVendorListings(eco);

      await app.inject({
        method: 'POST',
        url: '/search/rebuild',
        headers: { authorization: `Bearer ${eco.adminToken}` },
      });

      // Filter by Alpha
      const resAlpha = await app.inject({
        method: 'GET',
        url: `/search?merchantId=${eco.alphaTenantId}`,
      });
      expect(resAlpha.statusCode).toBe(200);
      const alphaItem = resAlpha.json().items[0];
      expect(alphaItem.matchedOffer).toBeDefined();
      expect(alphaItem.matchedOffer.merchantId).toBe(eco.alphaTenantId);
      expect(alphaItem.matchedOffer.priceAmount).toBe(10000000);

      // Filter by Beta
      const resBeta = await app.inject({
        method: 'GET',
        url: `/search?merchantId=${eco.betaTenantId}`,
      });
      expect(resBeta.statusCode).toBe(200);
      const betaItem = resBeta.json().items[0];
      expect(betaItem.matchedOffer).toBeDefined();
      expect(betaItem.matchedOffer.merchantId).toBe(eco.betaTenantId);
      expect(betaItem.matchedOffer.priceAmount).toBe(9500000);
    });
  });

  describe('Search Filtering, Sorting, and Facets', () => {
    it('supports text matching, category filter, brand filter, price range, and inStock filter', async () => {
      const eco = await setupEcosystem();
      const setup = await createCatalogAndMultiVendorListings(eco);

      // Add a second product (Samsung Galaxy S24 Ultra)
      const prod2 = (
        await app.inject({
          method: 'POST',
          url: '/products',
          headers: { authorization: `Bearer ${eco.adminToken}` },
          payload: {
            title: 'Samsung Galaxy S24 Ultra',
            slug: 'samsung-galaxy-s24-ultra',
            description: 'AI powered smartphone with Titanium frame and S Pen',
            brand: 'Samsung',
            categoryId: setup.category.id,
          },
        })
      ).json();
      const sku2 = (
        await app.inject({
          method: 'POST',
          url: `/products/${prod2.id}/skus`,
          headers: { authorization: `Bearer ${eco.adminToken}` },
          payload: { skuCode: 'SAMSUNG-S24U-256', attributes: { color: 'Titanium Gray' } },
        })
      ).json();
      await app.inject({
        method: 'POST',
        url: `/products/${prod2.id}/status`,
        headers: { authorization: `Bearer ${eco.adminToken}` },
        payload: { status: 'ACTIVE' },
      });
      await app.inject({
        method: 'POST',
        url: `/skus/${sku2.id}/status`,
        headers: { authorization: `Bearer ${eco.adminToken}` },
        payload: { status: 'ACTIVE' },
      });

      const listing2 = (
        await app.inject({
          method: 'POST',
          url: '/listings',
          headers: { authorization: `Bearer ${eco.alphaToken}` },
          payload: { skuId: sku2.id, priceAmount: 12000000, currency: 'INR' },
        })
      ).json();
      await app.inject({
        method: 'POST',
        url: `/listings/${listing2.id}/status`,
        headers: { authorization: `Bearer ${eco.alphaToken}` },
        payload: { status: 'ACTIVE' },
      });
      await app.inject({
        method: 'POST',
        url: '/inventory',
        headers: { authorization: `Bearer ${eco.alphaToken}` },
        payload: { listingId: listing2.id, skuId: sku2.id, initialOnHandQuantity: 0 }, // Out of stock
      });

      await app.inject({
        method: 'POST',
        url: '/search/rebuild',
        headers: { authorization: `Bearer ${eco.adminToken}` },
      });

      // 1. Brand Filter
      const resBrand = await app.inject({ method: 'GET', url: '/search?brand=Samsung' });
      expect(resBrand.json().total).toBe(1);
      expect(resBrand.json().items[0].brand).toBe('Samsung');

      // 2. In Stock Filter (only iPhone is in stock)
      const resInStock = await app.inject({ method: 'GET', url: '/search?inStock=true' });
      expect(resInStock.json().total).toBe(1);
      expect(resInStock.json().items[0].title).toBe('Apple iPhone 15 Pro');

      // 3. Price Filter (minPrice=11000000 matches only Samsung)
      const resPrice = await app.inject({ method: 'GET', url: '/search?minPrice=11000000' });
      expect(resPrice.json().total).toBe(1);
      expect(resPrice.json().items[0].title).toBe('Samsung Galaxy S24 Ultra');

      // 4. Sorting price_asc vs price_desc
      const sortAsc = await app.inject({ method: 'GET', url: '/search?sortBy=price_asc' });
      expect(sortAsc.json().items[0].title).toBe('Apple iPhone 15 Pro'); // ₹95,000 < ₹120,000
      expect(sortAsc.json().items[1].title).toBe('Samsung Galaxy S24 Ultra');

      const sortDesc = await app.inject({ method: 'GET', url: '/search?sortBy=price_desc' });
      expect(sortDesc.json().items[0].title).toBe('Samsung Galaxy S24 Ultra');
      expect(sortDesc.json().items[1].title).toBe('Apple iPhone 15 Pro');

      // 5. Facets Aggregation
      const allRes = await app.inject({ method: 'GET', url: '/search' });
      const facets = allRes.json().facets;
      expect(facets.categories.length).toBe(1);
      expect(facets.categories[0].name).toBe('Smartphones');
      expect(facets.brands.length).toBe(2);
      expect(facets.priceRange.min).toBe(9500000);
      expect(facets.priceRange.max).toBe(12000000);
    });

    it('enforces deterministic pagination with secondary tie-breaker', async () => {
      const eco = await setupEcosystem();
      await createCatalogAndMultiVendorListings(eco);

      // Rebuild initial listing into projection
      await app.inject({
        method: 'POST',
        url: '/search/rebuild',
        headers: { authorization: `Bearer ${eco.adminToken}` },
      });

      // Add 2 more products to have 3 total products
      for (let i = 1; i <= 2; i++) {
        await app.inject({
          method: 'POST',
          url: '/search/sync/product',
          headers: { authorization: `Bearer ${eco.adminToken}` },
          payload: {
            productId: `prod-deterministic-${i}`,
            title: `Deterministic Device ${i}`,
            slug: `dev-${i}`,
            status: 'ACTIVE',
            sourceVersion: 1,
          },
        });

        await app.inject({
          method: 'POST',
          url: '/search/sync/listing',
          headers: { authorization: `Bearer ${eco.adminToken}` },
          payload: {
            listingId: `list-deterministic-${i}`,
            merchantId: eco.alphaTenantId,
            productId: `prod-deterministic-${i}`,
            skuId: `sku-deterministic-${i}`,
            skuCode: `SKU-DET-${i}`,
            priceAmount: 100 * i,
            currency: 'USD',
            status: 'ACTIVE',
            inStock: true,
            availableQuantity: 10,
            sourceVersion: 1,
          },
        });
      }

      const p1 = await app.inject({ method: 'GET', url: '/search?page=1&pageSize=2' });
      const p2 = await app.inject({ method: 'GET', url: '/search?page=2&pageSize=2' });

      expect(p1.statusCode).toBe(200);
      expect(p2.statusCode).toBe(200);

      const items1 = p1.json().items;
      const items2 = p2.json().items;

      expect(items1.length).toBe(2);
      expect(items2.length).toBe(1);

      // Verify no overlap across pages
      const ids1 = items1.map((i: { productId: string }) => i.productId);
      const ids2 = items2.map((i: { productId: string }) => i.productId);
      for (const id of ids2) {
        expect(ids1.includes(id)).toBe(false);
      }
    });
  });

  describe('Stale-Write Protection & Concurrency Safeguards', () => {
    it('accepts higher source version and deterministically drops older/duplicate versions', async () => {
      const eco = await setupEcosystem();

      // 1. Initial version 2 arrives
      const v2Res = await app.inject({
        method: 'POST',
        url: '/search/sync/product',
        headers: { authorization: `Bearer ${eco.adminToken}` },
        payload: {
          productId: 'prod-versioning-test',
          title: 'Version 2 Product Title',
          slug: 'prod-v2',
          status: 'ACTIVE',
          sourceVersion: 2,
        },
      });
      expect(v2Res.statusCode).toBe(200);
      expect(v2Res.json().indexed).toBe(true);

      // 2. Out-of-order older version 1 arrives -> MUST BE DROPPED
      const v1Res = await app.inject({
        method: 'POST',
        url: '/search/sync/product',
        headers: { authorization: `Bearer ${eco.adminToken}` },
        payload: {
          productId: 'prod-versioning-test',
          title: 'Stale Version 1 Title',
          slug: 'prod-v1',
          status: 'ACTIVE',
          sourceVersion: 1,
        },
      });
      expect(v1Res.statusCode).toBe(200);
      expect(v1Res.json().indexed).toBe(false);
      expect(v1Res.json().reason).toBe('STALE_OR_DUPLICATE_VERSION');

      // Verify document still has Version 2 data
      const doc = await searchStore.getDocument('prod-versioning-test');
      expect(doc?.title).toBe('Version 2 Product Title');
      expect(doc?.sourceVersion).toBe(2);

      // 3. Newer version 3 arrives -> MUST BE ACCEPTED
      const v3Res = await app.inject({
        method: 'POST',
        url: '/search/sync/product',
        headers: { authorization: `Bearer ${eco.adminToken}` },
        payload: {
          productId: 'prod-versioning-test',
          title: 'Version 3 Product Title',
          slug: 'prod-v3',
          status: 'ACTIVE',
          sourceVersion: 3,
        },
      });
      expect(v3Res.statusCode).toBe(200);
      expect(v3Res.json().indexed).toBe(true);

      const docV3 = await searchStore.getDocument('prod-versioning-test');
      expect(docV3?.title).toBe('Version 3 Product Title');
      expect(docV3?.sourceVersion).toBe(3);
      expect(docV3?.projectionVersion).toBe(2);
    });

    it('handles concurrent projection updates safely without data corruption', async () => {
      const eco = await setupEcosystem();

      await app.inject({
        method: 'POST',
        url: '/search/sync/product',
        headers: { authorization: `Bearer ${eco.adminToken}` },
        payload: {
          productId: 'prod-concurrency-test',
          title: 'Concurrent Product',
          slug: 'prod-concurrent',
          status: 'ACTIVE',
          sourceVersion: 1,
        },
      });

      // Dispatch 3 simultaneous listing updates for different sellers on the same product
      const [r1, r2, r3] = await Promise.all([
        app.inject({
          method: 'POST',
          url: '/search/sync/listing',
          headers: { authorization: `Bearer ${eco.adminToken}` },
          payload: {
            listingId: 'list-c-1',
            merchantId: 'merchant-1',
            productId: 'prod-concurrency-test',
            skuId: 'sku-1',
            skuCode: 'SKU-1',
            priceAmount: 1000,
            currency: 'INR',
            sourceVersion: 1,
          },
        }),
        app.inject({
          method: 'POST',
          url: '/search/sync/listing',
          headers: { authorization: `Bearer ${eco.adminToken}` },
          payload: {
            listingId: 'list-c-2',
            merchantId: 'merchant-2',
            productId: 'prod-concurrency-test',
            skuId: 'sku-2',
            skuCode: 'SKU-2',
            priceAmount: 900,
            currency: 'INR',
            sourceVersion: 1,
          },
        }),
        app.inject({
          method: 'POST',
          url: '/search/sync/listing',
          headers: { authorization: `Bearer ${eco.adminToken}` },
          payload: {
            listingId: 'list-c-3',
            merchantId: 'merchant-3',
            productId: 'prod-concurrency-test',
            skuId: 'sku-3',
            skuCode: 'SKU-3',
            priceAmount: 1100,
            currency: 'INR',
            sourceVersion: 1,
          },
        }),
      ]);

      expect(r1.statusCode).toBe(200);
      expect(r2.statusCode).toBe(200);
      expect(r3.statusCode).toBe(200);

      // Verify that all 3 seller offers are safely preserved
      const doc = await searchStore.getDocument('prod-concurrency-test');
      expect(doc?.offers.length).toBe(3);
      expect(doc?.minPrice).toBe(900);
      expect(doc?.maxPrice).toBe(1100);
      expect(doc?.totalOffersCount).toBe(3);
    });

    it('prevents fabricated high sourceVersion from poisoning projection and rejects stale/duplicate writes deterministically', async () => {
      const eco = await setupEcosystem();
      const setup = await createCatalogAndMultiVendorListings(eco);

      // 1. Initial authoritative sync derives true version from Catalog DB updatedAt
      const syncRes1 = await app.inject({
        method: 'POST',
        url: '/search/sync/product',
        headers: { authorization: `Bearer ${eco.adminToken}` },
        payload: {
          productId: setup.product.id,
          sourceVersion: 999999999, // Attempt to fabricate high version in HTTP payload
          title: 'Fabricated High Version Title',
        },
      });
      expect(syncRes1.statusCode).toBe(200);

      // Verify that stored document used authoritative Catalog title and database updatedAt, NOT the client payload!
      const doc = await searchStore.getDocument(setup.product.id);
      expect(doc?.title).toBe('Apple iPhone 15 Pro');
      const dbProd = await db.query('SELECT updated_at FROM products WHERE id = $1', [setup.product.id]);
      expect(doc?.sourceVersion).toBe(new Date((dbProd.rows[0] as { updated_at: string | Date }).updated_at).getTime());
      expect(doc?.sourceVersion).not.toBe(999999999);

      // 2. Direct internal application call with stale version is deterministically rejected
      const staleRes = await searchService.upsertProductProjection({
        productId: setup.product.id,
        title: 'Stale Product Title',
        slug: setup.product.slug,
        status: 'ACTIVE',
        sourceVersion: doc!.sourceVersion - 1000, // Stale version
      });
      expect(staleRes.indexed).toBe(false);
      expect(staleRes.reason).toBe('STALE_OR_DUPLICATE_VERSION');

      // 3. Direct internal application call with duplicate version is rejected
      const dupRes = await searchService.upsertProductProjection({
        productId: setup.product.id,
        title: 'Duplicate Version Title',
        slug: setup.product.slug,
        status: 'ACTIVE',
        sourceVersion: doc!.sourceVersion, // Duplicate version
      });
      expect(dupRes.indexed).toBe(false);
      expect(dupRes.reason).toBe('STALE_OR_DUPLICATE_VERSION');

      // 4. Listing offer projection also deterministically drops stale or duplicate versions
      const initialOfferRes = await searchService.upsertListingProjection({
        listingId: setup.listingAlpha.id,
        merchantId: eco.alphaTenantId,
        productId: setup.product.id,
        skuId: setup.sku.id,
        skuCode: setup.sku.skuCode,
        priceAmount: 10000000,
        currency: 'INR',
        status: 'ACTIVE',
        inStock: true,
        availableQuantity: 10,
        sourceVersion: 2000,
      });
      expect(initialOfferRes.indexed).toBe(true);

      // Stale offer version (1000 <= 2000) -> dropped
      const staleOfferRes = await searchService.upsertListingProjection({
        listingId: setup.listingAlpha.id,
        merchantId: eco.alphaTenantId,
        productId: setup.product.id,
        skuId: setup.sku.id,
        skuCode: setup.sku.skuCode,
        priceAmount: 8000000,
        currency: 'INR',
        status: 'ACTIVE',
        inStock: true,
        availableQuantity: 5,
        sourceVersion: 1000,
      });
      expect(staleOfferRes.indexed).toBe(false);
      expect(staleOfferRes.reason).toBe('STALE_OR_DUPLICATE_VERSION');

      // Duplicate offer version (2000 <= 2000) -> dropped
      const dupOfferRes = await searchService.upsertListingProjection({
        listingId: setup.listingAlpha.id,
        merchantId: eco.alphaTenantId,
        productId: setup.product.id,
        skuId: setup.sku.id,
        skuCode: setup.sku.skuCode,
        priceAmount: 10000000,
        currency: 'INR',
        status: 'ACTIVE',
        inStock: true,
        availableQuantity: 10,
        sourceVersion: 2000,
      });
      expect(dupOfferRes.indexed).toBe(false);
      expect(dupOfferRes.reason).toBe('STALE_OR_DUPLICATE_VERSION');

      // Newer offer version (3000 > 2000) -> accepted
      const newerOfferRes = await searchService.upsertListingProjection({
        listingId: setup.listingAlpha.id,
        merchantId: eco.alphaTenantId,
        productId: setup.product.id,
        skuId: setup.sku.id,
        skuCode: setup.sku.skuCode,
        priceAmount: 9500000,
        currency: 'INR',
        status: 'ACTIVE',
        inStock: true,
        availableQuantity: 8,
        sourceVersion: 3000,
      });
      expect(newerOfferRes.indexed).toBe(true);
    });
  });

  describe('Deactivation & Deletion Semantics (Derived vs Transactional)', () => {
    it('removes listing offer and product projection without modifying or deleting transactional source records', async () => {
      const eco = await setupEcosystem();
      const setup = await createCatalogAndMultiVendorListings(eco);

      await app.inject({
        method: 'POST',
        url: '/search/rebuild',
        headers: { authorization: `Bearer ${eco.adminToken}` },
      });

      // 1. Remove Seller Alpha listing offer from projection
      const delOfferRes = await app.inject({
        method: 'DELETE',
        url: `/search/sync/product/${setup.product.id}/listings/${setup.listingAlpha.id}`,
        headers: { authorization: `Bearer ${eco.adminToken}` },
      });
      expect(delOfferRes.statusCode).toBe(200);
      expect(delOfferRes.json().removed).toBe(true);

      // Search index now has only 1 offer (Beta @ ₹95,000)
      const afterDelOffer = await app.inject({ method: 'GET', url: `/search/documents/${setup.product.id}` });
      expect(afterDelOffer.json().totalOffersCount).toBe(1);
      expect(afterDelOffer.json().minPrice).toBe(9500000);
      expect(afterDelOffer.json().maxPrice).toBe(9500000);

      // 2. Remove entire product from projection
      const delProdRes = await app.inject({
        method: 'DELETE',
        url: `/search/sync/product/${setup.product.id}`,
        headers: { authorization: `Bearer ${eco.adminToken}` },
      });
      expect(delProdRes.statusCode).toBe(200);
      expect(delProdRes.json().removed).toBe(true);

      const afterDelProd = await app.inject({ method: 'GET', url: `/search/documents/${setup.product.id}` });
      expect(afterDelProd.statusCode).toBe(404);

      // CRITICAL PROOF: Transactional tables are completely untouched
      const dbProd = await db.query('SELECT * FROM products WHERE id = $1', [setup.product.id]);
      expect(dbProd.rows.length).toBe(1);

      const dbListing = await db.query('SELECT * FROM merchant_listings WHERE id = $1', [setup.listingAlpha.id]);
      expect(dbListing.rows.length).toBe(1);
    });

    it('removing the final listing correctly makes the canonical product undiscoverable in public search', async () => {
      const eco = await setupEcosystem();
      const setup = await createCatalogAndMultiVendorListings(eco);

      await app.inject({
        method: 'POST',
        url: '/search/rebuild',
        headers: { authorization: `Bearer ${eco.adminToken}` },
      });

      // Initially product has 2 active offers and is discoverable
      const initialSearch = await app.inject({ method: 'GET', url: '/search?q=iPhone' });
      expect(initialSearch.statusCode).toBe(200);
      expect(initialSearch.json().total).toBe(1);

      // Remove Seller Alpha's offer
      await app.inject({
        method: 'DELETE',
        url: `/search/sync/product/${setup.product.id}/listings/${setup.listingAlpha.id}`,
        headers: { authorization: `Bearer ${eco.adminToken}` },
      });

      // Product still discoverable because Seller Beta offer remains
      const afterFirstDel = await app.inject({ method: 'GET', url: '/search?q=iPhone' });
      expect(afterFirstDel.json().total).toBe(1);
      expect(afterFirstDel.json().items[0].totalOffersCount).toBe(1);

      // Now remove Seller Beta's offer (the FINAL remaining offer)
      await app.inject({
        method: 'DELETE',
        url: `/search/sync/product/${setup.product.id}/listings/${setup.listingBeta.id}`,
        headers: { authorization: `Bearer ${eco.adminToken}` },
      });

      // Public search (without includeInactive) MUST find 0 results: product is undiscoverable
      const publicSearch = await app.inject({ method: 'GET', url: '/search?q=iPhone' });
      expect(publicSearch.statusCode).toBe(200);
      expect(publicSearch.json().total).toBe(0);
      expect(publicSearch.json().items).toEqual([]);

      // Administrator inspection with includeInactive=true can still retrieve the product
      const adminSearch = await app.inject({
        method: 'GET',
        url: '/search?q=iPhone&includeInactive=true',
        headers: { authorization: `Bearer ${eco.adminToken}` },
      });
      expect(adminSearch.statusCode).toBe(200);
      expect(adminSearch.json().total).toBe(1);
      expect(adminSearch.json().items[0].totalOffersCount).toBe(0);
    });
  });

  describe('Security, RBAC & Query DSL Injection Protection', () => {
    it('prevents non-administrators and unauthenticated callers from triggering rebuild or mutating projections', async () => {
      const eco = await setupEcosystem();

      // 1. Unauthenticated requests receive 401
      const unauthRebuild = await app.inject({ method: 'POST', url: '/search/rebuild' });
      expect(unauthRebuild.statusCode).toBe(401);

      const unauthSyncProd = await app.inject({
        method: 'POST',
        url: '/search/sync/product',
        payload: { productId: 'p1' },
      });
      expect(unauthSyncProd.statusCode).toBe(401);

      const unauthSyncList = await app.inject({
        method: 'POST',
        url: '/search/sync/listing',
        payload: { listingId: 'l1' },
      });
      expect(unauthSyncList.statusCode).toBe(401);

      const unauthDel = await app.inject({ method: 'DELETE', url: '/search/sync/product/p1' });
      expect(unauthDel.statusCode).toBe(401);

      // 2. Customer receives 403 on all projection mutation endpoints
      const custRebuild = await app.inject({
        method: 'POST',
        url: '/search/rebuild',
        headers: { authorization: `Bearer ${eco.custToken}` },
      });
      expect(custRebuild.statusCode).toBe(403);

      const custSyncProd = await app.inject({
        method: 'POST',
        url: '/search/sync/product',
        headers: { authorization: `Bearer ${eco.custToken}` },
        payload: { productId: 'p-hack', title: 'Hacked', slug: 'hack', sourceVersion: 1 },
      });
      expect(custSyncProd.statusCode).toBe(403);

      const custSyncList = await app.inject({
        method: 'POST',
        url: '/search/sync/listing',
        headers: { authorization: `Bearer ${eco.custToken}` },
        payload: { listingId: 'l-hack' },
      });
      expect(custSyncList.statusCode).toBe(403);

      const custDel = await app.inject({
        method: 'DELETE',
        url: '/search/sync/product/p1',
        headers: { authorization: `Bearer ${eco.custToken}` },
      });
      expect(custDel.statusCode).toBe(403);

      // 3. Merchant receives 403 on all projection mutation endpoints
      const merchRebuild = await app.inject({
        method: 'POST',
        url: '/search/rebuild',
        headers: { authorization: `Bearer ${eco.alphaToken}` },
      });
      expect(merchRebuild.statusCode).toBe(403);

      const merchSyncProd = await app.inject({
        method: 'POST',
        url: '/search/sync/product',
        headers: { authorization: `Bearer ${eco.alphaToken}` },
        payload: { productId: 'p-hack', title: 'Hacked', slug: 'hack', sourceVersion: 1 },
      });
      expect(merchSyncProd.statusCode).toBe(403);

      const merchSyncList = await app.inject({
        method: 'POST',
        url: '/search/sync/listing',
        headers: { authorization: `Bearer ${eco.alphaToken}` },
        payload: { listingId: 'l-hack' },
      });
      expect(merchSyncList.statusCode).toBe(403);

      const merchDel = await app.inject({
        method: 'DELETE',
        url: '/search/sync/product/p1',
        headers: { authorization: `Bearer ${eco.alphaToken}` },
      });
      expect(merchDel.statusCode).toBe(403);
    });

    it('sanitizes query parameters and neutralizes search DSL control characters', async () => {
      const eco = await setupEcosystem();
      await createCatalogAndMultiVendorListings(eco);

      await app.inject({
        method: 'POST',
        url: '/search/rebuild',
        headers: { authorization: `Bearer ${eco.adminToken}` },
      });

      // Inject Lucene / ES query syntax characters
      const dslQuery = 'iPhone {* TO *} ~ " ^ [ ] ( ) / \\';
      const res = await app.inject({
        method: 'GET',
        url: `/search?q=${encodeURIComponent(dslQuery)}`,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().items.length).toBe(1);
      expect(res.json().items[0].title).toBe('Apple iPhone 15 Pro');
    });

    it('validates request bounds and rejects negative or inverted parameters with 400 Bad Request', async () => {
      // 1. Negative page
      const r1 = await app.inject({ method: 'GET', url: '/search?page=-1' });
      expect(r1.statusCode).toBe(400);

      // 2. Out of bound pageSize
      const r2 = await app.inject({ method: 'GET', url: '/search?pageSize=200' });
      expect(r2.statusCode).toBe(400);

      // 3. minPrice > maxPrice
      const r3 = await app.inject({ method: 'GET', url: '/search?minPrice=500&maxPrice=100' });
      expect(r3.statusCode).toBe(400);

      // 4. Invalid sortBy
      const r4 = await app.inject({ method: 'GET', url: '/search?sortBy=arbitrary_column' });
      expect(r4.statusCode).toBe(400);
    });

    it('prevents customers from inspecting inactive products via includeInactive flag', async () => {
      const eco = await setupEcosystem();

      const res = await app.inject({
        method: 'GET',
        url: '/search?includeInactive=true',
        headers: { authorization: `Bearer ${eco.custToken}` },
      });
      expect(res.statusCode).toBe(403);
    });
  });

  describe('Failure Matrix & Recovery Verification (Scenarios A - J)', () => {
    it('Scenario F: search store outage fails gracefully without corrupting transactional database', async () => {
      const eco = await setupEcosystem();
      await createCatalogAndMultiVendorListings(eco);

      // Simulate storage outage
      searchStore.setAvailability(false);

      const searchRes = await app.inject({ method: 'GET', url: '/search?q=iPhone' });
      expect(searchRes.statusCode).toBe(500);

      // Transactional DB remains fully functional
      const dbCheck = await db.query('SELECT count(*) as count FROM products');
      expect(Number((dbCheck.rows[0] as { count: string | number }).count)).toBe(1);

      // Restore availability
      searchStore.setAvailability(true);
      const restoreRes = await app.inject({ method: 'GET', url: '/search?q=iPhone' });
      expect(restoreRes.statusCode).toBe(200);
    });

    it('Scenario G: empty search query returns stable 200 with empty items and facets', async () => {
      const res = await app.inject({ method: 'GET', url: '/search?q=NonExistentDevice12345' });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.total).toBe(0);
      expect(body.items).toEqual([]);
      expect(body.totalPages).toBe(0);
      expect(body.facets.categories).toEqual([]);
    });

    it('Scenario H: index containing stale/poisoned documents is completely purged and deterministically rebuilt from authoritative source', async () => {
      const eco = await setupEcosystem();
      const setup = await createCatalogAndMultiVendorListings(eco);

      // 1. Initial rebuild creates correct authoritative snapshot
      await app.inject({
        method: 'POST',
        url: '/search/rebuild',
        headers: { authorization: `Bearer ${eco.adminToken}` },
      });

      // 2. Simulate poisoned/stale documents injected directly into the derived store
      await searchStore.indexDocument({
        id: 'poisoned-doc-999',
        title: 'Fabricated Poisoned Phone',
        slug: 'fabricated-poison',
        status: 'ACTIVE',
        minPrice: 1,
        maxPrice: 1,
        currency: 'USD',
        hasInStockOffer: true,
        totalOffersCount: 1,
        offers: [
          {
            listingId: 'poison-listing-1',
            merchantId: 'rogue-merchant',
            skuId: 'fake-sku',
            skuCode: 'FAKE-1',
            priceAmount: 1,
            currency: 'USD',
            status: 'ACTIVE',
            inStock: true,
            availableQuantity: 9999,
            attributes: {},
            sourceVersion: 999999999,
            updatedAt: new Date().toISOString(),
          },
        ],
        attributes: {},
        sourceVersion: 999999999,
        projectionVersion: 1,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      // Verify the poisoned doc is visible before rebuild
      const poisonedBefore = await app.inject({ method: 'GET', url: '/search?q=Fabricated' });
      expect(poisonedBefore.json().total).toBe(1);

      // 3. Trigger rebuildProjection
      const rebuildRes = await app.inject({
        method: 'POST',
        url: '/search/rebuild',
        headers: { authorization: `Bearer ${eco.adminToken}` },
      });
      expect(rebuildRes.statusCode).toBe(200);
      const rebuildBody = rebuildRes.json();
      expect(rebuildBody.indexedProductsCount).toBe(1); // Only the 1 authoritative catalog product
      expect(rebuildBody.indexedOffersCount).toBe(2); // The 2 authoritative listings (Alpha & Beta)

      // 4. Verify poisoned document is COMPLETELY PURGED
      const poisonedAfter = await app.inject({ method: 'GET', url: '/search?q=Fabricated' });
      expect(poisonedAfter.json().total).toBe(0);
      expect(poisonedAfter.json().items).toEqual([]);

      // 5. Verify authoritative product is preserved with exact catalog/listing details
      const doc = await searchStore.getDocument(setup.product.id);
      expect(doc).not.toBeNull();
      expect(doc?.title).toBe('Apple iPhone 15 Pro');
      expect(doc?.offers.length).toBe(2);

      // 6. Repeated rebuild produces identical deterministic results
      const repeatedRebuild = await app.inject({
        method: 'POST',
        url: '/search/rebuild',
        headers: { authorization: `Bearer ${eco.adminToken}` },
      });
      expect(repeatedRebuild.statusCode).toBe(200);
      expect(repeatedRebuild.json().indexedProductsCount).toBe(1);
      expect(repeatedRebuild.json().indexedOffersCount).toBe(2);
    });

    it('Scenario I & J: search eventual consistency does not bypass authoritative checkout pricing or inventory validation', async () => {
      const eco = await setupEcosystem();
      const setup = await createCatalogAndMultiVendorListings(eco);

      await app.inject({
        method: 'POST',
        url: '/search/rebuild',
        headers: { authorization: `Bearer ${eco.adminToken}` },
      });

      // Stale state: Search projection shows listing is active and price is ₹100,000
      const searchRes = await app.inject({ method: 'GET', url: '/search?q=iPhone' });
      expect(searchRes.json().items[0].minPrice).toBe(9500000);

      // Now change authoritative listing price in Marketplace
      await app.inject({
        method: 'PATCH',
        url: `/listings/${setup.listingAlpha.id}`,
        headers: { authorization: `Bearer ${eco.alphaToken}` },
        payload: { priceAmount: 11500000 },
      });

      // Checkout session authoritatively consumes listing price, NOT the search index price!
      const cartRes = await app.inject({
        method: 'POST',
        url: '/cart/items',
        headers: { authorization: `Bearer ${eco.custToken}` },
        payload: { listingId: setup.listingAlpha.id, quantity: 1 },
      });
      expect(cartRes.statusCode).toBe(200);

      const checkoutRes = await app.inject({
        method: 'POST',
        url: '/checkout/sessions',
        headers: { authorization: `Bearer ${eco.custToken}` },
      });
      expect(checkoutRes.statusCode).toBe(201);
      const session = checkoutRes.json();

      // Proves checkout used authoritative listing price (₹115,000 = 11500000), not search price
      expect(session.subtotalAmount).toBe(11500000);
    });
  });
});
