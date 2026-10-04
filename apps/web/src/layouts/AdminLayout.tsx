import { Outlet, Link, Navigate } from 'react-router-dom';
import { useAuth } from '../features/auth/AuthContext';

export const AdminLayout = () => {
  const { isAuthenticated, user, isLoading } = useAuth();

  if (isLoading) {
    return <div>Loading...</div>;
  }

  if (!isAuthenticated || user?.role !== 'ADMINISTRATOR') {
    return <Navigate to="/account" replace />;
  }

  return (
    <div className="app-layout">
      <header className="app-header" style={{ background: 'rgba(255, 51, 102, 0.1)' }}>
        <Link to="/admin" className="brand-logo">
          <span>Admin</span> Console
        </Link>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
          <Link to="/admin" className="btn btn-secondary" style={{ fontSize: '0.78rem', padding: '0.3rem 0.6rem' }}>Dashboard</Link>
          <Link to="/admin/users" className="btn btn-secondary" style={{ fontSize: '0.78rem', padding: '0.3rem 0.6rem' }}>Users</Link>
          <Link to="/admin/merchants" className="btn btn-secondary" style={{ fontSize: '0.78rem', padding: '0.3rem 0.6rem' }}>Merchants</Link>
          <Link to="/admin/catalog" className="btn btn-secondary" style={{ fontSize: '0.78rem', padding: '0.3rem 0.6rem' }}>Catalog</Link>
          <Link to="/admin/listings" className="btn btn-secondary" style={{ fontSize: '0.78rem', padding: '0.3rem 0.6rem' }}>Listings</Link>
          <Link to="/admin/inventory" className="btn btn-secondary" style={{ fontSize: '0.78rem', padding: '0.3rem 0.6rem' }}>Inventory</Link>
          <Link to="/admin/orders" className="btn btn-secondary" style={{ fontSize: '0.78rem', padding: '0.3rem 0.6rem' }}>Orders</Link>
          <Link to="/admin/payments" className="btn btn-secondary" style={{ fontSize: '0.78rem', padding: '0.3rem 0.6rem' }}>Payments</Link>
          <Link to="/admin/settlements" className="btn btn-secondary" style={{ fontSize: '0.78rem', padding: '0.3rem 0.6rem' }}>Settlements</Link>
          <Link to="/admin/events" className="btn btn-secondary" style={{ fontSize: '0.78rem', padding: '0.3rem 0.6rem' }}>Events</Link>
          <Link to="/admin/security" className="btn btn-secondary" style={{ fontSize: '0.78rem', padding: '0.3rem 0.6rem' }}>Security</Link>
          <Link to="/admin/analytics" className="btn btn-secondary" style={{ fontSize: '0.78rem', padding: '0.3rem 0.6rem' }}>Telemetry</Link>
          <Link to="/" className="btn btn-primary" style={{ fontSize: '0.78rem', padding: '0.3rem 0.7rem' }}>Storefront</Link>
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
