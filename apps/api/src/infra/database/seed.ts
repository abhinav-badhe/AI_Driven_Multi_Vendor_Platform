import type { DatabaseConnection } from './connection.js';
import { ScryptPasswordHasher } from '../../modules/identity/index.js';
import type { Logger } from '../../observability/logger.js';

export async function seedDemoData(db: DatabaseConnection, logger?: Logger): Promise<void> {
  const hasher = new ScryptPasswordHasher();
  const defaultPasswordHash = await hasher.hash('password123');

  logger?.info('Seeding initial marketplace catalog and demo users...');

  // 1. Tenants
  await db.query(`
    INSERT INTO tenants (id, type, name, status) VALUES
      ('tenant-platform', 'PLATFORM', 'Platform Admin', 'ACTIVE'),
      ('tenant-merchant-1', 'MERCHANT', 'Apex Electronics', 'ACTIVE'),
      ('tenant-customer-1', 'CUSTOMER', 'Demo Customer', 'ACTIVE')
    ON CONFLICT (id) DO NOTHING;
  `);

  // 2. Users
  await db.query(`
    INSERT INTO users (id, email, password_hash, status) VALUES
      ('user-admin-1', 'admin@example.com', $1, 'ACTIVE'),
      ('user-merchant-1', 'merchant@example.com', $1, 'ACTIVE'),
      ('user-customer-1', 'customer@example.com', $1, 'ACTIVE')
    ON CONFLICT (email) DO NOTHING;
  `, [defaultPasswordHash]);

  // 3. Tenant Memberships
  await db.query(`
    INSERT INTO tenant_memberships (id, tenant_id, user_id, role, status) VALUES
      ('mem-admin-1', 'tenant-platform', 'user-admin-1', 'ADMINISTRATOR', 'ACTIVE'),
      ('mem-merchant-1', 'tenant-merchant-1', 'user-merchant-1', 'MERCHANT', 'ACTIVE'),
      ('mem-customer-1', 'tenant-customer-1', 'user-customer-1', 'CUSTOMER', 'ACTIVE')
    ON CONFLICT (tenant_id, user_id) DO NOTHING;
  `);

  // 4. Merchant Profile
  await db.query(`
    INSERT INTO merchant_profiles (id, tenant_id, business_name, legal_name, contact_email, verification_status) VALUES
      ('mp-apex-1', 'tenant-merchant-1', 'Apex Electronics', 'Apex Electronics Retail Pvt Ltd', 'merchant@example.com', 'VERIFIED')
    ON CONFLICT (tenant_id) DO NOTHING;
  `);

  // 5. Categories
  await db.query(`
    INSERT INTO categories (id, name, slug, parent_id) VALUES
      ('cat-electronics', 'Electronics', 'electronics', NULL),
      ('cat-smartphones', 'Smartphones', 'smartphones', 'cat-electronics'),
      ('cat-laptops', 'Laptops & Computers', 'laptops-computers', 'cat-electronics'),
      ('cat-audio', 'Headphones & Audio', 'headphones-audio', 'cat-electronics'),
      ('cat-wearables', 'Smartwatches & Wearables', 'wearables', 'cat-electronics')
    ON CONFLICT (id) DO NOTHING;
  `);

  // 6. Products
  const products = [
    {
      id: 'prod-iphone-15',
      title: 'Apple iPhone 15 Pro',
      slug: 'apple-iphone-15-pro',
      description: 'Aerospace-grade titanium design with A17 Pro chip and customizable Action button.',
      brand: 'Apple',
      categoryId: 'cat-smartphones',
      status: 'ACTIVE',
    },
    {
      id: 'prod-macbook-pro',
      title: 'Apple MacBook Pro 16"',
      slug: 'apple-macbook-pro-16',
      description: 'M3 Pro chip with 12-core CPU and 18-core GPU. Liquid Retina XDR display.',
      brand: 'Apple',
      categoryId: 'cat-laptops',
      status: 'ACTIVE',
    },
    {
      id: 'prod-sony-wh1000',
      title: 'Sony WH-1000XM5 Wireless Headphones',
      slug: 'sony-wh-1000xm5',
      description: 'Industry-leading noise cancellation optimized by two processors and 8 microphones.',
      brand: 'Sony',
      categoryId: 'cat-audio',
      status: 'ACTIVE',
    },
    {
      id: 'prod-galaxy-s24',
      title: 'Samsung Galaxy S24 Ultra',
      slug: 'samsung-galaxy-s24-ultra',
      description: 'Galaxy AI is here. Epic camera with 100x Space Zoom and titanium frame.',
      brand: 'Samsung',
      categoryId: 'cat-smartphones',
      status: 'ACTIVE',
    },
    {
      id: 'prod-dell-xps15',
      title: 'Dell XPS 15 OLED Laptop',
      slug: 'dell-xps-15-oled',
      description: '15.6-inch 3.5K OLED InfinityEdge touch display with Intel Core i7 processor.',
      brand: 'Dell',
      categoryId: 'cat-laptops',
      status: 'ACTIVE',
    },
    {
      id: 'prod-watch-ultra',
      title: 'Apple Watch Ultra 2 GPS + Cellular',
      slug: 'apple-watch-ultra-2',
      description: 'Rugged titanium case with precision dual-frequency GPS and 36-hour battery life.',
      brand: 'Apple',
      categoryId: 'cat-wearables',
      status: 'ACTIVE',
    },
  ];

  for (const p of products) {
    await db.query(`
      INSERT INTO products (id, title, slug, description, brand, category_id, status)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (id) DO NOTHING;
    `, [p.id, p.title, p.slug, p.description, p.brand, p.categoryId, p.status]);
  }

  // 7. Product SKUs
  const skus = [
    { id: 'sku-iphone-15-blk', productId: 'prod-iphone-15', skuCode: 'IPHONE-15-PRO-BLK', barcode: '195949012345' },
    { id: 'sku-mbp-16-space', productId: 'prod-macbook-pro', skuCode: 'MBP-16-M3-SPACE', barcode: '195949067890' },
    { id: 'sku-sony-xm5-blk', productId: 'prod-sony-wh1000', skuCode: 'SONY-WH1000XM5-BLK', barcode: '027242923456' },
    { id: 'sku-s24-ultra-gry', productId: 'prod-galaxy-s24', skuCode: 'GALAXY-S24U-GRY', barcode: '887276812345' },
    { id: 'sku-dell-xps15-slv', productId: 'prod-dell-xps15', skuCode: 'DELL-XPS15-SLV', barcode: '884116412345' },
    { id: 'sku-watch-ultra-2', productId: 'prod-watch-ultra', skuCode: 'AW-ULTRA-2-TITANIUM', barcode: '195949098765' },
  ];

  for (const s of skus) {
    await db.query(`
      INSERT INTO product_skus (id, product_id, sku_code, barcode, status)
      VALUES ($1, $2, $3, $4, 'ACTIVE')
      ON CONFLICT (id) DO NOTHING;
    `, [s.id, s.productId, s.skuCode, s.barcode]);
  }

  // 8. Merchant Listings
  const listings = [
    {
      id: 'list-iphone-1',
      skuId: 'sku-iphone-15-blk',
      priceAmount: 12990000, // 129,900.00 INR in minor units
      compareAtPrice: 13490000,
      stock: 25,
    },
    {
      id: 'list-mbp-1',
      skuId: 'sku-mbp-16-space',
      priceAmount: 24990000,
      compareAtPrice: 26990000,
      stock: 15,
    },
    {
      id: 'list-sony-1',
      skuId: 'sku-sony-xm5-blk',
      priceAmount: 2999000,
      compareAtPrice: 3499000,
      stock: 40,
    },
    {
      id: 'list-s24-1',
      skuId: 'sku-s24-ultra-gry',
      priceAmount: 11990000,
      compareAtPrice: 12990000,
      stock: 30,
    },
    {
      id: 'list-dell-1',
      skuId: 'sku-dell-xps15-slv',
      priceAmount: 18990000,
      compareAtPrice: 20990000,
      stock: 18,
    },
    {
      id: 'list-watch-ultra-1',
      skuId: 'sku-watch-ultra-2',
      priceAmount: 8990000,
      compareAtPrice: 9490000,
      stock: 22,
    },
  ];

  for (const l of listings) {
    await db.query(`
      INSERT INTO merchant_listings (id, tenant_id, sku_id, price_amount, currency, compare_at_price, status)
      VALUES ($1, 'tenant-merchant-1', $2, $3, 'INR', $4, 'ACTIVE')
      ON CONFLICT (id) DO NOTHING;
    `, [l.id, l.skuId, l.priceAmount, l.compareAtPrice]);

    // Inventory items
    await db.query(`
      INSERT INTO inventory_items (id, tenant_id, listing_id, sku_id, on_hand_quantity, reserved_quantity, non_sellable_quantity, version)
      VALUES ($1, 'tenant-merchant-1', $2, $3, $4, 0, 0, 1)
      ON CONFLICT (listing_id) DO NOTHING;
    `, [`inv-${l.id}`, l.id, l.skuId, l.stock]);
  }

  // 9. Search Projection State & Projections
  await db.query(`
    INSERT INTO search_projection_state (id, active_generation, updated_at)
    VALUES ('global', 1, CURRENT_TIMESTAMP)
    ON CONFLICT (id) DO NOTHING;
  `);

  const categoryMap: Record<string, string> = {
    'cat-smartphones': 'Smartphones',
    'cat-laptops': 'Laptops & Computers',
    'cat-audio': 'Headphones & Audio',
    'cat-wearables': 'Smartwatches & Wearables',
  };

  for (let i = 0; i < products.length; i++) {
    const p = products[i];
    const l = listings[i];
    const s = skus[i];
    if (!p || !l || !s) continue;

    // Search product projection
    await db.query(`
      INSERT INTO search_product_projections (
        id, generation, title, slug, description, brand, category_id, category_name,
        status, min_price, max_price, currency, has_in_stock_offer, total_offers_count,
        attributes, source_version, projection_version
      )
      VALUES ($1, 1, $2, $3, $4, $5, $6, $7, 'ACTIVE', $8, $8, 'INR', true, 1, '{}'::jsonb, 1, 1)
      ON CONFLICT (id, generation) DO NOTHING;
    `, [p.id, p.title, p.slug, p.description, p.brand, p.categoryId, categoryMap[p.categoryId] ?? 'Electronics', l.priceAmount]);

    // Search seller offer
    await db.query(`
      INSERT INTO search_seller_offers (
        listing_id, generation, product_id, merchant_id, merchant_name, sku_id, sku_code,
        price_amount, currency, compare_at_price, status, in_stock, available_quantity,
        attributes, source_version
      )
      VALUES ($1, 1, $2, 'tenant-merchant-1', 'Apex Electronics', $3, $4, $5, 'INR', $6, 'ACTIVE', true, $7, '{}'::jsonb, 1)
      ON CONFLICT (listing_id, generation) DO NOTHING;
    `, [l.id, p.id, s.id, s.skuCode, l.priceAmount, l.compareAtPrice, l.stock]);
  }

  logger?.info('Successfully seeded demo catalog, merchants, and search projections.');
}
