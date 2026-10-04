import { BrowserRouter, Routes, Route, Link, useNavigate } from 'react-router-dom';
import { AuthProvider } from '../features/auth/AuthContext';
import { CartProvider } from '../features/cart/CartContext';
import { CustomerLayout } from '../layouts/CustomerLayout';
import { MerchantLayout } from '../layouts/MerchantLayout';
import { AdminLayout } from '../layouts/AdminLayout';

import { useAuth } from '../features/auth/AuthContext';
import type { LoginCredentials, UserContext } from '../features/auth/AuthContext';
import { useState, useEffect } from 'react';
import { apiClient } from '../api/client';

import { Home } from '../features/home/Home';
import { CategoryPage } from '../features/catalog/Category';
import { ProductPage } from '../features/catalog/Product';
import { SearchPage } from '../features/search/SearchPage';
import { CartPage } from '../features/cart/CartPage';
import { CheckoutPage } from '../features/checkout/CheckoutPage';
import { CustomerOrders } from '../features/orders/CustomerOrders';
import { CustomerReturns } from '../features/orders/CustomerReturns';

import { MerchantDashboard } from '../features/merchant/MerchantDashboard';
import { MerchantListings } from '../features/merchant/MerchantListings';
import { MerchantInventory } from '../features/merchant/MerchantInventory';
import { MerchantOrders } from '../features/merchant/MerchantOrders';
import { MerchantOnboarding } from '../features/merchant/MerchantOnboarding';
import { MerchantFinance } from '../features/merchant/MerchantFinance';
import { MerchantFulfillment } from '../features/merchant/MerchantFulfillment';
import { MerchantReturns } from '../features/merchant/MerchantReturns';
import { MerchantSettings } from '../features/merchant/MerchantSettings';

import { AdminDashboard } from '../features/admin/AdminDashboard';
import { AdminMerchants } from '../features/admin/AdminMerchants';
import { AdminSettlements } from '../features/admin/AdminSettlements';
import { AdminUsers } from '../features/admin/AdminUsers';
import { AdminCatalog } from '../features/admin/AdminCatalog';
import { AdminListings } from '../features/admin/AdminListings';
import { AdminInventory } from '../features/admin/AdminInventory';
import { AdminOrders } from '../features/admin/AdminOrders';
import { AdminPayments } from '../features/admin/AdminPayments';
import { AdminEvents } from '../features/admin/AdminEvents';
import { AdminSecurity } from '../features/admin/AdminSecurity';
import { AnalyticsDashboard } from '../features/analytics/AnalyticsDashboard';
import { ShipmentTracker } from '../features/fulfillment/ShipmentTracker';

interface NotificationPrefDto {
  emailEnabled?: boolean;
  smsEnabled?: boolean;
  pushEnabled?: boolean;
}

