import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useCart } from './CartContext';
import { useAuth } from '../auth/AuthContext';

export const CartPage = () => {
  const { cart, updateQuantity, removeItem, isLoading } = useCart();
  const { isAuthenticated, login } = useAuth();
  const navigate = useNavigate();
  const [updatingId, setUpdatingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const formatPrice = (minorUnits: number, currency = 'INR') => {
    return new Intl.NumberFormat('en-IN', {
      style: 'currency',
      currency: currency || 'INR',
      maximumFractionDigits: 2,
    }).format(minorUnits / 100);
  };

  const handleUpdate = async (itemId: string, newQty: number) => {
    if (newQty <= 0) {
      handleRemove(itemId);
      return;
    }
    setUpdatingId(itemId);
    setError(null);
    try {
      await updateQuantity(itemId, newQty);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to update quantity');
    } finally {
      setUpdatingId(null);
    }
  };

  const handleRemove = async (itemId: string) => {
    setUpdatingId(itemId);
    setError(null);
    try {
      await removeItem(itemId);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to remove item');
    } finally {
      setUpdatingId(null);
    }
  };

  if (!isAuthenticated) {
    return (
      <div className="container" style={{ padding: '3rem 1rem', maxWidth: '600px', margin: '0 auto', textAlign: 'center' }}>
        <div className="card" style={{ padding: '2.5rem' }}>
          <h2 style={{ fontSize: '1.5rem', marginBottom: '0.75rem' }}>Your Shopping Cart</h2>
          <p className="text-muted" style={{ marginBottom: '1.5rem' }}>
            Please log in to view your saved cart items and complete checkout.
          </p>
          <div style={{ display: 'flex', gap: '1rem', justifyContent: 'center' }}>
            <Link to="/account" className="btn btn-primary">
              Log In to Your Account
            </Link>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={async () => {
                await login({ email: 'customer@example.com', password: 'password123' });
              }}
            >
              Demo Customer Login
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (isLoading && !cart) {
    return (
      <div className="container" style={{ padding: '3rem 1rem', textAlign: 'center' }}>
        <p className="text-muted">Loading your cart items...</p>
      </div>
    );
  }

  if (!cart || !cart.items || cart.items.length === 0) {
    return (
      <div className="container" style={{ padding: '3rem 1rem', maxWidth: '640px', margin: '0 auto', textAlign: 'center' }}>
        <div className="card" style={{ padding: '3rem 2rem' }}>
          <div style={{ fontSize: '3rem', marginBottom: '1rem' }}>🛒</div>
          <h2 style={{ fontSize: '1.5rem', marginBottom: '0.5rem' }}>Your cart is empty</h2>
          <p className="text-muted" style={{ marginBottom: '1.5rem' }}>
            Looks like you haven&apos;t added any items to your shopping cart yet.
          </p>
          <Link to="/search" className="btn btn-primary">
            Explore Marketplace Catalog
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="container" style={{ padding: '2rem 1rem 4rem' }}>
      <h1 className="font-display" style={{ fontSize: '2rem', marginBottom: '1.5rem' }}>
        Shopping Cart ({cart.items.reduce((s, it) => s + it.quantity, 0)} items)
      </h1>

      {error && (
        <div className="card" style={{ borderColor: 'var(--accent-red)', color: 'var(--accent-red)', marginBottom: '1.5rem' }}>
          {error}
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 340px', gap: '2rem', alignItems: 'start' }}>
        {/* Cart Items List */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          {cart.items.map((item) => (
            <div key={item.id} className="card" style={{ padding: '1.25rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div style={{ flex: 1 }}>
                <h3 style={{ fontSize: '1.1rem', fontWeight: 600, marginBottom: '0.25rem' }}>
                  Product Offer #{item.listingId.slice(0, 10)}
                </h3>
                <div style={{ fontSize: '0.85rem', color: 'var(--primary-muted)', marginBottom: '0.5rem' }}>
                  Merchant ID: {item.merchantTenantId} | Unit Price: {formatPrice(item.unitPriceAmount, item.currency)}
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                  <div style={{ display: 'inline-flex', alignItems: 'center', border: '1px solid var(--border)', borderRadius: '6px' }}>
                    <button
                      type="button"
                      style={{ padding: '0.25rem 0.6rem', background: 'transparent', border: 'none', cursor: 'pointer' }}
                      disabled={updatingId === item.id}
                      onClick={() => handleUpdate(item.id, item.quantity - 1)}
                    >
                      −
                    </button>
                    <span style={{ padding: '0 0.5rem', fontWeight: 600, fontSize: '0.9rem' }}>
                      {item.quantity}
                    </span>
                    <button
                      type="button"
                      style={{ padding: '0.25rem 0.6rem', background: 'transparent', border: 'none', cursor: 'pointer' }}
                      disabled={updatingId === item.id}
                      onClick={() => handleUpdate(item.id, item.quantity + 1)}
                    >
                      +
                    </button>
                  </div>

                  <button
                    type="button"
                    style={{ background: 'none', border: 'none', color: 'var(--accent-red)', fontSize: '0.85rem', cursor: 'pointer' }}
                    disabled={updatingId === item.id}
                    onClick={() => handleRemove(item.id)}
                  >
                    Remove
                  </button>
                </div>
              </div>

              <div style={{ textAlign: 'right' }}>
                <div style={{ fontSize: '1.25rem', fontWeight: 700, color: 'var(--brand)' }}>
                  {formatPrice(item.lineTotalAmount, item.currency)}
                </div>
              </div>
            </div>
          ))}
        </div>

        {/* Order Summary & Checkout Card */}
        <div className="card" style={{ padding: '1.5rem' }}>
          <h2 style={{ fontSize: '1.25rem', fontWeight: 600, marginBottom: '1rem' }}>Order Summary</h2>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.75rem', color: 'var(--primary-muted)' }}>
            <span>Subtotal</span>
            <span>{formatPrice(cart.subtotalAmount, cart.currency || 'INR')}</span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.75rem', color: 'var(--primary-muted)' }}>
            <span>Standard Shipping</span>
            <span style={{ color: 'var(--accent-green)' }}>Free</span>
          </div>
          <div style={{ borderTop: '1px solid var(--border)', paddingTop: '0.75rem', margin: '0.75rem 0', display: 'flex', justifyContent: 'space-between', fontWeight: 700, fontSize: '1.1rem' }}>
            <span>Total</span>
            <span style={{ color: 'var(--brand)' }}>{formatPrice(cart.subtotalAmount, cart.currency || 'INR')}</span>
          </div>

          <button
            type="button"
            className="btn btn-primary"
            style={{ width: '100%', marginTop: '1rem', padding: '0.85rem' }}
            onClick={() => navigate('/checkout')}
          >
            Proceed to Checkout
          </button>

          <p style={{ fontSize: '0.75rem', color: 'var(--primary-muted)', textAlign: 'center', marginTop: '1rem' }}>
            🔒 Guaranteed inventory reservation holds for 15 minutes during checkout.
          </p>
        </div>
      </div>
    </div>
  );
};
