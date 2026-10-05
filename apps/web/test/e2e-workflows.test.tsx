import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import React from 'react';
import { BrowserRouter } from 'react-router-dom';
import { createMigratedTestDatabase } from '../../api/test/helpers/test-db.js';
import { buildApp } from '../../api/src/app.js';
import { parseConfig } from '../../api/src/config/index.js';
import type { FastifyInstance } from 'fastify';
import type { DatabaseConnection } from '../../api/src/infra/database/connection.js';
import { AuthProvider } from '../src/features/auth/AuthContext.js';
import { CartProvider } from '../src/features/cart/CartContext.js';
import { CartPage } from '../src/features/cart/CartPage.js';
import { CustomerOrders } from '../src/features/orders/CustomerOrders.js';
import { MerchantOrders } from '../src/features/merchant/MerchantOrders.js';
import { AdminDashboard } from '../src/features/admin/AdminDashboard.js';

describe('End-to-End Multi-Vendor Platform Workflows', () => {
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
        url,
        headers: init?.headers as Record<string, string>,
        payload: init?.body as string | Buffer | undefined,
      });

      return new Response(res.payload, {
        status: res.statusCode,
        headers: new Headers(res.headers as Record<string, string>),
      });
    };
  });

  afterEach(() => {
    cleanup();
  });

  afterAll(async () => {
    if (app) await app.close();
    if (db) await db.close();
    vi.restoreAllMocks();
  });

  it('Customer Cart renders login prompt when unauthenticated', async () => {
    render(
      <BrowserRouter>
        <AuthProvider>
          <CartProvider>
            <CartPage />
          </CartProvider>
        </AuthProvider>
      </BrowserRouter>,
    );

    await waitFor(() => {
      expect(screen.getByText(/Your Shopping Cart/i)).toBeDefined();
      expect(screen.getByText(/Please log in to view your saved cart items/i)).toBeDefined();
    });
  });


  it('Customer Orders renders authenticated login prompt when not signed in', async () => {
    render(
      <BrowserRouter>
        <AuthProvider>
          <CustomerOrders />
        </AuthProvider>
      </BrowserRouter>,
    );

    await waitFor(() => {
      expect(screen.getByText(/My Orders/i)).toBeDefined();
      expect(screen.getByText(/Please log in to review your order history/i)).toBeDefined();
    });
  });

  it('Merchant Orders renders empty state when no orders are assigned', async () => {
    render(
      <BrowserRouter>
        <MerchantOrders />
      </BrowserRouter>,
    );

    await waitFor(() => {
      expect(screen.getByText(/Merchant Orders & Fulfillment/i)).toBeDefined();
      expect(screen.getByText(/No orders currently assigned to your seller account/i)).toBeDefined();
    });
  });

  it('Admin Dashboard renders access gate when not authenticated as Administrator', async () => {
    render(
      <BrowserRouter>
        <AuthProvider>
          <AdminDashboard />
        </AuthProvider>
      </BrowserRouter>,
    );

    await waitFor(() => {
      expect(screen.getByText('Admin')).toBeDefined();
      expect(screen.getByText(/administrator account/i)).toBeDefined();
    });
  });
});
