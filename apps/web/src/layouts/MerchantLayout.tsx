import { Outlet, Link, Navigate } from 'react-router-dom';
import { useAuth } from '../features/auth/AuthContext';

export const MerchantLayout = () => {
  const { isAuthenticated, user, isLoading } = useAuth();

  if (isLoading) {
    return <div>Loading...</div>;
  }

  if (!isAuthenticated || user?.role !== 'MERCHANT') {
    return <Navigate to="/account" replace />;
  }

  return (
    <div className="app-layout">
      <header className="app-header">
        <Link to="/merchant" className="brand-logo">
          <span>Seller</span> Portal
        </Link>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
          <Link to="/merchant" className="btn btn-secondary" style={{ fontSize: '0.8rem', padding: '0.35rem 0.65rem' }}>Dashboard</Link>
          <Link to="/merchant/listings" className="btn btn-secondary" style={{ fontSize: '0.8rem', padding: '0.35rem 0.65rem' }}>Listings</Link>
          <Link to="/merchant/inventory" className="btn btn-secondary" style={{ fontSize: '0.8rem', padding: '0.35rem 0.65rem' }}>Inventory</Link>
          <Link to="/merchant/orders" className="btn btn-secondary" style={{ fontSize: '0.8rem', padding: '0.35rem 0.65rem' }}>Orders</Link>
          <Link to="/merchant/fulfillment" className="btn btn-secondary" style={{ fontSize: '0.8rem', padding: '0.35rem 0.65rem' }}>Fulfillment</Link>
          <Link to="/merchant/returns" className="btn btn-secondary" style={{ fontSize: '0.8rem', padding: '0.35rem 0.65rem' }}>Returns</Link>
          <Link to="/merchant/finance" className="btn btn-secondary" style={{ fontSize: '0.8rem', padding: '0.35rem 0.65rem' }}>Finance</Link>
          <Link to="/merchant/analytics" className="btn btn-secondary" style={{ fontSize: '0.8rem', padding: '0.35rem 0.65rem' }}>Analytics</Link>
          <Link to="/merchant/onboarding" className="btn btn-secondary" style={{ fontSize: '0.8rem', padding: '0.35rem 0.65rem' }}>Store KYC</Link>
          <Link to="/merchant/settings" className="btn btn-secondary" style={{ fontSize: '0.8rem', padding: '0.35rem 0.65rem' }}>Settings</Link>
          <Link to="/" className="btn btn-primary" style={{ fontSize: '0.8rem', padding: '0.35rem 0.75rem' }}>Storefront</Link>
        </div>
      </header>
      <main className="main-content">
        <div className="container">
          <Outlet />
        </div>
      </main>
    </div>
  );
};
