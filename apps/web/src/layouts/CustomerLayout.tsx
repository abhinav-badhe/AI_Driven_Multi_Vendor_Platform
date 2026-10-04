import { useState, type FormEvent } from 'react';
import { Outlet, Link, useNavigate } from 'react-router-dom';
import { useCart } from '../features/cart/CartContext';
import { useAuth } from '../features/auth/AuthContext';
import { AiAssistant } from '../features/ai/AiAssistant';

export const CustomerLayout = () => {
  const { itemCount } = useCart();
  const { isAuthenticated, user, logout, login } = useAuth();
  const [navSearch, setNavSearch] = useState('');
  const navigate = useNavigate();

  const handleNavSearch = (e: FormEvent) => {
    e.preventDefault();
    if (navSearch.trim()) {
      navigate(`/search?q=${encodeURIComponent(navSearch.trim())}`);
    } else {
      navigate('/search');
    }
  };

  return (
    <div className="app-layout">
      <header className="app-header" style={{ padding: '0.75rem 2rem', borderBottom: '1px solid var(--border)', background: 'var(--bg-card)' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%', gap: '1.5rem' }}>
          {/* Logo & Hyperlocal Delivery Address */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '1.5rem', flexShrink: 0 }}>
            <Link to="/" className="brand-logo" style={{ fontSize: '1.4rem', fontWeight: 800, textDecoration: 'none', color: 'var(--primary)' }}>
              <span style={{ color: 'var(--brand)' }}>AI</span> Commerce
            </Link>

            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                borderLeft: '1px solid var(--border)',
                paddingLeft: '1rem',
                cursor: 'pointer',
              }}
              title="Hyperlocal delivery location"
            >
              <div style={{ fontSize: '0.75rem', fontWeight: 700, color: 'var(--accent-green)', display: 'flex', alignItems: 'center', gap: '3px' }}>
                <span>⚡ 10-15 MINS</span>
              </div>
              <div style={{ fontSize: '0.8rem', color: 'var(--text-main)', fontWeight: 500 }}>
                Mumbai 400050 &or;
              </div>
            </div>
          </div>

          {/* Quick Universal Search Bar (Blinkit style) */}
          <form onSubmit={handleNavSearch} style={{ flex: 1, maxWidth: '520px', display: 'flex' }}>
            <input
              type="search"
              className="input-field"
              placeholder="Search 'Sony headphones', 'iPhone', 'electronics'..."
              value={navSearch}
              onChange={(e) => setNavSearch(e.target.value)}
              style={{ width: '100%', padding: '0.5rem 1rem', fontSize: '0.9rem', borderRadius: '8px' }}
            />
          </form>

          {/* Navigation Links & User / Cart */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', flexShrink: 0 }}>
            <nav style={{ display: 'flex', gap: '0.75rem', alignItems: 'center' }}>
              <Link to="/search" className="btn btn-secondary">
                Search
              </Link>
              {isAuthenticated && (
                <>
                  <Link to="/orders" style={{ textDecoration: 'none', color: 'var(--primary)', fontSize: '0.95rem' }}>
                    My Orders
                  </Link>
                  <Link to="/returns" style={{ textDecoration: 'none', color: 'var(--primary)', fontSize: '0.95rem' }}>
                    Returns
                  </Link>
                </>
              )}
              {user?.role === 'MERCHANT' && (
                <>
                  <Link to="/merchant" style={{ textDecoration: 'none', color: 'var(--accent-amber)', fontSize: '0.95rem', fontWeight: 600 }}>
                    🏪 Merchant Hub
                  </Link>
                  <Link to="/analytics" style={{ textDecoration: 'none', color: 'var(--primary)', fontSize: '0.95rem' }}>
                    📊 Analytics
                  </Link>
                </>
              )}
              {user?.role === 'ADMINISTRATOR' && (
                <>
                  <Link to="/merchant" style={{ textDecoration: 'none', color: 'var(--accent-amber)', fontSize: '0.95rem' }}>
                    Merchant Hub
                  </Link>
                  <Link to="/admin" style={{ textDecoration: 'none', color: 'var(--accent-blue)', fontSize: '0.95rem', fontWeight: 600 }}>
                    🛡️ Admin Portal
                  </Link>
                  <Link to="/analytics" style={{ textDecoration: 'none', color: 'var(--primary)', fontSize: '0.95rem' }}>
                    📊 Analytics
                  </Link>
                </>
              )}
            </nav>

            <Link
              to="/cart"
              className={itemCount > 0 ? 'btn btn-primary' : 'btn btn-secondary'}
              style={{
                position: 'relative',
                display: 'inline-flex',
                alignItems: 'center',
                gap: '0.4rem',
                padding: '0.45rem 0.9rem',
                fontWeight: 600,
              }}
            >
              <span>🛒 Cart</span>
              {itemCount > 0 && (
                <span
                  style={{
                    background: '#fff',
                    color: 'var(--brand)',
                    borderRadius: '999px',
                    fontSize: '0.75rem',
                    fontWeight: 800,
                    padding: '0.05rem 0.45rem',
                  }}
                >
                  {itemCount}
                </span>
              )}
            </Link>

            {isAuthenticated ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                <Link to="/account" style={{ textDecoration: 'none', color: 'var(--primary)', fontSize: '0.85rem' }}>
                  <strong>{user?.email}</strong>{' '}
                  <span style={{ fontSize: '0.75rem', background: 'rgba(255,255,255,0.1)', padding: '0.15rem 0.4rem', borderRadius: '4px' }}>
                    {user?.role}
                  </span>
                </Link>
                <button
                  type="button"
                  className="btn btn-secondary"
                  style={{ padding: '0.35rem 0.75rem', fontSize: '0.85rem' }}
                  onClick={() => logout()}
                >
                  Logout
                </button>
              </div>
            ) : (
              <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                <Link to="/account" className="btn btn-primary" style={{ padding: '0.4rem 0.9rem', fontSize: '0.85rem' }}>
                  Login
                </Link>
                {/* Fast One-Click Switcher for Demo testing */}
                <button
                  type="button"
                  className="btn btn-secondary"
                  style={{ padding: '0.4rem 0.6rem', fontSize: '0.75rem' }}
                  title="Switch to Demo Customer"
                  onClick={() => login({ email: 'customer@example.com', password: 'password123' })}
                >
                  Demo User
                </button>
                <button
                  type="button"
                  className="btn btn-secondary"
                  style={{ padding: '0.4rem 0.6rem', fontSize: '0.75rem' }}
                  title="Switch to Demo Merchant"
                  onClick={() => login({ email: 'merchant@example.com', password: 'password123' })}
                >
                  Demo Seller
                </button>
              </div>
            )}
          </div>
        </div>
      </header>

      <main className="main-content">
        <Outlet />
      </main>

      <AiAssistant />
    </div>
  );
};
