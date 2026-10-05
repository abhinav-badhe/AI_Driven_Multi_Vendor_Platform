import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import React from 'react';
import { BrowserRouter } from 'react-router-dom';
import { createMigratedTestDatabase } from '../../api/test/helpers/test-db.js';
import { buildApp } from '../../api/src/app.js';
import { parseConfig } from '../../api/src/config/index.js';
import type { FastifyInstance } from 'fastify';
import type { DatabaseConnection } from '../../api/src/infra/database/connection.js';
import { Home } from '../src/features/home/Home.js';
import { ProductPage } from '../src/features/catalog/Product.js';
import { AuthProvider } from '../src/features/auth/AuthContext.js';

let currentProductId = 'test-product-id';

// Setup Mock React Router Params
vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...(actual as Record<string, unknown>),
    useParams: () => ({ id: currentProductId }),
  };
});

interface InterceptedResponse {
  url: string;
  status: number;
  data: unknown;
}

const interceptedResponses: InterceptedResponse[] = [];

describe('Phase C Frontend-Backend E2E Integration', () => {
  let app: FastifyInstance;
  let db: DatabaseConnection;

  beforeAll(async () => {
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
      ACCESS_TOKEN_SECRET: 'super-secret-key-at-least-16-chars',
      SERVICE_NAME: 'test-api',
      LOG_PRETTY: 'false',
      REDACT_KEYS: 'password,token',
    });

    app = await buildApp({ config, dbConnection: db, skipMigrations: true });
    await app.ready();

    // Override global.fetch to intercept API calls and route them directly to Fastify's in-memory instance
    global.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      let url = typeof input === 'string' ? input : input.toString();
      if (url.startsWith('http://localhost:3000/api')) {
        url = url.replace('http://localhost:3000/api', '');
      } else if (url.startsWith('/api')) {
        url = url.replace('/api', '');
      }

      const method = (init?.method || 'GET') as 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
      const res = await app.inject({
        method,
        url: url,
        headers: init?.headers as Record<string, string>,
        payload: init?.body as string | Buffer | undefined,
      });

      let parsed: unknown;
      try {
        parsed = JSON.parse(res.payload);
      } catch {
        parsed = res.payload;
      }
      interceptedResponses.push({
        url,
        status: res.statusCode,
        data: parsed,
      });

      return new Response(res.payload, {
        status: res.statusCode,
        headers: new Headers(res.headers as Record<string, string>),
      });
    };
  });

  afterEach(() => {
    cleanup();
    interceptedResponses.length = 0;
  });

  afterAll(async () => {
    if (app) await app.close();
    if (db) await db.close();
    vi.restoreAllMocks();
  });

  it('1. Home -> GET categories -> actual Fastify -> DB -> actual response -> renders', async () => {
    // Seed DB directly
    await db.query(`INSERT INTO categories (id, name, slug) VALUES ('cat-1', 'Electronics', 'electronics')`);

    render(
      <BrowserRouter>
        <AuthProvider>
          <Home />
        </AuthProvider>
      </BrowserRouter>
    );

    // Wait for actual response to render (name appears in filter + list)
    await waitFor(() => {
      expect(screen.getAllByText('Electronics').length).toBeGreaterThan(0);
    });
  });

  it('2. Product -> ACTIVE SKU -> active vs inactive merchant listings -> backend excludes inactive listing and frontend renders only active offers', async () => {
    currentProductId = 'test-product-id';

    // Seed Product
    await db.query(`INSERT INTO products (id, title, slug, status) VALUES ('test-product-id', 'Test Laptop', 'test-laptop', 'ACTIVE')`);
    
    // Seed SKUs (One ACTIVE, One DRAFT to prove visibility filtering works end-to-end)
    await db.query(`INSERT INTO product_skus (id, product_id, sku_code, status) VALUES ('sku-1', 'test-product-id', 'LAPTOP-WHT', 'ACTIVE')`);
    await db.query(`INSERT INTO product_skus (id, product_id, sku_code, status) VALUES ('sku-2', 'test-product-id', 'LAPTOP-BLK', 'DRAFT')`);

    // Seed Merchants
    await db.query(`INSERT INTO tenants (id, name, type, created_at, updated_at) VALUES ('tenant-1', 'BestBuy', 'MERCHANT', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`);
    await db.query(`INSERT INTO tenants (id, name, type, created_at, updated_at) VALUES ('tenant-2', 'Amazon', 'MERCHANT', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`);
    await db.query(`INSERT INTO tenants (id, name, type, created_at, updated_at) VALUES ('tenant-3', 'InactiveSeller', 'MERCHANT', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`);

    // Seed Listings for ACTIVE SKU:
    // Listing A = ACTIVE ($999.00)
    await db.query(`INSERT INTO merchant_listings (id, tenant_id, sku_id, price_amount, currency, status, created_at, updated_at) VALUES ('list-1', 'tenant-1', 'sku-1', 99900, 'USD', 'ACTIVE', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`);
    // Listing B = ACTIVE ($950.00)
    await db.query(`INSERT INTO merchant_listings (id, tenant_id, sku_id, price_amount, currency, status, created_at, updated_at) VALUES ('list-2', 'tenant-2', 'sku-1', 95000, 'USD', 'ACTIVE', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`);
    // Listing C = INACTIVE ($750.00) - MUST be excluded by backend
    await db.query(`INSERT INTO merchant_listings (id, tenant_id, sku_id, price_amount, currency, status, created_at, updated_at) VALUES ('list-3', 'tenant-3', 'sku-1', 75000, 'USD', 'INACTIVE', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`);

    render(
      <BrowserRouter>
        <AuthProvider>
          <ProductPage />
        </AuthProvider>
      </BrowserRouter>
    );

    // Wait for Product title
    await waitFor(() => {
      expect(screen.getByText('Test Laptop')).toBeDefined();
    });

    // Verify ACTIVE SKU is rendered (and not DRAFT)
    await waitFor(() => {
      expect(screen.getByText(/LAPTOP-WHT/)).toBeDefined();
    });

    // Verify multiple active merchant offers are rendered with different prices
    await waitFor(() => {
      // 99900 minor units = $999.00 rendered in major units
      expect(screen.getByText(/999\.00/)).toBeDefined();
      expect(screen.getByText(/950\.00/)).toBeDefined();
    });

    // CRITICAL: Prove backend response itself excluded the INACTIVE listing (Listing C: 75000.00)
    const listingApiCall = interceptedResponses.find(r => r.url === '/skus/sku-1/listings');
    expect(listingApiCall).toBeDefined();
    expect(listingApiCall?.status).toBe(200);
    // Backend response has exactly 2 listings
    const listingsPayload = listingApiCall?.data as Array<{ id: string }>;
    expect(listingsPayload).toHaveLength(2);
    // Active listings are present in backend payload
    expect(listingsPayload.some((l) => l.id === 'list-1')).toBe(true);
    expect(listingsPayload.some((l) => l.id === 'list-2')).toBe(true);
    // Inactive listing is completely absent from the backend response itself
    expect(listingsPayload.some((l) => l.id === 'list-3')).toBe(false);

    // CRITICAL: Prove React DOM does not render Listing C
    expect(screen.queryByText(/750\.00/)).toBeNull();
  });

  it('3. Product -> SKU -> zero active listings (only inactive listing seeded) -> backend returns [] and frontend renders empty seller state', async () => {
    currentProductId = 'product-no-active-listings';

    // Seed Product
    await db.query(`INSERT INTO products (id, title, slug, status) VALUES ('product-no-active-listings', 'Unlisted Item', 'unlisted-item', 'ACTIVE')`);
    
    // Seed SKU
    await db.query(`INSERT INTO product_skus (id, product_id, sku_code, status) VALUES ('sku-empty', 'product-no-active-listings', 'EMPTY-SKU', 'ACTIVE')`);

    // Seed Merchant
    await db.query(`INSERT INTO tenants (id, name, type, created_at, updated_at) VALUES ('tenant-ghost', 'GhostMerchant', 'MERCHANT', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`);

    // Seed only an INACTIVE listing for this SKU (so active listings count is ZERO)
    await db.query(`INSERT INTO merchant_listings (id, tenant_id, sku_id, price_amount, currency, status, created_at, updated_at) VALUES ('list-inactive-only', 'tenant-ghost', 'sku-empty', 49900, 'USD', 'INACTIVE', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`);

    render(
      <BrowserRouter>
        <AuthProvider>
          <ProductPage />
        </AuthProvider>
      </BrowserRouter>
    );

    // Wait for Product title and SKU variant
    await waitFor(() => {
      expect(screen.getByText('Unlisted Item')).toBeDefined();
      expect(screen.getByText(/EMPTY-SKU/)).toBeDefined();
    });

    // Wait for empty seller state to appear in DOM
    await waitFor(() => {
      expect(screen.getByText('Currently unavailable.')).toBeDefined();
      expect(screen.getByText('No merchants are actively selling this item.')).toBeDefined();
    });

    // CRITICAL: Prove backend response itself returned an empty collection []
    const listingApiCall = interceptedResponses.find(r => r.url === '/skus/sku-empty/listings');
    expect(listingApiCall).toBeDefined();
    expect(listingApiCall?.status).toBe(200);
    expect(listingApiCall?.data).toEqual([]);

    // Prove no fake fallback seller or price was fabricated
    expect(screen.queryByText(/499\.00/)).toBeNull();
    expect(screen.queryByText(/Add to Cart/)).toBeNull();
  });
});

