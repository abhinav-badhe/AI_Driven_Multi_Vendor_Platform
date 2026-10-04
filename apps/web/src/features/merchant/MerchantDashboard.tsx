import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { merchantApi, type MerchantProfileDto, type MerchantListingDto, type InventoryItemDto, type SellerOrderDto, type FinancialSummaryDto } from './api/merchant';
import { useAuth } from '../auth/AuthContext';

export const MerchantDashboard = () => {
  const { user, login } = useAuth();
  const [profile, setProfile] = useState<MerchantProfileDto | null>(null);
  const [listings, setListings] = useState<MerchantListingDto[]>([]);
  const [inventory, setInventory] = useState<InventoryItemDto[]>([]);
  const [orders, setOrders] = useState<SellerOrderDto[]>([]);
  const [financials, setFinancials] = useState<FinancialSummaryDto | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const loadMerchantData = async () => {
      setIsLoading(true);
      setError(null);
      try {
        const [prof, list, inv, ord] = await Promise.all([
          merchantApi.getProfile().catch(() => null),
          merchantApi.getMyListings().catch(() => []),
          merchantApi.getMyInventory().catch(() => []),
          merchantApi.getSellerOrders().catch(() => []),
        ]);
        setProfile(prof);
        setListings(list);
        setInventory(inv);
        setOrders(ord);

        const merchantId = prof?.id ?? user?.tenantId ?? 'tenant-merchant-1';
        const fin = await merchantApi.getFinancialSummary(merchantId).catch(() => null);
        setFinancials(fin);
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : 'Failed to load merchant data');
      } finally {
        setIsLoading(false);
      }
    };
    loadMerchantData();
  }, [user]);

  if (user?.role !== 'MERCHANT' && user?.role !== 'ADMINISTRATOR') {
    return (
      <div className="container" style={{ padding: '3rem 1rem', maxWidth: '600px', margin: '0 auto', textAlign: 'center' }}>
        <div className="card" style={{ padding: '2.5rem' }}>
          <h2 style={{ fontSize: '1.5rem', marginBottom: '0.75rem' }}>Merchant Portal</h2>
          <p className="text-muted" style={{ marginBottom: '1.5rem' }}>
            To access the Merchant Seller Hub, please log in with a verified merchant account.
          </p>
          <button
            type="button"
            className="btn btn-primary"
            onClick={async () => {
              await login({ email: 'merchant@example.com', password: 'password123' });
            }}
          >
            Log In as Demo Merchant (Apex Electronics)
          </button>
        </div>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="container" style={{ padding: '3rem 1rem', textAlign: 'center' }}>
        <p className="text-muted">Loading Merchant Dashboard metrics...</p>
      </div>
    );
  }

  const totalStock = inventory.reduce((sum, item) => sum + (item.onHandQuantity - item.reservedQuantity), 0);
  const totalSales = orders.reduce((sum, ord) => sum + ord.totalAmount, 0) / 100;

  return (
    <div className="container" style={{ padding: '2rem 1rem 4rem' }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '2rem' }}>
        <div>
          <h1 className="font-display" style={{ fontSize: '2rem', marginBottom: '0.25rem' }}>
            Merchant Seller Hub
          </h1>
          <p className="text-muted">
            {profile?.businessName ?? 'Apex Electronics'} &bull; Status: <span style={{ color: 'var(--accent-green)', fontWeight: 600 }}>{profile?.verificationStatus ?? 'VERIFIED'}</span>
          </p>
        </div>

        <div style={{ display: 'flex', gap: '0.75rem' }}>
          <Link to="/merchant/listings" className="btn btn-secondary">
            Manage Listings ({listings.length})
          </Link>
          <Link to="/merchant/inventory" className="btn btn-secondary">
            Inventory Stock
          </Link>
          <Link to="/merchant/orders" className="btn btn-primary">
            Fulfill Orders ({orders.length})
          </Link>
        </div>
      </div>

      {error && (
        <div className="card" style={{ borderColor: 'var(--accent-red)', color: 'var(--accent-red)', marginBottom: '1.5rem' }}>
          {error}
        </div>
      )}

      {/* KPI Cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '1.5rem', marginBottom: '2rem' }}>
        <div className="card" style={{ padding: '1.5rem' }}>
          <span className="text-muted" style={{ fontSize: '0.85rem' }}>Total Active Listings</span>
          <div style={{ fontSize: '1.75rem', fontWeight: 700, marginTop: '0.5rem', color: 'var(--brand)' }}>
            {listings.length}
          </div>
          <span style={{ fontSize: '0.75rem', color: 'var(--accent-green)' }}>Multi-vendor synced</span>
        </div>

        <div className="card" style={{ padding: '1.5rem' }}>
          <span className="text-muted" style={{ fontSize: '0.85rem' }}>Sellable Inventory</span>
          <div style={{ fontSize: '1.75rem', fontWeight: 700, marginTop: '0.5rem', color: 'var(--accent-green)' }}>
            {totalStock} units
          </div>
          <span style={{ fontSize: '0.75rem', color: 'var(--primary-muted)' }}>Across all listings</span>
        </div>

        <div className="card" style={{ padding: '1.5rem' }}>
          <span className="text-muted" style={{ fontSize: '0.85rem' }}>Seller Orders</span>
          <div style={{ fontSize: '1.75rem', fontWeight: 700, marginTop: '0.5rem', color: 'var(--accent-blue)' }}>
            {orders.length}
          </div>
          <span style={{ fontSize: '0.75rem', color: 'var(--primary-muted)' }}>Customer purchases</span>
        </div>

        <div className="card" style={{ padding: '1.5rem' }}>
          <span className="text-muted" style={{ fontSize: '0.85rem' }}>Gross Revenue</span>
          <div style={{ fontSize: '1.75rem', fontWeight: 700, marginTop: '0.5rem', color: 'var(--accent-amber)' }}>
            ₹{totalSales.toLocaleString('en-IN')}
          </div>
          <span style={{ fontSize: '0.75rem', color: 'var(--accent-green)' }}>Subject to settlement ledger</span>
        </div>
      </div>

      {/* Financial Settlement & Ledger */}
      {financials && (
        <div className="card" style={{ padding: '1.5rem', marginBottom: '2rem' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem', borderBottom: '1px solid var(--border)', paddingBottom: '0.75rem' }}>
            <div>
              <h2 style={{ fontSize: '1.25rem', fontWeight: 600 }}>Financial Settlement &amp; Ledger</h2>
              <p className="text-muted" style={{ fontSize: '0.85rem' }}>Authoritative double-entry balance accounts</p>
            </div>
            <span style={{ fontSize: '0.85rem', color: 'var(--accent-green)', fontWeight: 600 }}>
              ✓ {financials.ledgerCount} Immutable Ledger Journals
            </span>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '1rem' }}>
            <div style={{ background: 'var(--bg-main)', padding: '1rem', borderRadius: '8px' }}>
              <span className="text-muted" style={{ fontSize: '0.8rem' }}>Current Balance</span>
              <div style={{ fontSize: '1.35rem', fontWeight: 700, color: 'var(--accent-green)' }}>
                ₹{(financials.currentBalance / 100).toLocaleString('en-IN')}
              </div>
            </div>
            <div style={{ background: 'var(--bg-main)', padding: '1rem', borderRadius: '8px' }}>
              <span className="text-muted" style={{ fontSize: '0.8rem' }}>Total Earnings</span>
              <div style={{ fontSize: '1.35rem', fontWeight: 700, color: 'var(--brand)' }}>
                ₹{(financials.totalEarnings / 100).toLocaleString('en-IN')}
              </div>
            </div>
            <div style={{ background: 'var(--bg-main)', padding: '1rem', borderRadius: '8px' }}>
              <span className="text-muted" style={{ fontSize: '0.8rem' }}>Platform Commission</span>
              <div style={{ fontSize: '1.35rem', fontWeight: 700, color: 'var(--accent-amber)' }}>
                ₹{(financials.totalCommissions / 100).toLocaleString('en-IN')}
              </div>
            </div>
            <div style={{ background: 'var(--bg-main)', padding: '1rem', borderRadius: '8px' }}>
              <span className="text-muted" style={{ fontSize: '0.8rem' }}>Refund Deductions</span>
              <div style={{ fontSize: '1.35rem', fontWeight: 700, color: 'var(--accent-red)' }}>
                ₹{(financials.totalRefunds / 100).toLocaleString('en-IN')}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Recent Orders Overview */}
      <div className="card" style={{ padding: '1.5rem' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
          <h2 style={{ fontSize: '1.25rem', fontWeight: 600 }}>Active Seller Orders</h2>
          <Link to="/merchant/orders" style={{ fontSize: '0.85rem', color: 'var(--brand)' }}>
            View All &rarr;
          </Link>
        </div>

        {orders.length === 0 ? (
          <p className="text-muted" style={{ padding: '1.5rem 0', textAlign: 'center' }}>
            No customer orders assigned to your merchant tenant yet.
          </p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
            {orders.slice(0, 5).map((ord) => (
              <div key={ord.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '0.75rem 0', borderBottom: '1px solid var(--border)' }}>
                <div>
                  <strong>Order #{ord.id.slice(0, 8)}</strong>
                  <div style={{ fontSize: '0.8rem', color: 'var(--primary-muted)' }}>
                    Customer Order: {ord.customerOrderId.slice(0, 8)} &bull; {new Date(ord.createdAt).toLocaleDateString()}
                  </div>
                </div>

                <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
                  <span style={{ fontWeight: 600 }}>
                    ₹{(ord.totalAmount / 100).toLocaleString('en-IN')}
                  </span>
                  <span style={{ background: 'rgba(59, 130, 246, 0.15)', color: 'var(--accent-blue)', padding: '0.2rem 0.6rem', borderRadius: '4px', fontSize: '0.8rem', fontWeight: 600 }}>
                    {ord.status}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};
