import { useState, useEffect } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { checkoutApi, type CheckoutSessionDto, type OrderConfirmationDto } from './api/checkout';
import { useCart } from '../cart/CartContext';

export const CheckoutPage = () => {
  const navigate = useNavigate();
  const { refreshCart } = useCart();
  const [session, setSession] = useState<CheckoutSessionDto | null>(null);
  const [isInitializing, setIsInitializing] = useState(true);
  const [isReserving, setIsReserving] = useState(false);
  const [isPaying, setIsPaying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [completedOrder, setCompletedOrder] = useState<OrderConfirmationDto | null>(null);

  // Form State
  const [fullName, setFullName] = useState('John Doe');
  const [address, setAddress] = useState('123 MG Road, Indiranagar');
  const [city, setCity] = useState('Bengaluru');
  const [postalCode, setPostalCode] = useState('560038');
  const [paymentMethod, setPaymentMethod] = useState('pm_card_visa');

  const formatPrice = (minorUnits: number, currency = 'INR') => {
    return new Intl.NumberFormat('en-IN', {
      style: 'currency',
      currency: currency || 'INR',
      maximumFractionDigits: 2,
    }).format(minorUnits / 100);
  };

  useEffect(() => {
    const initCheckout = async () => {
      setIsInitializing(true);
      setError(null);
      try {
        const sess = await checkoutApi.createSession();
        setSession(sess);
        // Automatically reserve inventory to guarantee stock availability
        setIsReserving(true);
        const reserved = await checkoutApi.reserveInventory(sess.id);
        setSession(reserved);
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : 'Failed to initialize checkout session');
      } finally {
        setIsInitializing(false);
        setIsReserving(false);
      }
    };
    initCheckout();
  }, []);

  const handlePayAndOrder = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!session) return;
    setIsPaying(true);
    setError(null);
    try {
      let activeSession = session;
      if (activeSession.status === 'OPEN') {
        activeSession = await checkoutApi.reserveInventory(activeSession.id);
        setSession(activeSession);
      }

      // 1. Create Payment Intent
      const intent = await checkoutApi.createPaymentIntent(activeSession.id);

      // 2. Submit Payment Attempt
      await checkoutApi.submitPaymentAttempt(intent.id, paymentMethod);

      // 3. Finalize Customer Order
      const order = await checkoutApi.finalizeOrder(session.id, intent.id);
      setCompletedOrder(order);
      await refreshCart();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Payment or order processing failed');
    } finally {
      setIsPaying(false);
    }
  };

  if (isInitializing) {
    return (
      <div className="container" style={{ padding: '4rem 1rem', textAlign: 'center' }}>
        <h2 style={{ fontSize: '1.5rem', marginBottom: '0.5rem' }}>Preparing Checkout Session...</h2>
        <p className="text-muted">Allocating inventory locks and calculating taxes...</p>
      </div>
    );
  }

  if (completedOrder) {
    return (
      <div className="container" style={{ padding: '3rem 1rem', maxWidth: '640px', margin: '0 auto' }}>
        <div className="card" style={{ padding: '2.5rem', textAlign: 'center' }}>
          <div style={{ fontSize: '3rem', color: 'var(--accent-green)', marginBottom: '1rem' }}>✓</div>
          <h1 style={{ fontSize: '1.75rem', fontWeight: 700, marginBottom: '0.5rem' }}>
            Order Confirmed!
          </h1>
          <p className="text-muted" style={{ marginBottom: '1.5rem' }}>
            Thank you for your purchase. We have received your payment and notified the seller.
          </p>

          <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: '8px', padding: '1rem', marginBottom: '1.5rem', textAlign: 'left' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.5rem' }}>
              <span className="text-muted">Order Number:</span>
              <strong>{completedOrder.orderNumber}</strong>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.5rem' }}>
              <span className="text-muted">Total Amount:</span>
              <strong style={{ color: 'var(--brand)' }}>{formatPrice(completedOrder.totalAmount, completedOrder.currency)}</strong>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span className="text-muted">Status:</span>
              <span style={{ color: 'var(--accent-green)', fontWeight: 600 }}>{completedOrder.status}</span>
            </div>
          </div>

          <div style={{ display: 'flex', gap: '1rem', justifyContent: 'center' }}>
            <Link to="/orders" className="btn btn-primary">
              View My Orders
            </Link>
            <Link to="/search" className="btn btn-secondary">
              Continue Shopping
            </Link>
          </div>
        </div>
      </div>
    );
  }

  if (error && !session) {
    return (
      <div className="container" style={{ padding: '3rem 1rem', maxWidth: '540px', margin: '0 auto', textAlign: 'center' }}>
        <div className="card" style={{ padding: '2rem', borderColor: 'var(--accent-red)' }}>
          <h2 style={{ fontSize: '1.25rem', color: 'var(--accent-red)', marginBottom: '1rem' }}>Unable to Checkout</h2>
          <p className="text-muted" style={{ marginBottom: '1.5rem' }}>{error}</p>
          <button type="button" className="btn btn-secondary" onClick={() => navigate('/cart')}>
            Return to Cart
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="container" style={{ padding: '2rem 1rem 4rem', maxWidth: '960px', margin: '0 auto' }}>
      <h1 className="font-display" style={{ fontSize: '2rem', marginBottom: '1.5rem' }}>
        Express Checkout
      </h1>

      {/* Reservation Status Banner */}
      <div
        style={{
          background: 'rgba(34, 197, 94, 0.1)',
          border: '1px solid rgba(34, 197, 94, 0.3)',
          borderRadius: '8px',
          padding: '0.85rem 1.25rem',
          marginBottom: '1.5rem',
          display: 'flex',
          alignItems: 'center',
          gap: '0.75rem',
          fontSize: '0.9rem',
          color: 'var(--accent-green)',
        }}
      >
        <span>🛡️</span>
        <span>
          <strong>Inventory Reserved:</strong> Your items are locked and reserved for this session.
        </span>
      </div>

      {error && (
        <div className="card" style={{ borderColor: 'var(--accent-red)', color: 'var(--accent-red)', marginBottom: '1.5rem' }}>
          {error}
        </div>
      )}

      <form onSubmit={handlePayAndOrder} style={{ display: 'grid', gridTemplateColumns: '1fr 340px', gap: '2rem', alignItems: 'start' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
          {/* Shipping Address */}
          <div className="card" style={{ padding: '1.5rem' }}>
            <h2 style={{ fontSize: '1.25rem', fontWeight: 600, marginBottom: '1rem' }}>
              1. Delivery Address
            </h2>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: '1rem' }}>
              <div>
                <label style={{ display: 'block', fontSize: '0.85rem', marginBottom: '0.25rem', color: 'var(--primary-muted)' }}>
                  Full Name
                </label>
                <input
                  type="text"
                  required
                  className="input-field"
                  style={{ width: '100%' }}
                  value={fullName}
                  onChange={(e) => setFullName(e.target.value)}
                />
              </div>
              <div>
                <label style={{ display: 'block', fontSize: '0.85rem', marginBottom: '0.25rem', color: 'var(--primary-muted)' }}>
                  Street Address
                </label>
                <input
                  type="text"
                  required
                  className="input-field"
                  style={{ width: '100%' }}
                  value={address}
                  onChange={(e) => setAddress(e.target.value)}
                />
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
                <div>
                  <label style={{ display: 'block', fontSize: '0.85rem', marginBottom: '0.25rem', color: 'var(--primary-muted)' }}>
                    City
                  </label>
                  <input
                    type="text"
                    required
                    className="input-field"
                    style={{ width: '100%' }}
                    value={city}
                    onChange={(e) => setCity(e.target.value)}
                  />
                </div>
                <div>
                  <label style={{ display: 'block', fontSize: '0.85rem', marginBottom: '0.25rem', color: 'var(--primary-muted)' }}>
                    PIN Code
                  </label>
                  <input
                    type="text"
                    required
                    className="input-field"
                    style={{ width: '100%' }}
                    value={postalCode}
                    onChange={(e) => setPostalCode(e.target.value)}
                  />
                </div>
              </div>
            </div>
          </div>

          {/* Payment Method */}
          <div className="card" style={{ padding: '1.5rem' }}>
            <h2 style={{ fontSize: '1.25rem', fontWeight: 600, marginBottom: '1rem' }}>
              2. Payment Method
            </h2>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', padding: '0.75rem', border: '1px solid var(--border)', borderRadius: '6px', cursor: 'pointer' }}>
                <input
                  type="radio"
                  name="paymentMethod"
                  value="pm_card_visa"
                  checked={paymentMethod === 'pm_card_visa'}
                  onChange={(e) => setPaymentMethod(e.target.value)}
                />
                <span>Credit / Debit Card (Visa / Mastercard)</span>
              </label>

              <label style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', padding: '0.75rem', border: '1px solid var(--border)', borderRadius: '6px', cursor: 'pointer' }}>
                <input
                  type="radio"
                  name="paymentMethod"
                  value="pm_upi"
                  checked={paymentMethod === 'pm_upi'}
                  onChange={(e) => setPaymentMethod(e.target.value)}
                />
                <span>UPI (Google Pay / PhonePe / Paytm)</span>
              </label>
            </div>
          </div>
        </div>

        {/* Order Summary Sidebar */}
        <div className="card" style={{ padding: '1.5rem' }}>
          <h2 style={{ fontSize: '1.25rem', fontWeight: 600, marginBottom: '1rem' }}>
            Order Summary
          </h2>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', marginBottom: '1rem' }}>
            {session?.items.map((it) => (
              <div key={it.id} style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.85rem' }}>
                <span className="text-muted">Offer #{it.listingId.slice(0, 8)} × {it.quantity}</span>
                <span>{formatPrice(it.lineTotalAmount, it.currency)}</span>
              </div>
            ))}
          </div>

          <div style={{ borderTop: '1px solid var(--border)', paddingTop: '0.75rem', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', color: 'var(--primary-muted)', fontSize: '0.9rem' }}>
              <span>Subtotal</span>
              <span>{formatPrice(session?.subtotalAmount ?? 0, session?.currency)}</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', color: 'var(--primary-muted)', fontSize: '0.9rem' }}>
              <span>Delivery</span>
              <span style={{ color: 'var(--accent-green)' }}>Free</span>
            </div>
            <div style={{ borderTop: '1px solid var(--border)', paddingTop: '0.75rem', display: 'flex', justifyContent: 'space-between', fontWeight: 700, fontSize: '1.1rem' }}>
              <span>Total</span>
              <span style={{ color: 'var(--brand)' }}>{formatPrice(session?.totalAmount ?? 0, session?.currency)}</span>
            </div>
          </div>

          <button
            type="submit"
            className="btn btn-primary"
            style={{ width: '100%', marginTop: '1.25rem', padding: '0.85rem' }}
            disabled={isPaying || isReserving}
          >
            {isPaying ? 'Authorizing Payment...' : `Pay ${formatPrice(session?.totalAmount ?? 0, session?.currency)}`}
          </button>
        </div>
      </form>
    </div>
  );
};
