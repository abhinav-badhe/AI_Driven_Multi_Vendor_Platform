import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, act, waitFor, fireEvent } from '@testing-library/react';
import { AuthProvider } from '../src/features/auth/AuthContext.js';
import { AnalyticsDashboard } from '../src/features/analytics/AnalyticsDashboard.js';

const MERCHANT_ME = {
  userId: 'u-m1',
  email: 'merchant@example.com',
  tenantId: 'tenant-merchant-1',
  role: 'MERCHANT',
};

const TRAINED_MODEL = {
  id: 'mdl-1',
  tenantId: 'tenant-merchant-1',
  modelType: 'DEMAND_FORECASTING',
  version: 'v1.0.0',
  status: 'APPROVED',
  // NOTE: real backend nests metrics; top-level accuracy/rmse may be absent,
  // and some deployments serialize numerics as strings — the UI must survive.
  rmse: '30.611',
  dataSourceType: 'BOOTSTRAP',
  createdAt: '2026-10-06T10:00:00.000Z',
};

const PREDICTION = {
  tenantId: 'tenant-merchant-1',
  modelType: 'DEMAND_FORECASTING',
  modelVersion: 'v1.0.0',
  entityType: 'PRODUCT',
  entityId: 'prod-1',
  predictedValue: '45.2',
  probability: null,
  confidence: 0.85,
  horizon: '7d',
  dataSourceType: 'BOOTSTRAP',
  isSynthetic: true,
  predictedAt: '2026-10-06T10:00:00.000Z',
};

function mockApi() {
  global.fetch = vi.fn().mockImplementation((url: string) => {
    const ok = (body: unknown) =>
      Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) } as Response);
    if (typeof url !== 'string') return Promise.reject(new Error('bad url'));
    if (url.includes('/auth/refresh')) return ok({ accessToken: 'tok' });
    if (url.includes('/auth/me')) return ok(MERCHANT_ME);
    if (url.includes('/analytics/sales'))
      return ok({ currency: 'USD', totals: { totalOrders: 2, grossSales: '1609.9800', netSales: '1609.9800', averageOrderValue: '804.9900' }, trends: [] });
    if (url.includes('/analytics/products')) return ok({ products: [] });
    if (url.includes('/analytics/operations'))
      return ok({
        currency: 'USD',
        operations: {
          paymentSuccessCount: 2,
          paymentFailCount: 0,
          paymentSuccessRate: '100.00%',
          paymentFailureRate: '0.00%',
          shipmentCount: 0,
          returnCount: 0,
        },
      });
    if (url.includes('/ml/models')) return ok({ models: [TRAINED_MODEL] });
    if (url.includes('/ml/predictions')) return ok({ predictions: [PREDICTION] });
    return Promise.reject(new Error(`unexpected fetch: ${url}`));
  });
}

describe('Analytics dashboard — Models tab crash guard', () => {
  beforeEach(() => {
    mockApi();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('renders trained models and predictions without crashing', async () => {
    await act(async () => {
      render(
        <AuthProvider>
          <AnalyticsDashboard />
        </AuthProvider>,
      );
    });

    // Wait for data to load (KPIs visible means load finished).
    await waitFor(() => expect(screen.getByText('Gross revenue')).toBeDefined());

    // Switch to the Models tab — previously blank-screened with real data.
    await act(async () => {
      fireEvent.click(screen.getByRole('tab', { name: 'Models' }));
    });

    await waitFor(() => expect(screen.getByText('Train a model')).toBeDefined());

    // Model row renders (string rmse coerced, no .toFixed crash).
    await waitFor(() => expect(screen.getAllByText('DEMAND_FORECASTING').length).toBeGreaterThan(0));
    expect(screen.getByText(/RMSE 30\.611/)).toBeDefined();
    expect(screen.getAllByText('BOOTSTRAP').length).toBeGreaterThan(0);

    // Prediction row renders (string predictedValue coerced).
    expect(screen.getByText('45.2')).toBeDefined();

    // No error-boundary fallback shown.
    expect(screen.queryByText('Something went wrong')).toBeNull();
  });
});
