import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createIsolatedTestDatabase } from './helpers/test-db.js';
import type { DatabaseConnection } from '../src/infra/database/connection.js';
import type { MigrationRunner } from '../src/infra/database/migrations/runner.js';

describe('Database Migrations (PostgreSQL Engine)', () => {
  let db: DatabaseConnection;
  let runner: MigrationRunner;

  beforeEach(async () => {
    const context = await createIsolatedTestDatabase();
    db = context.db;
    runner = context.runner;
  });

  afterEach(async () => {
    await db.close();
  });

  it('applies migrations forward in deterministic order on a clean database', async () => {
    const initialStatus = await runner.getStatus(db);
    expect(initialStatus.applied.length).toBe(0);
    expect(initialStatus.pending.length).toBe(28);
    expect(initialStatus.pending[0]).toContain('0001_identity_schema.sql');
    expect(initialStatus.pending[1]).toContain('0002_merchant_schema.sql');
    expect(initialStatus.pending[2]).toContain('0003_catalog_and_listings_schema.sql');
    expect(initialStatus.pending[3]).toContain('0004_inventory_schema.sql');
    expect(initialStatus.pending[4]).toContain('0005_cart_and_checkout_schema.sql');
    expect(initialStatus.pending[5]).toContain('0006_orders_and_payments_schema.sql');
    expect(initialStatus.pending[6]).toContain('0007_fulfillment_and_returns_schema.sql');
    expect(initialStatus.pending[7]).toContain('0008_settlement_and_ledger_schema.sql');
    expect(initialStatus.pending[8]).toContain('0009_events_and_notifications_schema.sql');
    expect(initialStatus.pending[9]).toContain('0010_analytics_schema.sql');
    expect(initialStatus.pending[10]).toContain('0011_recommendations_schema.sql');
    expect(initialStatus.pending[11]).toContain('0012_predictive_ml_schema.sql');
    expect(initialStatus.pending[12]).toContain('0013_ai_and_rag_schema.sql');
    expect(initialStatus.pending[13]).toContain('0014_financial_transactions_and_account_types.sql');
    expect(initialStatus.pending[14]).toContain('0015_search_projections_schema.sql');
    expect(initialStatus.pending[15]).toContain('0016_product_content_and_reviews_schema.sql');
    expect(initialStatus.pending[16]).toContain('0017_email_verification_schema.sql');
    expect(initialStatus.pending[17]).toContain('0018_price_watches_schema.sql');
    expect(initialStatus.pending[18]).toContain('0019_anomaly_prediction_entity_schema.sql');
    expect(initialStatus.pending[19]).toContain('0020_carrier_shipment_enhancements.sql');
    expect(initialStatus.pending[20]).toContain('0021_promotions_and_coupons_schema.sql');
    expect(initialStatus.pending[21]).toContain('0022_customer_addresses_and_order_snapshots.sql');
    expect(initialStatus.pending[22]).toContain('0023_product_reviews_and_moderation.sql');
    expect(initialStatus.pending[23]).toContain('0024_customer_wishlist.sql');
    expect(initialStatus.pending[24]).toContain('0025_back_in_stock_subscriptions.sql');
    expect(initialStatus.pending[25]).toContain('0026_two_factor_auth_schema.sql');
    expect(initialStatus.pending[26]).toContain('0027_promotional_banners_schema.sql');
    expect(initialStatus.pending[27]).toContain('0028_password_reset_schema.sql');

    const applied = await runner.up(db);
    expect(applied.length).toBe(28);

    const afterStatus = await runner.getStatus(db);
    expect(afterStatus.applied.length).toBe(28);
    expect(afterStatus.pending.length).toBe(0);
  });

  it('is idempotent when up is called multiple times', async () => {
    await runner.up(db);
    const secondRun = await runner.up(db);
    expect(secondRun.length).toBe(0);
  });

  it('enforces table constraints and foreign keys created by migrations', async () => {
    await runner.up(db);

    // Verify foreign key constraint on tenant_memberships
    await expect(
      db.query(
        `INSERT INTO tenant_memberships (id, tenant_id, user_id, role, status)
         VALUES ('m-1', 'non-existent-tenant', 'non-existent-user', 'MERCHANT', 'ACTIVE')`,
      ),
    ).rejects.toThrow();

    // Insert valid tenant and user
    await db.query(`
      INSERT INTO tenants (id, type, name, status)
      VALUES ('t-1', 'MERCHANT', 'Acme Corp', 'ACTIVE');
    `);
    await db.query(`
      INSERT INTO users (id, email, password_hash, status)
      VALUES ('u-1', 'acme@example.com', 'dummyhash', 'ACTIVE');
    `);

    // Now insert valid membership
    await db.query(`
      INSERT INTO tenant_memberships (id, tenant_id, user_id, role, status)
      VALUES ('m-1', 't-1', 'u-1', 'MERCHANT', 'ACTIVE');
    `);

    // Duplicate membership should fail unique constraint
    await expect(
      db.query(`
        INSERT INTO tenant_memberships (id, tenant_id, user_id, role, status)
        VALUES ('m-2', 't-1', 'u-1', 'MERCHANT', 'ACTIVE');
      `),
    ).rejects.toThrow();

    // Phase 3 constraint checks:
    // Insert category
    await db.query(`
      INSERT INTO categories (id, name, slug)
      VALUES ('cat-1', 'Electronics', 'electronics');
    `);

    // Insert product
    await db.query(`
      INSERT INTO products (id, title, slug, brand, category_id, status)
      VALUES ('prod-1', 'Smartphone Pro', 'smartphone-pro', 'BrandX', 'cat-1', 'ACTIVE');
    `);

    // Insert SKU
    await db.query(`
      INSERT INTO product_skus (id, product_id, sku_code, barcode, status)
      VALUES ('sku-1', 'prod-1', 'SP-PRO-128', 'BAR123', 'ACTIVE');
    `);

    // Duplicate SKU code should fail unique constraint
    await expect(
      db.query(`
        INSERT INTO product_skus (id, product_id, sku_code, barcode, status)
        VALUES ('sku-2', 'prod-1', 'SP-PRO-128', 'BAR456', 'ACTIVE');
      `),
    ).rejects.toThrow();

    // Insert listing for merchant t-1
    await db.query(`
      INSERT INTO merchant_listings (id, tenant_id, sku_id, price_amount, currency, status)
      VALUES ('list-1', 't-1', 'sku-1', 49999, 'INR', 'ACTIVE');
    `);

    // Duplicate listing for same merchant and same SKU must fail unique constraint
    await expect(
      db.query(`
        INSERT INTO merchant_listings (id, tenant_id, sku_id, price_amount, currency, status)
        VALUES ('list-2', 't-1', 'sku-1', 52999, 'INR', 'ACTIVE');
      `),
    ).rejects.toThrow();

    // Foreign key to non-existent SKU must fail
    await expect(
      db.query(`
        INSERT INTO merchant_listings (id, tenant_id, sku_id, price_amount, currency, status)
        VALUES ('list-3', 't-1', 'sku-nonexistent', 49999, 'INR', 'ACTIVE');
      `),
    ).rejects.toThrow();

    // Phase 4 constraint checks:
    // Insert valid inventory item for list-1
    await db.query(`
      INSERT INTO inventory_items (id, tenant_id, listing_id, sku_id, on_hand_quantity, reserved_quantity, non_sellable_quantity)
      VALUES ('inv-1', 't-1', 'list-1', 'sku-1', 10, 2, 1);
    `);

    // Duplicate inventory for same listing must fail unique constraint
    await expect(
      db.query(`
        INSERT INTO inventory_items (id, tenant_id, listing_id, sku_id, on_hand_quantity, reserved_quantity, non_sellable_quantity)
        VALUES ('inv-2', 't-1', 'list-1', 'sku-1', 5, 0, 0);
      `),
    ).rejects.toThrow();

    // Reserved quantity exceeding on-hand must fail CHECK constraint
    await expect(
      db.query(`
        INSERT INTO inventory_items (id, tenant_id, listing_id, sku_id, on_hand_quantity, reserved_quantity, non_sellable_quantity)
        VALUES ('inv-bad-1', 't-1', 'list-nonexistent', 'sku-1', 5, 10, 0);
      `),
    ).rejects.toThrow();

    // Negative availability (on_hand - reserved - non_sellable < 0) must fail CHECK constraint
    await expect(
      db.query(`
        INSERT INTO inventory_items (id, tenant_id, listing_id, sku_id, on_hand_quantity, reserved_quantity, non_sellable_quantity)
        VALUES ('inv-bad-2', 't-1', 'list-nonexistent', 'sku-1', 10, 8, 5);
      `),
    ).rejects.toThrow();

    // Reservation for non-existent inventory must fail FK constraint
    await expect(
      db.query(`
        INSERT INTO inventory_reservations (id, inventory_id, tenant_id, quantity, status)
        VALUES ('res-1', 'inv-nonexistent', 't-1', 5, 'ACTIVE');
      `),
    ).rejects.toThrow();

    // Phase 5 Cart and Checkout Constraints
    await db.query(`
      INSERT INTO carts (id, tenant_id, status)
      VALUES ('cart-1', 't-1', 'ACTIVE');
    `);

    // Duplicate cart for same tenant must fail unique constraint
    await expect(
      db.query(`
        INSERT INTO carts (id, tenant_id, status)
        VALUES ('cart-2', 't-1', 'ACTIVE');
      `),
    ).rejects.toThrow();

    // Cart item with non-positive quantity must fail CHECK constraint
    await expect(
      db.query(`
        INSERT INTO cart_items (id, cart_id, listing_id, sku_id, merchant_tenant_id, quantity)
        VALUES ('ci-bad-1', 'cart-1', 'list-1', 'sku-1', 't-1', 0);
      `),
    ).rejects.toThrow();

    // Valid cart item
    await db.query(`
      INSERT INTO cart_items (id, cart_id, listing_id, sku_id, merchant_tenant_id, quantity)
      VALUES ('ci-1', 'cart-1', 'list-1', 'sku-1', 't-1', 2);
    `);

    // Duplicate listing in same cart must fail unique constraint
    await expect(
      db.query(`
        INSERT INTO cart_items (id, cart_id, listing_id, sku_id, merchant_tenant_id, quantity)
        VALUES ('ci-dup', 'cart-1', 'list-1', 'sku-1', 't-1', 1);
      `),
    ).rejects.toThrow();

    // Checkout session with invalid status must fail CHECK constraint
    await expect(
      db.query(`
        INSERT INTO checkout_sessions (id, cart_id, customer_tenant_id, status, currency, expires_at)
        VALUES ('cs-bad-status', 'cart-1', 't-1', 'INVALID_STATUS', 'INR', CURRENT_TIMESTAMP);
      `),
    ).rejects.toThrow();

    // Phase 6 constraint checks:
    // Customer Order with invalid status must fail CHECK constraint
    await expect(
      db.query(`
        INSERT INTO customer_orders (id, customer_tenant_id, checkout_session_id, status, currency, subtotal_amount, total_amount)
        VALUES ('ord-bad-status', 't-1', 'cs-1', 'INVALID_STATUS', 'INR', 1000, 1000);
      `),
    ).rejects.toThrow();

    // Payment Intent with non-positive amount must fail CHECK constraint
    await expect(
      db.query(`
        INSERT INTO payment_intents (id, customer_tenant_id, checkout_session_id, amount, currency, provider, client_secret)
        VALUES ('pi-bad-amount', 't-1', 'cs-1', 0, 'INR', 'mock', 'secret');
      `),
    ).rejects.toThrow();

    // Duplicate webhook provider_event_id must fail unique constraint
    await db.query(`
      INSERT INTO payment_webhook_events (id, provider, provider_event_id, event_type, payload)
      VALUES ('wh-1', 'mock', 'evt-100', 'payment.succeeded', '{"test": true}'::jsonb);
    `);
    await expect(
      db.query(`
        INSERT INTO payment_webhook_events (id, provider, provider_event_id, event_type, payload)
        VALUES ('wh-2', 'mock', 'evt-100', 'payment.succeeded', '{"test": true}'::jsonb);
      `),
    ).rejects.toThrow();

    // Phase 8 constraint checks:
    // Financial account invalid currency must fail CHECK constraint
    await expect(
      db.query(`
        INSERT INTO financial_accounts (id, tenant_id, currency, current_balance)
        VALUES ('acc-bad-curr', 't-1', 'INVALID', 0);
      `),
    ).rejects.toThrow();

    // Valid financial account
    await db.query(`
      INSERT INTO financial_accounts (id, tenant_id, currency, current_balance)
      VALUES ('acc-1', 't-1', 'INR', 0);
    `);

    // Duplicate account for same tenant and currency must fail unique constraint
    await expect(
      db.query(`
        INSERT INTO financial_accounts (id, tenant_id, currency, current_balance)
        VALUES ('acc-dup', 't-1', 'INR', 0);
      `),
    ).rejects.toThrow();

    // Ledger entry with non-positive amount must fail CHECK constraint
    await expect(
      db.query(`
        INSERT INTO ledger_entries (
          id, tenant_id, account_id, entry_type, direction, amount, currency,
          source_type, source_id, description, actor_id, actor_type
        ) VALUES (
          'le-bad-amt', 't-1', 'acc-1', 'EARNING', 'CREDIT', 0, 'INR',
          'ORDER', 'so-1', 'Bad amount', 'sys', 'SYSTEM'
        );
      `),
    ).rejects.toThrow();

    // Settlement with invalid status must fail CHECK constraint
    await expect(
      db.query(`
        INSERT INTO settlements (
          id, tenant_id, period_start, period_end, currency, status
        ) VALUES (
          'set-bad-status', 't-1', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 'INR', 'INVALID_STATUS'
        );
      `),
    ).rejects.toThrow();

    // 0009: Outbox event with invalid status must fail CHECK constraint
    await expect(
      db.query(`
        INSERT INTO outbox_events (
          event_id, event_type, aggregate_type, aggregate_id, tenant_id, occurred_at, payload, status
        ) VALUES (
          'evt-bad-status', 'test.event', 'test', 'agg-1', 't-1', CURRENT_TIMESTAMP, '{}', 'INVALID_STATUS'
        );
      `),
    ).rejects.toThrow();

    // 0009: Insert valid outbox event
    await db.query(`
      INSERT INTO outbox_events (
        event_id, event_type, aggregate_type, aggregate_id, tenant_id, occurred_at, payload, status
      ) VALUES (
        'evt-1', 'catalog.product.created.v1', 'product', 'p-1', 't-1', CURRENT_TIMESTAMP, '{}', 'PENDING'
      );
    `);

    // 0009: Duplicate outbox event_id must fail PRIMARY KEY
    await expect(
      db.query(`
        INSERT INTO outbox_events (
          event_id, event_type, aggregate_type, aggregate_id, tenant_id, occurred_at, payload, status
        ) VALUES (
          'evt-1', 'catalog.product.created.v1', 'product', 'p-1', 't-1', CURRENT_TIMESTAMP, '{}', 'PENDING'
        );
      `),
    ).rejects.toThrow();

    // 0009: Insert valid consumer receipt
    await db.query(`
      INSERT INTO event_consumer_receipts (id, consumer_name, event_id, status)
      VALUES ('rec-1', 'search-projector', 'evt-1', 'COMPLETED');
    `);

    // 0009: Duplicate (consumer_name, event_id) must fail UNIQUE constraint
    await expect(
      db.query(`
        INSERT INTO event_consumer_receipts (id, consumer_name, event_id, status)
        VALUES ('rec-2', 'search-projector', 'evt-1', 'COMPLETED');
      `),
    ).rejects.toThrow();

    // 0009: Notification with duplicate idempotency_key must fail UNIQUE constraint
    await db.query(`
      INSERT INTO notifications (
        id, tenant_id, event_id, notification_type, channel, recipient, idempotency_key, template_id, status
      ) VALUES (
        'notif-1', 't-1', 'evt-1', 'ORDER_CONFIRMATION', 'EMAIL', 'test@user.com', 'idemp-key-1', 'tpl-order', 'PENDING'
      );
    `);

    await expect(
      db.query(`
        INSERT INTO notifications (
          id, tenant_id, event_id, notification_type, channel, recipient, idempotency_key, template_id, status
        ) VALUES (
          'notif-2', 't-1', 'evt-1', 'ORDER_CONFIRMATION', 'EMAIL', 'test@user.com', 'idemp-key-1', 'tpl-order', 'PENDING'
        );
      `),
    ).rejects.toThrow();

    // 0011: Insert valid derived recommendation
    await db.query(`
      INSERT INTO derived_recommendations (
        id, scope_key, tenant_id, recommendation_type, recommended_product_id, rank_position, score, reason_code, explanation
      ) VALUES (
        'rec-1', 't-1:TRENDING:NONE:NONE:prod-1', 't-1', 'TRENDING', 'prod-1', 1, 95.5000, 'TRENDING', 'Popular product'
      );
    `);

    // 0011: Duplicate scope_key must fail UNIQUE constraint
    await expect(
      db.query(`
        INSERT INTO derived_recommendations (
          id, scope_key, tenant_id, recommendation_type, recommended_product_id, rank_position, score, reason_code, explanation
        ) VALUES (
          'rec-2', 't-1:TRENDING:NONE:NONE:prod-1', 't-1', 'TRENDING', 'prod-1', 2, 90.0000, 'TRENDING', 'Duplicate scope'
        );
      `),
    ).rejects.toThrow();

    // 0012: Insert valid ML model
    await db.query(`
      INSERT INTO ml_models (
        id, tenant_id, model_type, version, status, algorithm, training_dataset_id, data_source_type, prediction_horizon
      ) VALUES (
        'mdl-1', 't-1', 'DEMAND_FORECASTING', 'v1.0.0', 'APPROVED', 'RandomForestRegressor', 'ds-1', 'REAL', '7d'
      );
    `);

    // 0012: Duplicate (tenant_id, model_type, version) must fail UNIQUE constraint
    await expect(
      db.query(`
        INSERT INTO ml_models (
          id, tenant_id, model_type, version, status, algorithm, training_dataset_id, data_source_type, prediction_horizon
        ) VALUES (
          'mdl-2', 't-1', 'DEMAND_FORECASTING', 'v1.0.0', 'APPROVED', 'RandomForestRegressor', 'ds-2', 'REAL', '7d'
        );
      `),
    ).rejects.toThrow();

    // 0012: Invalid model status must fail CHECK constraint
    await expect(
      db.query(`
        INSERT INTO ml_models (
          id, tenant_id, model_type, version, status, algorithm, training_dataset_id, data_source_type, prediction_horizon
        ) VALUES (
          'mdl-bad', 't-1', 'DEMAND_FORECASTING', 'v1.0.1', 'INVALID_STATUS', 'RandomForestRegressor', 'ds-1', 'REAL', '7d'
        );
      `),
    ).rejects.toThrow();

    // 0012: Insert valid prediction
    await db.query(`
      INSERT INTO ml_predictions (
        id, scope_key, tenant_id, model_id, model_version, model_type, entity_type, entity_id, prediction_value, horizon, data_source_type
      ) VALUES (
        'prd-1', 't-1:DEMAND_FORECASTING:PRODUCT:prod-1:7d', 't-1', 'mdl-1', 'v1.0.0', 'DEMAND_FORECASTING', 'PRODUCT', 'prod-1', 42.5000, '7d', 'REAL'
      );
    `);

    // 0012: Duplicate scope_key must fail UNIQUE constraint
    await expect(
      db.query(`
        INSERT INTO ml_predictions (
          id, scope_key, tenant_id, model_id, model_version, model_type, entity_type, entity_id, prediction_value, horizon, data_source_type
        ) VALUES (
          'prd-2', 't-1:DEMAND_FORECASTING:PRODUCT:prod-1:7d', 't-1', 'mdl-1', 'v1.0.0', 'DEMAND_FORECASTING', 'PRODUCT', 'prod-1', 30.0000, '7d', 'REAL'
        );
      `),
    ).rejects.toThrow();

    // 0012: Two active approved models for same (tenant_id, model_type) must fail uq_ml_active_approved_model
    await db.query(`
      UPDATE ml_models SET is_active = TRUE, status = 'APPROVED' WHERE id = 'mdl-1';
    `);
    await db.query(`
      INSERT INTO ml_models (
        id, tenant_id, model_type, version, status, algorithm, training_dataset_id, data_source_type, prediction_horizon, is_active
      ) VALUES (
        'mdl-active-2', 't-1', 'DEMAND_FORECASTING', 'v2.0.0', 'APPROVED', 'RandomForestRegressor', 'ds-2', 'REAL', '7d', FALSE
      );
    `);
    await expect(
      db.query(`
        UPDATE ml_models SET is_active = TRUE WHERE id = 'mdl-active-2';
      `),
    ).rejects.toThrow();

    // 0012: Two active training jobs (PENDING/RUNNING) for same (tenant_id, model_type) must fail uq_ml_active_training_job
    await db.query(`
      INSERT INTO ml_training_jobs (
        id, tenant_id, model_type, status, trigger_type, data_source_type, started_at
      ) VALUES (
        'job-1', 't-1', 'DEMAND_FORECASTING', 'PENDING', 'MANUAL', 'REAL', NOW()
      );
    `);
    await expect(
      db.query(`
        INSERT INTO ml_training_jobs (
          id, tenant_id, model_type, status, trigger_type, data_source_type, started_at
        ) VALUES (
          'job-2', 't-1', 'DEMAND_FORECASTING', 'RUNNING', 'MANUAL', 'REAL', NOW()
        );
      `),
    ).rejects.toThrow();

    // 0013: AI & RAG - verify unique constraint on ai_knowledge_document_versions (document_id, version)
    await db.query(`
      INSERT INTO ai_knowledge_documents (id, tenant_id, title, category, status)
      VALUES ('doc-1', 't-1', 'Product Specs', 'SPECIFICATION', 'INDEXED');
    `);
    await db.query(`
      INSERT INTO ai_knowledge_document_versions (id, document_id, tenant_id, version, raw_content, cleaned_content, status)
      VALUES ('ver-1', 'doc-1', 't-1', 1, 'Raw specs', 'Clean specs', 'INDEXED');
    `);
    await expect(
      db.query(`
        INSERT INTO ai_knowledge_document_versions (id, document_id, tenant_id, version, raw_content, cleaned_content, status)
        VALUES ('ver-dup', 'doc-1', 't-1', 1, 'Duplicate version', 'Duplicate version', 'INDEXED');
      `),
    ).rejects.toThrow();

    // 0013: WhatsApp webhook deduplication constraint on provider_message_id
    await db.query(`
      INSERT INTO ai_whatsapp_webhooks (id, provider_message_id, tenant_id, phone_number, status, payload_hash)
      VALUES ('hook-1', 'wam-unique-msg-123', 't-1', '+1234567890', 'PROCESSED', 'hash123');
    `);
    // 0015: Search Projections - verify CHECK constraint on search_product_projections status
    await expect(
      db.query(`
        INSERT INTO search_product_projections (id, generation, title, slug, status)
        VALUES ('prod-bad', 1, 'Bad Product', 'bad-product', 'INVALID_STATUS');
      `),
    ).rejects.toThrow();

    // 0015: Insert valid search projection and offer
    await db.query(`
      INSERT INTO search_product_projections (id, generation, title, slug, status, min_price, max_price)
      VALUES ('prod-1', 1, 'Valid Product', 'valid-product', 'ACTIVE', 1000, 2000);
    `);
    await db.query(`
      INSERT INTO search_seller_offers (listing_id, generation, product_id, merchant_id, sku_id, sku_code, price_amount, status)
      VALUES ('list-1', 1, 'prod-1', 'm-1', 'sku-1', 'SKU-001', 1500, 'ACTIVE');
    `);

    // 0024: Wishlist items constraints
    await db.query(`
      INSERT INTO wishlist_items (id, customer_id, tenant_id, product_id, sku_id)
      VALUES ('wish-1', 'u-1', 't-1', 'prod-1', 'sku-1');
    `);

    // Duplicate wishlist item for same customer and product must fail unique constraint
    await expect(
      db.query(`
        INSERT INTO wishlist_items (id, customer_id, tenant_id, product_id, sku_id)
        VALUES ('wish-2', 'u-1', 't-1', 'prod-1', 'sku-1');
      `),
    ).rejects.toThrow();

    // 0025: Back in stock subscriptions constraints
    await db.query(`
      INSERT INTO back_in_stock_subscriptions (id, customer_id, tenant_id, product_id, sku_id, status)
      VALUES ('sub-1', 'u-1', 't-1', 'prod-1', 'sku-1', 'ACTIVE');
    `);

    // Duplicate subscription for same customer and product must fail unique constraint
    await expect(
      db.query(`
        INSERT INTO back_in_stock_subscriptions (id, customer_id, tenant_id, product_id, sku_id, status)
        VALUES ('sub-2', 'u-1', 't-1', 'prod-1', 'sku-1', 'ACTIVE');
      `),
    ).rejects.toThrow();
  });
});


