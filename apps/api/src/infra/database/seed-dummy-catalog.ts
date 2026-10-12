/**
 * Manual catalog seed from a DummyJSON-style `data.json` file.
 *
 * REPLACES the current catalog (categories, products, SKUs, listings,
 * inventory, reviews, search projections) with the file's products.
 * Identity (tenants/users) and finance books are left untouched.
 *
 * NOT auto-run: invoke explicitly with:
 *
 *   npm run seed:dummy-catalog -- --data ../../data.json
 *
 * (run from apps/api; --data defaults to ../../data.json)
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';
import type { DatabaseConnection } from './connection.js';
import { PostgresPoolConnection } from './connection.js';
import { MigrationRunner } from './migrations/runner.js';
import { getConfig } from '../../config/index.js';
import { JsonLogger } from '../../observability/logger.js';
import type { Logger } from '../../observability/logger.js';

interface DummyReview {
  rating: number;
  comment: string;
  date: string;
  reviewerName: string;
  reviewerEmail: string;
}

interface DummyProduct {
  id: number;
  title: string;
  description: string;
  category: string;
  price: number;
  discountPercentage: number;
  rating: number;
  stock: number;
  tags: string[];
  brand?: string | undefined;
  sku: string;
  weight: number;
  dimensions: { width: number; height: number; depth: number };
  warrantyInformation: string;
  shippingInformation: string;
  availabilityStatus: string;
  reviews: DummyReview[];
  returnPolicy: string;
  minimumOrderQuantity: number;
  meta: { barcode: string };
  images: string[];
  thumbnail: string;
}

const CURRENCY = 'USD';
const MERCHANT_TENANT_ID = 'tenant-merchant-1';
const MERCHANT_NAME = 'Apex Electronics';

function slugify(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

function titleCase(value: string): string {
  return value
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

async function tableExists(db: DatabaseConnection, table: string): Promise<boolean> {
  const res = await db.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.tables WHERE table_name = $1
     ) AS exists`,
    [table],
  );
  return res.rows[0]?.exists === true;
}

export interface SeedDummyCatalogOptions {
  dataPath: string;
  merchantTenantId?: string | undefined;
  logger?: Logger | undefined;
}

export async function seedDummyCatalog(
  db: DatabaseConnection,
  options: SeedDummyCatalogOptions,
): Promise<{ categories: number; products: number; listings: number; reviews: number }> {
  const logger = options.logger;
  const merchantTenantId = options.merchantTenantId ?? MERCHANT_TENANT_ID;

  const raw = readFileSync(resolve(options.dataPath), 'utf-8');
  const parsed: unknown = JSON.parse(raw);
  const products = (parsed as { products: DummyProduct[] }).products;
  if (!Array.isArray(products) || products.length === 0) {
    throw new Error(`No products found in ${options.dataPath}`);
  }
  logger?.info(`Seeding ${products.length} catalog products from ${options.dataPath}`);

  // --- 1. Wipe existing catalog-domain data (dependency order) ---
  const wipeTables = [
    'search_seller_offers',
    'search_product_projections',
    'derived_recommendations',
    'analytics_order_facts',
    'analytics_payment_facts',
    'analytics_fulfillment_facts',
    'analytics_settlement_facts',
    'analytics_catalog_facts',
    'analytics_daily_metrics',
    'return_items',
    'returns',
    'shipment_items',
    'shipments',
    'carrier_webhook_events',
    'payment_refunds',
    'payment_attempts',
    'payment_webhook_events',
    'payment_intents',
    'order_items',
    'seller_orders',
    'customer_orders',
    'checkout_items',
    'checkout_sessions',
    'cart_items',
    'carts',
    'inventory_movements',
    'inventory_reservations',
    'inventory_items',
    'merchant_listings',
    'product_skus',
    'product_reviews',
    'products',
    'categories',
  ];
  for (const table of wipeTables) {
    if (await tableExists(db, table)) {
      await db.query(`DELETE FROM ${table}`);
    }
  }
  if (await tableExists(db, 'search_projection_state')) {
    await db.query(`DELETE FROM search_projection_state`);
  }

  // --- 2. Ensure merchant tenant + profile exist ---
  await db.query(
    `INSERT INTO tenants (id, type, name, status)
     VALUES ($1, 'MERCHANT', $2, 'ACTIVE')
     ON CONFLICT (id) DO NOTHING`,
    [merchantTenantId, MERCHANT_NAME],
  );
  if (await tableExists(db, 'merchant_profiles')) {
    await db.query(
      `INSERT INTO merchant_profiles (id, tenant_id, business_name, legal_name, contact_email, verification_status)
       VALUES ($1, $2, $3, $4, 'merchant@example.com', 'VERIFIED')
       ON CONFLICT (tenant_id) DO NOTHING`,
      [
        `mp-${merchantTenantId}`,
        merchantTenantId,
        MERCHANT_NAME,
        `${MERCHANT_NAME} Retail Pvt Ltd`,
      ],
    );
  }

  // --- 3. Categories: root per `category`, child per distinct sub-tag ---
  // Child tag = last tag unless it merely repeats the root name.
  const rootNames = [...new Set(products.map((p) => p.category))];
  let categoryCount = 0;
  const categoryIdByKey = new Map<string, string>();

  for (const root of rootNames) {
    const rootSlug = slugify(root);
    const rootId = `cat-${rootSlug}`;
    await db.query(
      `INSERT INTO categories (id, name, slug, parent_id)
       VALUES ($1, $2, $3, NULL)
       ON CONFLICT (id) DO NOTHING`,
      [rootId, titleCase(root), rootSlug],
    );
    categoryIdByKey.set(root, rootId);
    categoryCount += 1;
  }

  const childTagsByRoot = new Map<string, Set<string>>();
  for (const p of products) {
    const tags = p.tags ?? [];
    const sub = tags.length > 0 ? tags[tags.length - 1]! : null;
    if (sub && sub.toLowerCase() !== p.category.toLowerCase()) {
      const set = childTagsByRoot.get(p.category) ?? new Set<string>();
      set.add(sub);
      childTagsByRoot.set(p.category, set);
    }
  }
  for (const [root, tags] of childTagsByRoot) {
    const rootId = categoryIdByKey.get(root)!;
    const rootSlug = slugify(root);
    for (const tag of tags) {
      const childSlug = `${rootSlug}-${slugify(tag)}`.slice(0, 60);
      const childId = `cat-${childSlug}`.slice(0, 36);
      await db.query(
        `INSERT INTO categories (id, name, slug, parent_id)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (id) DO NOTHING`,
        [childId, titleCase(tag), childSlug, rootId],
      );
      categoryIdByKey.set(`${root}::${tag}`, childId);
      categoryCount += 1;
    }
  }

  const categoryIdFor = (p: DummyProduct): string => {
    const tags = p.tags ?? [];
    const sub = tags.length > 0 ? tags[tags.length - 1]! : null;
    if (sub && sub.toLowerCase() !== p.category.toLowerCase()) {
      return categoryIdByKey.get(`${p.category}::${sub}`) ?? categoryIdByKey.get(p.category)!;
    }
    return categoryIdByKey.get(p.category)!;
  };

  // --- 4. Products, SKUs, reviews, listings, inventory ---
  const usedSlugs = new Set<string>();
  let reviewTotal = 0;

  for (const p of products) {
    const baseSlug = slugify(p.title) || `product-${p.id}`;
    let slug = baseSlug;
    let suffix = 2;
    while (usedSlugs.has(slug)) {
      slug = `${baseSlug}-${suffix++}`;
    }
    usedSlugs.add(slug);

    const productId = `prod-dummy-${p.id}`;
    const categoryId = categoryIdFor(p);
    const priceMinor = Math.round(p.price * 100);
    const compareAtMinor =
      p.discountPercentage > 0
        ? Math.round((p.price / (1 - p.discountPercentage / 100)) * 100)
        : null;
    const reviewCount = p.reviews?.length ?? 0;

    const productAttributes = {
      tags: p.tags ?? [],
      warrantyInformation: p.warrantyInformation,
      shippingInformation: p.shippingInformation,
      returnPolicy: p.returnPolicy,
      minimumOrderQuantity: p.minimumOrderQuantity,
      availabilityStatus: p.availabilityStatus,
      weight: p.weight,
      dimensions: p.dimensions,
    };

    await db.query(
      `INSERT INTO products
         (id, title, slug, description, brand, category_id, status,
          thumbnail_url, images, rating, review_count, attributes)
       VALUES ($1, $2, $3, $4, $5, $6, 'ACTIVE', $7, $8, $9, $10, $11)
       ON CONFLICT (id) DO NOTHING`,
      [
        productId,
        p.title,
        slug,
        p.description,
        p.brand ?? null,
        categoryId,
        p.thumbnail,
        JSON.stringify(p.images ?? []),
        p.rating ?? null,
        reviewCount,
        JSON.stringify(productAttributes),
      ],
    );

    const skuId = `sku-dummy-${p.id}`;
    await db.query(
      `INSERT INTO product_skus (id, product_id, sku_code, barcode, attributes, status)
       VALUES ($1, $2, $3, $4, $5, 'ACTIVE')
       ON CONFLICT (id) DO NOTHING`,
      [
        skuId,
        productId,
        p.sku,
        p.meta?.barcode ?? null,
        JSON.stringify({ weight: p.weight, dimensions: p.dimensions }),
      ],
    );

    for (let i = 0; i < (p.reviews ?? []).length; i++) {
      const r = p.reviews[i]!;
      await db.query(
        `INSERT INTO product_reviews
           (id, product_id, rating, comment, reviewer_name, reviewer_email, reviewed_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (id) DO NOTHING`,
        [
          `rev-dummy-${p.id}-${i}`,
          productId,
          r.rating,
          r.comment ?? null,
          r.reviewerName ?? null,
          r.reviewerEmail ?? null,
          r.date ?? null,
        ],
      );
      reviewTotal += 1;
    }

    const listingId = `list-dummy-${p.id}`;
    await db.query(
      `INSERT INTO merchant_listings (id, tenant_id, sku_id, price_amount, currency, compare_at_price, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'ACTIVE')
       ON CONFLICT (id) DO NOTHING`,
      [listingId, merchantTenantId, skuId, priceMinor, CURRENCY, compareAtMinor],
    );

    await db.query(
      `INSERT INTO inventory_items
         (id, tenant_id, listing_id, sku_id, on_hand_quantity, reserved_quantity, non_sellable_quantity, version)
       VALUES ($1, $2, $3, $4, $5, 0, 0, 1)
       ON CONFLICT (listing_id) DO NOTHING`,
      [`inv-dummy-${p.id}`, merchantTenantId, listingId, skuId, Math.max(0, p.stock ?? 0)],
    );
  }

  // --- 5. Search projections (generation 1, like the demo seed) ---
  await db.query(
    `INSERT INTO search_projection_state (id, active_generation, updated_at)
     VALUES ('global', 1, CURRENT_TIMESTAMP)
     ON CONFLICT (id) DO NOTHING`,
  );

  for (const p of products) {
    const productId = `prod-dummy-${p.id}`;
    const categoryId = categoryIdFor(p);
    const prodRes = await db.query<{ name: string; slug: string }>(
      `SELECT c.name, p.slug FROM products p JOIN categories c ON c.id = p.category_id WHERE p.id = $1`,
      [productId],
    );
    const priceMinor = Math.round(p.price * 100);
    const compareAtMinor =
      p.discountPercentage > 0
        ? Math.round((p.price / (1 - p.discountPercentage / 100)) * 100)
        : null;
    const skuId = `sku-dummy-${p.id}`;
    const listingId = `list-dummy-${p.id}`;
    const inStock = (p.stock ?? 0) > 0;
    const productAttributes = {
      tags: p.tags ?? [],
      warrantyInformation: p.warrantyInformation,
      shippingInformation: p.shippingInformation,
      returnPolicy: p.returnPolicy,
      minimumOrderQuantity: p.minimumOrderQuantity,
      availabilityStatus: p.availabilityStatus,
      weight: p.weight,
      dimensions: p.dimensions,
      thumbnailUrl: p.thumbnail ?? null,
      images: p.images ?? [],
      rating: p.rating ?? null,
      reviewCount: p.reviews?.length ?? 0,
    };

    await db.query(
      `INSERT INTO search_product_projections (
         id, generation, title, slug, description, brand, category_id, category_name,
         status, min_price, max_price, currency, has_in_stock_offer, total_offers_count,
         attributes, source_version, projection_version
       )
       VALUES (
         $1, 1, $2, $3, $4, $5, $6, $7, 'ACTIVE', $8, $8, $9, $10, 1,
         $11::jsonb, 1, 1
       )
       ON CONFLICT (id, generation) DO NOTHING`,
      [
        productId,
        p.title,
        prodRes.rows[0]?.slug ?? slugify(p.title),
        p.description,
        p.brand ?? null,
        categoryId,
        prodRes.rows[0]?.name ?? p.category,
        priceMinor,
        CURRENCY,
        inStock,
        JSON.stringify(productAttributes),
      ],
    );

    await db.query(
      `INSERT INTO search_seller_offers (
         listing_id, generation, product_id, merchant_id, merchant_name, sku_id, sku_code,
         price_amount, currency, compare_at_price, status, in_stock, available_quantity,
         attributes, source_version
       )
       VALUES ($1, 1, $2, $3, $4, $5, $6, $7, $8, $9, 'ACTIVE', $10, $11, '{}'::jsonb, 1)
       ON CONFLICT (listing_id, generation) DO NOTHING`,
      [
        listingId,
        productId,
        merchantTenantId,
        MERCHANT_NAME,
        skuId,
        p.sku,
        priceMinor,
        CURRENCY,
        compareAtMinor,
        inStock,
        Math.max(0, p.stock ?? 0),
      ],
    );
  }

  logger?.info('Dummy catalog seed complete', {
    categories: categoryCount,
    products: products.length,
    listings: products.length,
    reviews: reviewTotal,
  });

  return {
    categories: categoryCount,
    products: products.length,
    listings: products.length,
    reviews: reviewTotal,
  };
}

// --- CLI entrypoint: `npx tsx src/infra/database/seed-dummy-catalog.ts [--data path]` ---
const invokedAsCli =
  typeof process.argv[1] === 'string' && process.argv[1].endsWith('seed-dummy-catalog.ts');

if (invokedAsCli) {
  const args = process.argv.slice(2);
  const dataFlag = args.indexOf('--data');
  const dataPath =
    dataFlag >= 0 && args[dataFlag + 1] ? resolve(args[dataFlag + 1]!) : resolve('../../data.json');

  const run = async (): Promise<void> => {
    const config = getConfig();
    const logger = new JsonLogger({
      serviceName: config.observability.serviceName,
      level: config.app.logLevel,
      pretty: config.observability.logPretty,
      redactKeys: config.observability.redactKeys,
    });

    if (!config.postgres.password || config.postgres.password === 'placeholder_postgres_password') {
      logger.fatal('Refusing to seed: no real database configured (placeholder credentials).');
      process.exit(1);
    }

    const db = new PostgresPoolConnection(config.postgres);
    try {
      const runner = new MigrationRunner(resolve('src/infra/database/migrations'));
      const applied = await runner.up(db);
      logger.info(`Migrations up to date (applied ${applied.length} pending).`);

      const summary = await seedDummyCatalog(db, { dataPath, logger });
      logger.info(
        `Seeded ${summary.products} products in ${summary.categories} categories ` +
          `with ${summary.listings} listings and ${summary.reviews} reviews.`,
      );
    } catch (err) {
      logger.fatal('Dummy catalog seed failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      process.exit(1);
    } finally {
      await db.close();
    }
  };

  void run();
}