const CustomerAccount = ({ redirectAfterLogin = false }: { redirectAfterLogin?: boolean } = {}) => {
  const navigate = useNavigate();
  const { isAuthenticated, user, login, logout, isLoading } = useAuth();
  const [activeTab, setActiveTab] = useState<'profile' | 'preferences' | 'addresses'>('profile');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Notification preferences state
  const [prefs, setPrefs] = useState<NotificationPrefDto>({
    emailEnabled: true,
    smsEnabled: true,
    pushEnabled: true,
  });
  const [prefSavedMsg, setPrefSavedMsg] = useState<string | null>(null);

  useEffect(() => {
    if (isAuthenticated) {
      apiClient<NotificationPrefDto>('/customers/me/notification-preferences')
        .then((p) => {
          if (p) setPrefs(p);
        })
        .catch(() => null);
    }
  }, [isAuthenticated]);

  const handleSavePreferences = async () => {
    try {
      await apiClient<NotificationPrefDto>('/customers/me/notification-preferences', {
        method: 'PUT',
        body: JSON.stringify(prefs),
      });
      setPrefSavedMsg('Notification preferences saved successfully!');
      setTimeout(() => setPrefSavedMsg(null), 3000);
    } catch (err: unknown) {
      alert(`Save failed: ${err instanceof Error ? err.message : 'Error'}`);
    }
  };

  if (isLoading) return <div className="p-4 container">Loading auth state...</div>;

  if (isAuthenticated && user) {
    return (
      <div className="container" style={{ padding: '2rem 1rem 4rem', maxWidth: '680px', margin: '0 auto' }}>
        <div className="card" style={{ padding: '2rem' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem', flexWrap: 'wrap', gap: '0.75rem' }}>
            <div>
              <h1 className="font-display" style={{ fontSize: '1.6rem', marginBottom: '0.2rem' }}>My Account</h1>
              <p className="text-muted" style={{ fontSize: '0.85rem' }}>Personal profile, order management &amp; event preferences</p>
            </div>
            <button className="btn btn-secondary" onClick={() => logout()}>
              Log Out
            </button>
          </div>

          {/* Sub Navigation Tabs */}
          <div style={{ display: 'flex', gap: '0.5rem', borderBottom: '1px solid var(--border)', marginBottom: '1.5rem' }}>
            <button
              type="button"
              onClick={() => setActiveTab('profile')}
              style={{
                padding: '0.5rem 1rem',
                background: 'transparent',
                border: 'none',
                borderBottom: activeTab === 'profile' ? '2px solid var(--brand)' : '2px solid transparent',
                color: activeTab === 'profile' ? 'var(--brand)' : 'var(--primary-muted)',
                fontWeight: 600,
                cursor: 'pointer',
              }}
            >
              Profile &amp; Identity
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('preferences')}
              style={{
                padding: '0.5rem 1rem',
                background: 'transparent',
                border: 'none',
                borderBottom: activeTab === 'preferences' ? '2px solid var(--brand)' : '2px solid transparent',
                color: activeTab === 'preferences' ? 'var(--brand)' : 'var(--primary-muted)',
                fontWeight: 600,
                cursor: 'pointer',
              }}
            >
              Notification Preferences
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('addresses')}
              style={{
                padding: '0.5rem 1rem',
                background: 'transparent',
                border: 'none',
                borderBottom: activeTab === 'addresses' ? '2px solid var(--brand)' : '2px solid transparent',
                color: activeTab === 'addresses' ? 'var(--brand)' : 'var(--primary-muted)',
                fontWeight: 600,
                cursor: 'pointer',
              }}
            >
              Saved Addresses
            </button>
          </div>

          {/* Tab 1: Profile */}
          {activeTab === 'profile' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
              <div style={{ background: 'var(--bg-main)', padding: '1rem', borderRadius: '8px' }}>
                <span className="text-muted" style={{ fontSize: '0.8rem' }}>Registered Email Address</span>
                <div style={{ fontWeight: 600, fontSize: '1rem', marginTop: '0.2rem' }}>{user.email}</div>
              </div>

              <div style={{ background: 'var(--bg-main)', padding: '1rem', borderRadius: '8px' }}>
                <span className="text-muted" style={{ fontSize: '0.8rem' }}>Assigned RBAC Role</span>
                <div style={{ fontWeight: 700, color: 'var(--brand)', marginTop: '0.2rem' }}>{user.role}</div>
              </div>

              <div style={{ background: 'var(--bg-main)', padding: '1rem', borderRadius: '8px' }}>
                <span className="text-muted" style={{ fontSize: '0.8rem' }}>Tenant Boundary Context</span>
                <div style={{ marginTop: '0.2rem' }}><code>{user.tenantId}</code></div>
              </div>

              <div style={{ display: 'flex', gap: '1rem', marginTop: '0.5rem' }}>
                <Link to="/orders" className="btn btn-secondary" style={{ flex: 1, textAlign: 'center' }}>
                  📦 View Orders
                </Link>
                <Link to="/returns" className="btn btn-secondary" style={{ flex: 1, textAlign: 'center' }}>
                  🔄 View Returns
                </Link>
              </div>
            </div>
          )}

          {/* Tab 2: Notification Preferences (Section 20) */}
          {activeTab === 'preferences' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
              {prefSavedMsg && (
                <div style={{ background: 'rgba(34, 197, 94, 0.15)', color: 'var(--accent-green)', padding: '0.6rem 1rem', borderRadius: '6px', fontSize: '0.85rem' }}>
                  {prefSavedMsg}
                </div>
              )}

              <label style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0.85rem', background: 'var(--bg-main)', borderRadius: '6px', cursor: 'pointer' }}>
                <div>
                  <div style={{ fontWeight: 600, fontSize: '0.9rem' }}>Email Notifications</div>
                  <div style={{ fontSize: '0.8rem', color: 'var(--primary-muted)' }}>Receive order receipts and payment confirmation invoices</div>
                </div>
                <input
                  type="checkbox"
                  checked={prefs.emailEnabled ?? true}
                  onChange={(e) => setPrefs({ ...prefs, emailEnabled: e.target.checked })}
                  style={{ width: '1.2rem', height: '1.2rem' }}
                />
              </label>

              <label style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0.85rem', background: 'var(--bg-main)', borderRadius: '6px', cursor: 'pointer' }}>
                <div>
                  <div style={{ fontWeight: 600, fontSize: '0.9rem' }}>SMS Text Alerts</div>
                  <div style={{ fontSize: '0.8rem', color: 'var(--primary-muted)' }}>Instant OTP verification and out-for-delivery alerts</div>
                </div>
                <input
                  type="checkbox"
                  checked={prefs.smsEnabled ?? true}
                  onChange={(e) => setPrefs({ ...prefs, smsEnabled: e.target.checked })}
                  style={{ width: '1.2rem', height: '1.2rem' }}
                />
              </label>

              <label style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0.85rem', background: 'var(--bg-main)', borderRadius: '6px', cursor: 'pointer' }}>
                <div>
                  <div style={{ fontWeight: 600, fontSize: '0.9rem' }}>Push Notifications</div>
                  <div style={{ fontSize: '0.8rem', color: 'var(--primary-muted)' }}>Hyperlocal 10-15 minute live shipment tracking notifications</div>
                </div>
                <input
                  type="checkbox"
                  checked={prefs.pushEnabled ?? true}
                  onChange={(e) => setPrefs({ ...prefs, pushEnabled: e.target.checked })}
                  style={{ width: '1.2rem', height: '1.2rem' }}
                />
              </label>

              <button
                type="button"
                className="btn btn-primary"
                onClick={handleSavePreferences}
                style={{ marginTop: '0.5rem', alignSelf: 'flex-start' }}
              >
                Save Preferences
              </button>
            </div>
          )}

          {/* Tab 3: Saved Addresses */}
          {activeTab === 'addresses' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
              <div style={{ border: '2px solid var(--brand)', borderRadius: '8px', padding: '1rem', background: 'var(--bg-main)' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.4rem' }}>
                  <span style={{ fontWeight: 700, fontSize: '0.95rem' }}>Primary Home Address</span>
                  <span style={{ fontSize: '0.7rem', background: 'var(--brand)', color: '#fff', padding: '1px 6px', borderRadius: '4px', fontWeight: 700 }}>
                    DEFAULT
                  </span>
                </div>
                <div style={{ fontSize: '0.85rem', lineHeight: 1.5, color: 'var(--text-main)' }}>
                  B-42, Bandra West<br />
                  Near Bandstand, Mumbai, Maharashtra<br />
                  PIN: <strong>400050</strong> (India)
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    );
  }

  const doLoginAndRedirect = async (creds: LoginCredentials) => {
    const me = await login(creds) as UserContext | undefined;
    if (redirectAfterLogin && me) {
      if (me.role === 'MERCHANT') navigate('/merchant');
      else if (me.role === 'ADMINISTRATOR') navigate('/admin');
      else navigate('/orders');
    }
  };

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setIsSubmitting(true);
    const creds: LoginCredentials = { email, password };
    try {
      await doLoginAndRedirect(creds);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Login failed';
      setError(message);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="container" style={{ padding: '2rem 1rem', maxWidth: '440px', margin: '0 auto' }}>
      <div className="card" style={{ padding: '2rem' }}>
        <h2 style={{ fontSize: '1.5rem', marginBottom: '1rem', textAlign: 'center' }}>Sign In</h2>
        {error && <div className="card" style={{ borderColor: 'var(--accent-red)', color: 'var(--accent-red)', marginBottom: '1rem', padding: '0.75rem' }}>{error}</div>}
        <form onSubmit={handleLogin} style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          <div>
            <label style={{ display: 'block', fontSize: '0.85rem', marginBottom: '0.25rem', color: 'var(--primary-muted)' }}>Email</label>
            <input 
              type="email" 
              placeholder="e.g. customer@example.com" 
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="input-field"
              style={{ width: '100%' }}
              required 
            />
          </div>
          <div>
            <label style={{ display: 'block', fontSize: '0.85rem', marginBottom: '0.25rem', color: 'var(--primary-muted)' }}>Password</label>
            <input 
              type="password" 
              placeholder="••••••••" 
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="input-field"
              style={{ width: '100%' }}
              required 
            />
          </div>
          <button type="submit" disabled={isSubmitting} className="btn btn-primary" style={{ marginTop: '0.5rem' }}>
            {isSubmitting ? 'Signing in...' : 'Sign In'}
          </button>
        </form>

        <div style={{ marginTop: '1.5rem', paddingTop: '1rem', borderTop: '1px solid var(--border)', textAlign: 'center' }}>
          <p className="text-muted" style={{ fontSize: '0.8rem', marginBottom: '0.5rem' }}>
            Fast Demo Logins (password: <code>password123</code>):
          </p>
          <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'center', flexWrap: 'wrap' }}>
            <button
              type="button"
              className="btn btn-secondary"
              style={{ fontSize: '0.75rem', padding: '0.25rem 0.5rem' }}
              onClick={() => doLoginAndRedirect({ email: 'customer@example.com', password: 'password123' })}
            >
              Customer
            </button>
            <button
              type="button"
              className="btn btn-secondary"
              style={{ fontSize: '0.75rem', padding: '0.25rem 0.5rem' }}
              onClick={() => doLoginAndRedirect({ email: 'merchant@example.com', password: 'password123' })}
            >
              Merchant
            </button>
            <button
              type="button"
              className="btn btn-secondary"
              style={{ fontSize: '0.75rem', padding: '0.25rem 0.5rem' }}
              onClick={() => doLoginAndRedirect({ email: 'admin@example.com', password: 'password123' })}
            >
              Admin
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export const AppRoutes = () => {
  return (
    <AuthProvider>
      <CartProvider>
        <BrowserRouter>
          <Routes>
            {/* Customer & Marketplace Catalog Routes */}
            <Route path="/" element={<CustomerLayout />}>
              <Route index element={<Home />} />
              <Route path="search" element={<SearchPage />} />
              <Route path="category/:id" element={<CategoryPage />} />
              <Route path="product/:id" element={<ProductPage />} />
              <Route path="cart" element={<CartPage />} />
              <Route path="checkout" element={<CheckoutPage />} />
              <Route path="orders" element={<CustomerOrders />} />
              <Route path="orders/:id" element={<CustomerOrders />} />
              <Route path="returns" element={<CustomerReturns />} />
              <Route path="fulfillment/:id" element={<ShipmentTracker />} />
              <Route path="analytics" element={<AnalyticsDashboard />} />
              {/* /account renders the profile + tab panel when already logged in */}
              <Route path="account" element={<CustomerAccount />} />
              {/* /login and /register redirect-aware aliases */}
              <Route path="login" element={<CustomerAccount redirectAfterLogin />} />
              <Route path="register" element={<CustomerAccount redirectAfterLogin />} />
            </Route>

            {/* Merchant Seller Hub Routes */}
            <Route path="/merchant" element={<MerchantLayout />}>
              <Route index element={<MerchantDashboard />} />
              <Route path="listings" element={<MerchantListings />} />
              <Route path="products" element={<MerchantListings />} />
              <Route path="inventory" element={<MerchantInventory />} />
              <Route path="orders" element={<MerchantOrders />} />
              <Route path="fulfillment" element={<MerchantFulfillment />} />
              <Route path="returns" element={<MerchantReturns />} />
              <Route path="finance" element={<MerchantFinance />} />
              <Route path="analytics" element={<AnalyticsDashboard />} />
              <Route path="onboarding" element={<MerchantOnboarding />} />
              <Route path="settings" element={<MerchantSettings />} />
            </Route>

            {/* Platform Admin Routes */}
            <Route path="/admin" element={<AdminLayout />}>
              <Route index element={<AdminDashboard />} />
              <Route path="users" element={<AdminUsers />} />
              <Route path="merchants" element={<AdminMerchants />} />
              <Route path="catalog" element={<AdminCatalog />} />
              <Route path="listings" element={<AdminListings />} />
              <Route path="inventory" element={<AdminInventory />} />
              <Route path="orders" element={<AdminOrders />} />
              <Route path="payments" element={<AdminPayments />} />
              <Route path="settlements" element={<AdminSettlements />} />
              <Route path="settlement" element={<AdminSettlements />} />
              <Route path="events" element={<AdminEvents />} />
              <Route path="security" element={<AdminSecurity />} />
              <Route path="analytics" element={<AnalyticsDashboard />} />
            </Route>
          </Routes>
        </BrowserRouter>
      </CartProvider>
    </AuthProvider>
  );
};
