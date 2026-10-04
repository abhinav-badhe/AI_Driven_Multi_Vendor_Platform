import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createMigratedTestDatabase } from './helpers/test-db.js';
import type { DatabaseConnection } from '../src/infra/database/connection.js';
import { SqlSearchStore } from '../src/infra/search/sql-search-store.js';
import type { SearchProductDocument } from '../src/modules/search/index.js';

describe('Production-Safe SqlSearchStore (PostgreSQL Persistent Read-Model)', () => {
  let db: DatabaseConnection;
  let store: SqlSearchStore;

  beforeEach(async () => {
    db = await createMigratedTestDatabase();
    store = new SqlSearchStore(db);
  });

  afterEach(async () => {
    if (db) await db.close();
  });

  const sampleDoc1: SearchProductDocument = {
    id: 'prod-101',
    title: 'Sony WH-1000XM5 Wireless Headphones',
    slug: 'sony-wh-1000xm5',
    description: 'Industry leading noise cancelling headphones with Alexa built-in',
    brand: 'Sony',
    categoryId: 'cat-audio',
    categoryName: 'Audio & Headphones',
    status: 'ACTIVE',
    minPrice: 24999,
    maxPrice: 29999,
    currency: 'INR',
    hasInStockOffer: true,
    totalOffersCount: 2,
    attributes: { color: 'Black', bluetooth: '5.2' },
    offers: [
      {
        listingId: 'list-sony-apex',
        merchantId: 'merch-apex',
        merchantName: 'Apex Electronics',
        skuId: 'sku-sony-blk',
        skuCode: 'SONY-WH5-BLK',
        priceAmount: 24999,
        currency: 'INR',
        compareAtPrice: 29999,
        status: 'ACTIVE',
        inStock: true,
        availableQuantity: 15,
        attributes: { color: 'Black' },
        sourceVersion: 100,
        updatedAt: new Date().toISOString(),
      },
      {
        listingId: 'list-sony-stellar',
        merchantId: 'merch-stellar',
        merchantName: 'Stellar Retail',
        skuId: 'sku-sony-blk',
        skuCode: 'SONY-WH5-BLK',
        priceAmount: 26999,
        currency: 'INR',
        compareAtPrice: 29999,
        status: 'ACTIVE',
        inStock: true,
        availableQuantity: 8,
        attributes: { color: 'Black' },
        sourceVersion: 100,
        updatedAt: new Date().toISOString(),
      },
    ],
    sourceVersion: 100,
    projectionVersion: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  const sampleDoc2: SearchProductDocument = {
    id: 'prod-102',
    title: 'Apple MacBook Pro 14 M3',
    slug: 'apple-macbook-pro-14-m3',
    description: 'Apple M3 Pro chip with 18-core GPU and Liquid Retina XDR display',
    brand: 'Apple',
    categoryId: 'cat-laptops',
    categoryName: 'Laptops & Computers',
    status: 'ACTIVE',
    minPrice: 169900,
    maxPrice: 169900,
    currency: 'INR',
    hasInStockOffer: true,
    totalOffersCount: 1,
    attributes: { chip: 'M3 Pro', ram: '18GB' },
    offers: [
      {
        listingId: 'list-apple-stellar',
        merchantId: 'merch-stellar',
        merchantName: 'Stellar Retail',
        skuId: 'sku-mbp-m3',
        skuCode: 'MBP-14-M3',
        priceAmount: 169900,
        currency: 'INR',
        compareAtPrice: 179900,
        status: 'ACTIVE',
        inStock: true,
        availableQuantity: 5,
        attributes: { chip: 'M3 Pro' },
        sourceVersion: 100,
        updatedAt: new Date().toISOString(),
      },
    ],

    sourceVersion: 100,
    projectionVersion: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  it('Requirement 1 & 2: Persists search documents and survives simulated process restart', async () => {
    await store.indexDocument(sampleDoc1);
    await store.indexDocument(sampleDoc2);

    expect(await store.count()).toBe(2);

    // Simulate process restart: create a new SqlSearchStore instance over the exact same db connection
    const restartedStore = new SqlSearchStore(db);
    expect(await restartedStore.count()).toBe(2);

    const doc1 = await restartedStore.getDocument('prod-101');
    expect(doc1).not.toBeNull();
    expect(doc1!.title).toBe('Sony WH-1000XM5 Wireless Headphones');
    expect(doc1!.offers).toHaveLength(2);
    expect(doc1!.minPrice).toBe(24999);
    expect(doc1!.hasInStockOffer).toBe(true);

    const listingProductId = await restartedStore.findProductIdByListingId('list-sony-apex');
    expect(listingProductId).toBe('prod-101');
  });

  it('Requirement 3: Multi-instance behavior: multiple instances observe the identical shared search index', async () => {
    const instanceA = new SqlSearchStore(db);
    const instanceB = new SqlSearchStore(db);

    await instanceA.indexDocument(sampleDoc1);

    // Instance B immediately sees what Instance A indexed
    const docFromB = await instanceB.getDocument('prod-101');
    expect(docFromB).not.toBeNull();
    expect(docFromB!.brand).toBe('Sony');

    const searchFromB = await instanceB.search({ q: 'Sony', inStock: true });
    expect(searchFromB.total).toBe(1);
    expect(searchFromB.items[0]!.id).toBe('prod-101');
  });

  it('Requirement 4: Inventory synchronization updates search seller offer stock and available quantity', async () => {
    await store.indexDocument(sampleDoc1);

    // Simulate inventory update: stock for apex listing drops to 0
    const updatedDoc1: SearchProductDocument = {
      ...sampleDoc1,
      hasInStockOffer: true, // stellar still has stock
      offers: sampleDoc1.offers.map((o) =>
        o.listingId === 'list-sony-apex'
          ? { ...o, inStock: false, availableQuantity: 0, sourceVersion: 105 }
          : o,
      ),
      sourceVersion: 105,
      projectionVersion: 2,
    };

    await store.indexDocument(updatedDoc1);

    const fetched = await store.getDocument('prod-101');
    expect(fetched).not.toBeNull();
    const apexOffer = fetched!.offers.find((o) => o.listingId === 'list-sony-apex');
    expect(apexOffer!.inStock).toBe(false);
    expect(apexOffer!.availableQuantity).toBe(0);

    // If both listings go out of stock
    const oosDoc: SearchProductDocument = {
      ...updatedDoc1,
      hasInStockOffer: false,
      offers: updatedDoc1.offers.map((o) => ({ ...o, inStock: false, availableQuantity: 0 })),
      sourceVersion: 110,
      projectionVersion: 3,
    };
    await store.indexDocument(oosDoc);

    // Query with inStock: true filter should now exclude prod-101
    const inStockSearch = await store.search({ inStock: true });
    expect(inStockSearch.items.some((i) => i.id === 'prod-101')).toBe(false);
  });

  it('Requirement 5: Atomic zero-downtime rebuild replaces projections without dropping readers', async () => {
    await store.indexDocument(sampleDoc1);
    const initialGen = await store.getActiveGeneration();
    expect(initialGen).toBe(1);

    // Perform atomic replaceProjection with both products
    await store.replaceProjection([sampleDoc1, sampleDoc2]);

    const nextGen = await store.getActiveGeneration();
    expect(nextGen).toBe(2);

    expect(await store.count()).toBe(2);
    const doc2 = await store.getDocument('prod-102');
    expect(doc2).not.toBeNull();
    expect(doc2!.title).toContain('MacBook');
  });

  it('Requirement 6: Rebuild race protection: newer event version (v150) is never overwritten by older rebuild version (v100)', async () => {
    // 1. Initial document at version 100
    await store.indexDocument(sampleDoc1);

    // 2. An in-flight event updates prod-101 to v150 (e.g. price update to 22999)
    const inFlightUpdatedDoc: SearchProductDocument = {
      ...sampleDoc1,
      minPrice: 22999,
      offers: sampleDoc1.offers.map((o) =>
        o.listingId === 'list-sony-apex'
          ? { ...o, priceAmount: 22999, sourceVersion: 150 }
          : o,
      ),
      sourceVersion: 150,
      projectionVersion: 2,
    };
    await store.indexDocument(inFlightUpdatedDoc);

    // 3. A concurrent rebuild job that had read old snapshot at version 100 finishes now
    // and calls replaceProjection with the old snapshot
    await store.replaceProjection([sampleDoc1]);

    // 4. Verify: the newer version (v150) and updated price was preserved by version reconciliation!
    const reconciledDoc = await store.getDocument('prod-101');
    expect(reconciledDoc).not.toBeNull();
    expect(reconciledDoc!.sourceVersion).toBe(150);
    const apexOffer = reconciledDoc!.offers.find((o) => o.listingId === 'list-sony-apex');
    expect(apexOffer!.priceAmount).toBe(22999);
    expect(apexOffer!.sourceVersion).toBe(150);
  });

  it('Requirement 7: Deletion and clear cleans up persistent records', async () => {
    await store.bulkIndex([sampleDoc1, sampleDoc2]);
    expect(await store.count()).toBe(2);

    const deleted = await store.deleteDocument('prod-101');
    expect(deleted).toBe(true);
    expect(await store.getDocument('prod-101')).toBeNull();
    expect(await store.count()).toBe(1);

    await store.clear();
    expect(await store.count()).toBe(0);
  });

  it('Requirement 8: Health check accurately reflects persistent store status', async () => {
    await store.indexDocument(sampleDoc1);
    const health = await store.healthCheck();
    expect(health.status).toBe('healthy');
    expect(health.count).toBe(1);
    expect(health.engine).toBe('postgresql-shared-projection');
  });
});
