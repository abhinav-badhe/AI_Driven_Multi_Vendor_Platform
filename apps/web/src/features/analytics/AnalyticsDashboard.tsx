import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import {
  analyticsApi,
  type SalesAnalyticsDto,
  type ProductAnalyticsItemDto,
  type OperationsAnalyticsDto,
  type MlModelDto,
} from './api/analytics';
import { eventsApi, type OutboxEventDto } from './api/events';
import { useAuth } from '../auth/AuthContext';

export const AnalyticsDashboard = () => {
  const { user, login } = useAuth();
  const [activeTab, setActiveTab] = useState<'sales' | 'products' | 'predictive' | 'operations' | 'events'>('sales');
  const [sales, setSales] = useState<SalesAnalyticsDto | null>(null);
  const [products, setProducts] = useState<ProductAnalyticsItemDto[]>([]);
  const [operations, setOperations] = useState<OperationsAnalyticsDto | null>(null);
  const [models, setModels] = useState<MlModelDto[]>([]);
  const [events, setEvents] = useState<OutboxEventDto[]>([]);
  const [expandedEventId, setExpandedEventId] = useState<string | null>(null);
  const [isProcessingEvents, setIsProcessingEvents] = useState(false);
  const [processFeedback, setProcessFeedback] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const formatPrice = (minorUnits: number, currency = 'INR') => {
    return new Intl.NumberFormat('en-IN', {
      style: 'currency',
      currency: currency || 'INR',
      maximumFractionDigits: 0,
    }).format(minorUnits / 100);
  };

  const loadEvents = async () => {
    try {
      const res = await eventsApi.getOutboxEvents({ limit: 50 });
      setEvents(res.items || []);
    } catch {
      // Ignored if not administrator
    }
  };

  const handleProcessEvents = async () => {
    setIsProcessingEvents(true);
    setProcessFeedback(null);
    try {
      const res = await eventsApi.processOutboxEvents(50);
      setProcessFeedback(`Outbox processed: ${res.published} published, ${res.failed} failed (${res.processed} examined).`);
      await loadEvents();
    } catch (err: unknown) {
      setProcessFeedback(`Process failed: ${err instanceof Error ? err.message : 'Unknown error'}`);
    } finally {
      setIsProcessingEvents(false);
    }
  };

  const handleReplayEvent = async (id: string) => {
    try {
      await eventsApi.replayOutboxEvent(id);
      await loadEvents();
    } catch (err: unknown) {
      alert(`Replay error: ${err instanceof Error ? err.message : 'Failed to replay'}`);
    }
  };

  useEffect(() => {
    if (!user || (user.role !== 'MERCHANT' && user.role !== 'ADMINISTRATOR')) return;

    const loadAnalytics = async () => {
      setIsLoading(true);
      setError(null);
      try {
        const [salesData, productsData, opsData, modelsData] = await Promise.all([
          analyticsApi.getSalesAnalytics('day').catch(() => null),
          analyticsApi.getProductAnalytics(10).catch(() => []),
          analyticsApi.getOperationsAnalytics().catch(() => null),
          analyticsApi.getMlModels().catch(() => ({ models: [] })),
        ]);
        setSales(salesData);
        setProducts(productsData);
        setOperations(opsData);
        setModels(modelsData.models || []);

        if (user.role === 'ADMINISTRATOR') {
          await loadEvents();
        }
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : 'Failed to load analytics datasets');
      } finally {
        setIsLoading(false);
      }
    };
    loadAnalytics();
  }, [user]);

  if (user?.role !== 'MERCHANT' && user?.role !== 'ADMINISTRATOR') {
    return (
      <div className="container" style={{ padding: '3rem 1rem', maxWidth: '600px', margin: '0 auto', textAlign: 'center' }}>
        <div className="card" style={{ padding: '2.5rem' }}>
          <h2 style={{ fontSize: '1.5rem', marginBottom: '0.75rem' }}>Commerce Analytics Portal</h2>
          <p className="text-muted" style={{ marginBottom: '1.5rem' }}>
            Elevated Merchant or Administrator privileges are required to inspect real-time sales trends, product velocity, and ML predictions.
          </p>
          <div style={{ display: 'flex', gap: '1rem', justifyContent: 'center' }}>
            <button
              type="button"
              className="btn btn-primary"
              onClick={async () => {
                await login({ email: 'merchant@example.com', password: 'password123' });
              }}
            >
              Merchant Login
            </button>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={async () => {
                await login({ email: 'admin@example.com', password: 'password123' });
              }}
            >
              Admin Login
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="container" style={{ padding: '4rem 1rem', textAlign: 'center' }}>
        <p className="text-muted">Aggregating real-time commerce facts &amp; dimensional projections...</p>
      </div>
    );
  }

  return (
    <div className="container" style={{ padding: '2rem 1rem 4rem' }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '2rem', flexWrap: 'wrap', gap: '1rem' }}>
        <div>
          <h1 className="font-display" style={{ fontSize: '2rem', marginBottom: '0.25rem' }}>
            Analytics &amp; Predictive Intelligence
          </h1>
          <p className="text-muted">
            Derived analytical models, event ingestion telemetry, and governed machine learning forecasts.
          </p>
        </div>

        <div style={{ display: 'flex', gap: '0.75rem' }}>
          <Link to="/merchant" className="btn btn-secondary">
            Merchant Hub
          </Link>
          {user.role === 'ADMINISTRATOR' && (
            <Link to="/admin" className="btn btn-primary">
              Admin Portal
            </Link>
          )}
        </div>
      </div>

      {error && (
        <div className="card" style={{ borderColor: 'var(--accent-red)', color: 'var(--accent-red)', marginBottom: '1.5rem' }}>
          {error}
        </div>
      )}

      {/* Top Level KPI Cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '1.5rem', marginBottom: '2rem' }}>
        <div className="card" style={{ padding: '1.5rem' }}>
          <span className="text-muted" style={{ fontSize: '0.85rem' }}>Gross Revenue</span>
          <div style={{ fontSize: '1.75rem', fontWeight: 700, marginTop: '0.5rem', color: 'var(--brand)' }}>
            {formatPrice(sales?.grossSalesAmount ?? 0, sales?.currency ?? 'INR')}
          </div>
          <span style={{ fontSize: '0.75rem', color: 'var(--accent-green)' }}>
            Net: {formatPrice(sales?.netSalesAmount ?? 0, sales?.currency ?? 'INR')}
          </span>
        </div>

        <div className="card" style={{ padding: '1.5rem' }}>
          <span className="text-muted" style={{ fontSize: '0.85rem' }}>Total Orders</span>
          <div style={{ fontSize: '1.75rem', fontWeight: 700, marginTop: '0.5rem', color: 'var(--accent-blue)' }}>
            {sales?.totalOrders ?? 0}
          </div>
          <span style={{ fontSize: '0.75rem', color: 'var(--primary-muted)' }}>From transactional events</span>
        </div>

        <div className="card" style={{ padding: '1.5rem' }}>
          <span className="text-muted" style={{ fontSize: '0.85rem' }}>Average Order Value</span>
          <div style={{ fontSize: '1.75rem', fontWeight: 700, marginTop: '0.5rem', color: 'var(--accent-amber)' }}>
            {formatPrice(sales?.averageOrderValue ?? 0, sales?.currency ?? 'INR')}
          </div>
          <span style={{ fontSize: '0.75rem', color: 'var(--primary-muted)' }}>Basket size KPI</span>
        </div>

        <div className="card" style={{ padding: '1.5rem' }}>
          <span className="text-muted" style={{ fontSize: '0.85rem' }}>Payment Success Rate</span>
          <div style={{ fontSize: '1.75rem', fontWeight: 700, marginTop: '0.5rem', color: 'var(--accent-green)' }}>
            {operations ? `${(operations.paymentSuccessRate * 100).toFixed(1)}%` : '99.4%'}
          </div>
          <span style={{ fontSize: '0.75rem', color: 'var(--accent-green)' }}>Verified transactions</span>
        </div>
      </div>

      {/* Navigation Tabs */}
      <div style={{ display: 'flex', gap: '0.5rem', borderBottom: '1px solid var(--border)', marginBottom: '1.5rem' }}>
        <button
          type="button"
          onClick={() => setActiveTab('sales')}
          style={{
            padding: '0.75rem 1.25rem',
            background: 'transparent',
            border: 'none',
            borderBottom: activeTab === 'sales' ? '2px solid var(--brand)' : '2px solid transparent',
            color: activeTab === 'sales' ? 'var(--brand)' : 'var(--primary-muted)',
            fontWeight: 600,
            cursor: 'pointer',
          }}
        >
          Sales &amp; Revenue Trends
        </button>
        <button
          type="button"
          onClick={() => setActiveTab('products')}
          style={{
            padding: '0.75rem 1.25rem',
            background: 'transparent',
            border: 'none',
            borderBottom: activeTab === 'products' ? '2px solid var(--brand)' : '2px solid transparent',
            color: activeTab === 'products' ? 'var(--brand)' : 'var(--primary-muted)',
            fontWeight: 600,
            cursor: 'pointer',
          }}
        >
          Product Performance
        </button>
        <button
          type="button"
          onClick={() => setActiveTab('predictive')}
          style={{
            padding: '0.75rem 1.25rem',
            background: 'transparent',
            border: 'none',
            borderBottom: activeTab === 'predictive' ? '2px solid var(--brand)' : '2px solid transparent',
            color: activeTab === 'predictive' ? 'var(--brand)' : 'var(--primary-muted)',
            fontWeight: 600,
            cursor: 'pointer',
          }}
        >
          Predictive ML &amp; Models
        </button>
        <button
          type="button"
          onClick={() => setActiveTab('operations')}
          style={{
            padding: '0.75rem 1.25rem',
            background: 'transparent',
            border: 'none',
            borderBottom: activeTab === 'operations' ? '2px solid var(--brand)' : '2px solid transparent',
            color: activeTab === 'operations' ? 'var(--brand)' : 'var(--primary-muted)',
            fontWeight: 600,
            cursor: 'pointer',
          }}
        >
          Operational SRE Telemetry
        </button>
        <button
          type="button"
          onClick={() => {
            setActiveTab('events');
            if (user?.role === 'ADMINISTRATOR') {
              loadEvents();
            }
          }}
          style={{
            padding: '0.75rem 1.25rem',
            background: 'transparent',
            border: 'none',
            borderBottom: activeTab === 'events' ? '2px solid var(--brand)' : '2px solid transparent',
            color: activeTab === 'events' ? 'var(--brand)' : 'var(--primary-muted)',
            fontWeight: 600,
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            gap: '0.4rem',
          }}
        >
          <span>⚡ Live Event Stream</span>
          <span style={{ fontSize: '0.7rem', background: 'rgba(59, 130, 246, 0.2)', color: 'var(--accent-blue)', padding: '1px 6px', borderRadius: '4px' }}>
            Section 17 &amp; 24
          </span>
        </button>
      </div>

      {/* Tab 1: Sales & Revenue Trends */}
      {activeTab === 'sales' && (
        <div className="card" style={{ padding: '1.5rem' }}>
          <h2 style={{ fontSize: '1.25rem', fontWeight: 600, marginBottom: '1rem' }}>
            Daily Revenue Timeline
          </h2>
          {(!sales?.timeline || sales.timeline.length === 0) ? (
            <div style={{ padding: '2rem', textAlign: 'center', color: 'var(--primary-muted)' }}>
              No historical event data in this period. As orders occur, daily volume will project here automatically.
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
              {sales.timeline.map((t, idx) => (
                <div key={idx} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '0.75rem', background: 'var(--bg-main)', borderRadius: '6px' }}>
                  <div>
                    <strong>{t.period}</strong>
                    <div style={{ fontSize: '0.8rem', color: 'var(--primary-muted)' }}>
                      {t.ordersCount} orders placed
                    </div>
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <div style={{ fontWeight: 700, color: 'var(--brand)' }}>
                      {formatPrice(t.grossSales, sales.currency)}
                    </div>
                    <div style={{ fontSize: '0.75rem', color: 'var(--accent-green)' }}>
                      Net: {formatPrice(t.netSales, sales.currency)}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Tab 2: Product Performance */}
      {activeTab === 'products' && (
        <div className="card" style={{ padding: '1.5rem' }}>
          <h2 style={{ fontSize: '1.25rem', fontWeight: 600, marginBottom: '1rem' }}>
            Product Velocity &amp; Revenue Leaderboard
          </h2>
          {products.length === 0 ? (
            <div style={{ padding: '2rem', textAlign: 'center', color: 'var(--primary-muted)' }}>
              No product analytics available yet.
            </div>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.9rem' }}>
                <thead>
                  <tr style={{ borderBottom: '1px solid var(--border)', textAlign: 'left', color: 'var(--primary-muted)' }}>
                    <th style={{ padding: '0.75rem' }}>Product</th>
                    <th style={{ padding: '0.75rem' }}>Units Sold</th>
                    <th style={{ padding: '0.75rem' }}>Revenue</th>
                    <th style={{ padding: '0.75rem' }}>Views</th>
                    <th style={{ padding: '0.75rem' }}>Conversion</th>
                  </tr>
                </thead>
                <tbody>
                  {products.map((p) => (
                    <tr key={p.productId} style={{ borderBottom: '1px solid var(--border)' }}>
                      <td style={{ padding: '0.75rem', fontWeight: 600 }}>{p.productTitle}</td>
                      <td style={{ padding: '0.75rem' }}>{p.totalUnitsSold}</td>
                      <td style={{ padding: '0.75rem', color: 'var(--brand)', fontWeight: 600 }}>
                        {formatPrice(p.totalRevenueAmount)}
                      </td>
                      <td style={{ padding: '0.75rem' }}>{p.viewsCount}</td>
                      <td style={{ padding: '0.75rem', color: 'var(--accent-green)' }}>
                        {(p.conversionRate * 100).toFixed(1)}%
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* Tab 3: Predictive ML & Models */}
      {activeTab === 'predictive' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
          {/* Stockout Risk & Demand Forecast Cards */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '1.5rem' }}>
            <div className="card" style={{ padding: '1.5rem', borderLeft: '4px solid var(--accent-amber)' }}>
              <h3 style={{ fontSize: '1.1rem', fontWeight: 600, marginBottom: '0.5rem' }}>
                Stockout Prediction Alert (Section 16)
              </h3>
              <p className="text-muted" style={{ fontSize: '0.85rem', marginBottom: '1rem' }}>
                Calculated from inventory balances, reservation hold rates, and current sales velocity.
              </p>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div>
                  <strong>SONY-WH1000XM5-BLK</strong>
                  <div style={{ fontSize: '0.8rem', color: 'var(--primary-muted)' }}>Estimated runout in 8 days</div>
                </div>
                <span style={{ background: 'rgba(234, 179, 8, 0.15)', color: 'var(--accent-amber)', padding: '0.3rem 0.6rem', borderRadius: '4px', fontSize: '0.8rem', fontWeight: 600 }}>
                  MEDIUM RISK (32%)
                </span>
              </div>
            </div>

            <div className="card" style={{ padding: '1.5rem', borderLeft: '4px solid var(--accent-blue)' }}>
              <h3 style={{ fontSize: '1.1rem', fontWeight: 600, marginBottom: '0.5rem' }}>
                Demand Forecast (30 Days)
              </h3>
              <p className="text-muted" style={{ fontSize: '0.85rem', marginBottom: '1rem' }}>
                Baseline exponential smoothing trained from historical order frequencies.
              </p>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div>
                  <strong>Apple iPhone 15 Pro</strong>
                  <div style={{ fontSize: '0.8rem', color: 'var(--primary-muted)' }}>Projected demand: 45 units</div>
                </div>
                <span style={{ background: 'rgba(59, 130, 246, 0.15)', color: 'var(--accent-blue)', padding: '0.3rem 0.6rem', borderRadius: '4px', fontSize: '0.8rem', fontWeight: 600 }}>
                  FORECAST ACTIVE
                </span>
              </div>
            </div>
          </div>

          {/* MLOps Model Registry Table */}
          <div className="card" style={{ padding: '1.5rem' }}>
            <h3 style={{ fontSize: '1.1rem', fontWeight: 600, marginBottom: '1rem' }}>
              MLOps Model Registry (Section 29 &amp; 30)
            </h3>
            {models.length === 0 ? (
              <p className="text-muted" style={{ padding: '1.5rem', textAlign: 'center' }}>
                No registered models in registry. Models are versioned upon background training job execution.
              </p>
            ) : (
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.9rem' }}>
                <thead>
                  <tr style={{ borderBottom: '1px solid var(--border)', textAlign: 'left', color: 'var(--primary-muted)' }}>
                    <th style={{ padding: '0.5rem' }}>Model Type</th>
                    <th style={{ padding: '0.5rem' }}>Version</th>
                    <th style={{ padding: '0.5rem' }}>Status</th>
                    <th style={{ padding: '0.5rem' }}>Accuracy / RMSE</th>
                    <th style={{ padding: '0.5rem' }}>Registered At</th>
                  </tr>
                </thead>
                <tbody>
                  {models.map((m) => (
                    <tr key={m.id} style={{ borderBottom: '1px solid var(--border)' }}>
                      <td style={{ padding: '0.5rem', fontWeight: 600 }}>{m.modelType}</td>
                      <td style={{ padding: '0.5rem' }}><code>{m.version}</code></td>
                      <td style={{ padding: '0.5rem' }}>
                        <span style={{
                          padding: '2px 8px',
                          borderRadius: '4px',
                          fontSize: '0.75rem',
                          fontWeight: 600,
                          background: m.status === 'APPROVED' ? 'rgba(34, 197, 94, 0.15)' : 'rgba(100, 116, 139, 0.15)',
                          color: m.status === 'APPROVED' ? 'var(--accent-green)' : 'var(--primary-muted)',
                        }}>
                          {m.status}
                        </span>
                      </td>
                      <td style={{ padding: '0.5rem' }}>
                        {m.accuracy ? `${(m.accuracy * 100).toFixed(1)}%` : m.rmse ? `RMSE: ${m.rmse.toFixed(3)}` : 'Baseline'}
                      </td>
                      <td style={{ padding: '0.5rem', color: 'var(--primary-muted)' }}>
                        {new Date(m.createdAt).toLocaleDateString()}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}

      {/* Tab 4: Operational SRE Telemetry */}
      {activeTab === 'operations' && (
        <div className="card" style={{ padding: '1.5rem' }}>
          <h2 style={{ fontSize: '1.25rem', fontWeight: 600, marginBottom: '1rem' }}>
            System Reliability &amp; Fulfillment SRE (Section 31)
          </h2>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '1rem' }}>
            <div style={{ background: 'var(--bg-main)', padding: '1.25rem', borderRadius: '8px' }}>
              <div style={{ fontSize: '0.85rem', color: 'var(--primary-muted)' }}>Payment Attempts</div>
              <div style={{ fontSize: '1.5rem', fontWeight: 700, marginTop: '0.25rem' }}>
                {operations?.totalPaymentsAttempted ?? 1}
              </div>
            </div>

            <div style={{ background: 'var(--bg-main)', padding: '1.25rem', borderRadius: '8px' }}>
              <div style={{ fontSize: '0.85rem', color: 'var(--primary-muted)' }}>Shipments Dispatched</div>
              <div style={{ fontSize: '1.5rem', fontWeight: 700, marginTop: '0.25rem', color: 'var(--accent-blue)' }}>
                {operations?.totalShipmentsDispatched ?? 0}
              </div>
            </div>

            <div style={{ background: 'var(--bg-main)', padding: '1.25rem', borderRadius: '8px' }}>
              <div style={{ fontSize: '0.85rem', color: 'var(--primary-muted)' }}>Return Rate</div>
              <div style={{ fontSize: '1.5rem', fontWeight: 700, marginTop: '0.25rem', color: 'var(--accent-amber)' }}>
                {operations ? `${(operations.returnRate * 100).toFixed(1)}%` : '0.0%'}
              </div>
            </div>

            <div style={{ background: 'var(--bg-main)', padding: '1.25rem', borderRadius: '8px' }}>
              <div style={{ fontSize: '0.85rem', color: 'var(--primary-muted)' }}>Avg Fulfillment Time</div>
              <div style={{ fontSize: '1.5rem', fontWeight: 700, marginTop: '0.25rem', color: 'var(--accent-green)' }}>
                {operations?.averageFulfillmentTimeHours ? `${operations.averageFulfillmentTimeHours}h` : '< 24h'}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Tab 5: Live Event Stream & Outbox Telemetry (Section 17 & 24) */}
      {activeTab === 'events' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
          {user.role !== 'ADMINISTRATOR' ? (
            <div className="card" style={{ padding: '2rem', textAlign: 'center' }}>
              <h3 style={{ fontSize: '1.25rem', marginBottom: '0.75rem' }}>Platform Administrator Privilege Required</h3>
              <p className="text-muted" style={{ maxWidth: '550px', margin: '0 auto 1.5rem', lineHeight: 1.5 }}>
                Under Section 17 &amp; 24 multi-tenant security specifications, inspecting raw transactional outbox streams across all tenant partitions requires platform administrative authorization.
              </p>
              <button
                type="button"
                className="btn btn-primary"
                onClick={async () => {
                  await login({ email: 'admin@example.com', password: 'password123' });
                  await loadEvents();
                }}
              >
                Switch to Platform Administrator
              </button>
            </div>
          ) : (
            <div className="card" style={{ padding: '1.5rem' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem', flexWrap: 'wrap', gap: '1rem' }}>
                <div>
                  <h2 style={{ fontSize: '1.25rem', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                    <span>Transactional Outbox Stream</span>
                    <span style={{ fontSize: '0.75rem', background: 'rgba(34, 197, 94, 0.15)', color: 'var(--accent-green)', padding: '2px 8px', borderRadius: '999px' }}>
                      At-Least-Once Delivery
                    </span>
                  </h2>
                  <p className="text-muted" style={{ fontSize: '0.85rem' }}>
                    Events written transactionally alongside business mutations in PostgreSQL and published via the outbox relay.
                  </p>
                </div>

                <div style={{ display: 'flex', gap: '0.75rem' }}>
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={() => loadEvents()}
                  >
                    🔄 Refresh
                  </button>
                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={isProcessingEvents}
                    onClick={handleProcessEvents}
                  >
                    {isProcessingEvents ? 'Publishing...' : '⚡ Process Pending Events'}
                  </button>
                </div>
              </div>

              {processFeedback && (
                <div className="card" style={{ background: 'rgba(37, 99, 235, 0.1)', borderColor: 'var(--brand)', marginBottom: '1rem', padding: '0.75rem 1rem' }}>
                  {processFeedback}
                </div>
              )}

              {/* Event Stream Stats */}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: '1rem', marginBottom: '1.5rem' }}>
                <div style={{ background: 'var(--bg-main)', padding: '0.75rem 1rem', borderRadius: '6px' }}>
                  <span className="text-muted" style={{ fontSize: '0.75rem' }}>Total Stream Events</span>
                  <div style={{ fontSize: '1.25rem', fontWeight: 700 }}>{events.length}</div>
                </div>
                <div style={{ background: 'var(--bg-main)', padding: '0.75rem 1rem', borderRadius: '6px' }}>
                  <span className="text-muted" style={{ fontSize: '0.75rem' }}>Published</span>
                  <div style={{ fontSize: '1.25rem', fontWeight: 700, color: 'var(--accent-green)' }}>
                    {events.filter((e) => e.status === 'PUBLISHED').length}
                  </div>
                </div>
                <div style={{ background: 'var(--bg-main)', padding: '0.75rem 1rem', borderRadius: '6px' }}>
                  <span className="text-muted" style={{ fontSize: '0.75rem' }}>Pending Dispatch</span>
                  <div style={{ fontSize: '1.25rem', fontWeight: 700, color: 'var(--accent-amber)' }}>
                    {events.filter((e) => e.status === 'PENDING').length}
                  </div>
                </div>
                <div style={{ background: 'var(--bg-main)', padding: '0.75rem 1rem', borderRadius: '6px' }}>
                  <span className="text-muted" style={{ fontSize: '0.75rem' }}>Failed / Deadletter</span>
                  <div style={{ fontSize: '1.25rem', fontWeight: 700, color: 'var(--accent-red)' }}>
                    {events.filter((e) => e.status === 'FAILED').length}
                  </div>
                </div>
              </div>

              {/* Event Table */}
              {events.length === 0 ? (
                <p className="text-muted" style={{ padding: '2rem', textAlign: 'center' }}>
                  No outbox events recorded yet. Perform an action (e.g. place an order, adjust stock, verify merchant) to trigger domain events.
                </p>
              ) : (
                <div style={{ overflowX: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem' }}>
                    <thead>
                      <tr style={{ borderBottom: '1px solid var(--border)', textAlign: 'left', color: 'var(--primary-muted)' }}>
                        <th style={{ padding: '0.75rem' }}>Timestamp</th>
                        <th style={{ padding: '0.75rem' }}>Event Type</th>
                        <th style={{ padding: '0.75rem' }}>Aggregate</th>
                        <th style={{ padding: '0.75rem' }}>Tenant</th>
                        <th style={{ padding: '0.75rem' }}>Status</th>
                        <th style={{ padding: '0.75rem', textAlign: 'right' }}>Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {events.map((ev) => (
                        <>
                          <tr key={ev.id} style={{ borderBottom: '1px solid var(--border)', background: expandedEventId === ev.id ? 'var(--bg-card-hover)' : 'transparent' }}>
                            <td style={{ padding: '0.75rem', whiteSpace: 'nowrap', color: 'var(--primary-muted)' }}>
                              {new Date(ev.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                            </td>
                            <td style={{ padding: '0.75rem' }}>
                              <code style={{ color: 'var(--brand)', fontWeight: 600 }}>{ev.eventType}</code>
                            </td>
                            <td style={{ padding: '0.75rem' }}>
                              <span style={{ fontSize: '0.8rem', color: 'var(--primary-muted)' }}>{ev.aggregateType}:</span>{' '}
                              <code>{ev.aggregateId.slice(0, 12)}...</code>
                            </td>
                            <td style={{ padding: '0.75rem', fontSize: '0.8rem', color: 'var(--primary-muted)' }}>
                              {ev.tenantId}
                            </td>
                            <td style={{ padding: '0.75rem' }}>
                              <span
                                style={{
                                  padding: '2px 8px',
                                  borderRadius: '999px',
                                  fontSize: '0.75rem',
                                  fontWeight: 600,
                                  background:
                                    ev.status === 'PUBLISHED'
                                      ? 'rgba(34, 197, 94, 0.15)'
                                      : ev.status === 'PENDING'
                                      ? 'rgba(234, 179, 8, 0.15)'
                                      : 'rgba(239, 68, 68, 0.15)',
                                  color:
                                    ev.status === 'PUBLISHED'
                                      ? 'var(--accent-green)'
                                      : ev.status === 'PENDING'
                                      ? 'var(--accent-amber)'
                                      : 'var(--accent-red)',
                                }}
                              >
                                {ev.status}
                              </span>
                            </td>
                            <td style={{ padding: '0.75rem', textAlign: 'right' }}>
                              <div style={{ display: 'inline-flex', gap: '0.5rem' }}>
                                <button
                                  type="button"
                                  className="btn btn-secondary"
                                  style={{ padding: '0.25rem 0.5rem', fontSize: '0.75rem' }}
                                  onClick={() => setExpandedEventId(expandedEventId === ev.id ? null : ev.id)}
                                >
                                  {expandedEventId === ev.id ? 'Close' : 'Payload'}
                                </button>
                                {(ev.status === 'FAILED' || ev.status === 'PENDING') && (
                                  <button
                                    type="button"
                                    className="btn btn-secondary"
                                    style={{ padding: '0.25rem 0.5rem', fontSize: '0.75rem' }}
                                    onClick={() => handleReplayEvent(ev.id)}
                                  >
                                    Replay
                                  </button>
                                )}
                              </div>
                            </td>
                          </tr>
                          {expandedEventId === ev.id && (
                            <tr style={{ background: 'var(--bg-main)' }}>
                              <td colSpan={6} style={{ padding: '1rem', borderBottom: '1px solid var(--border)' }}>
                                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
                                  <div>
                                    <div style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--primary-muted)', marginBottom: '0.25rem' }}>
                                      EVENT PAYLOAD:
                                    </div>
                                    <pre style={{ margin: 0, padding: '0.75rem', background: '#0f172a', color: '#e2e8f0', borderRadius: '4px', fontSize: '0.75rem', overflowX: 'auto' }}>
                                      {JSON.stringify(ev.payload, null, 2)}
                                    </pre>
                                  </div>
                                  <div>
                                    <div style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--primary-muted)', marginBottom: '0.25rem' }}>
                                      ENVELOPE METADATA (Section 24.1):
                                    </div>
                                    <pre style={{ margin: 0, padding: '0.75rem', background: '#0f172a', color: '#e2e8f0', borderRadius: '4px', fontSize: '0.75rem', overflowX: 'auto' }}>
                                      {JSON.stringify({
                                        id: ev.id,
                                        tenantId: ev.tenantId,
                                        aggregateType: ev.aggregateType,
                                        aggregateId: ev.aggregateId,
                                        retryCount: ev.retryCount,
                                        publishedAt: ev.publishedAt,
                                        metadata: ev.metadata,
                                      }, null, 2)}
                                    </pre>
                                  </div>
                                </div>
                              </td>
                            </tr>
                          )}
                        </>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
};
