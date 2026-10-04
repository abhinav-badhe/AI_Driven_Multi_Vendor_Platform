import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { ordersApi, type CustomerOrderDto, type OrderItemDto } from './api/orders';
import { returnsApi, type ReturnDto } from './api/returns';
import { useAuth } from '../auth/AuthContext';

export const CustomerOrders = () => {
  const { isAuthenticated, login } = useAuth();
  const [orders, setOrders] = useState<CustomerOrderDto[]>([]);
  const [returns, setReturns] = useState<ReturnDto[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Return modal state
  const [activeReturnItem, setActiveReturnItem] = useState<{
    customerOrderId: string;
    sellerOrderId: string;
    item: OrderItemDto;
  } | null>(null);
  const [returnReason, setReturnReason] = useState('Defective or not working properly');
  const [returnQty, setReturnQty] = useState(1);
  const [isSubmittingReturn, setIsSubmittingReturn] = useState(false);
  const [returnSuccessMsg, setReturnSuccessMsg] = useState<string | null>(null);

  const formatPrice = (minorUnits: number, currency = 'INR') => {
    return new Intl.NumberFormat('en-IN', {
      style: 'currency',
      currency: currency || 'INR',
      maximumFractionDigits: 2,
    }).format(minorUnits / 100);
  };

  const loadData = async () => {
    setIsLoading(true);
    setError(null);
    try {
      const [ordersData, returnsData] = await Promise.all([
        ordersApi.listOrders(),
        returnsApi.listReturns().catch(() => [] as ReturnDto[]),
      ]);
      setOrders(ordersData);
      setReturns(returnsData);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to load orders');
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    if (!isAuthenticated) return;
    loadData();
  }, [isAuthenticated]);

  const handleReturnSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeReturnItem) return;

    setIsSubmittingReturn(true);
    setError(null);

    try {
      await returnsApi.createReturn({
        customerOrderId: activeReturnItem.customerOrderId,
        sellerOrderId: activeReturnItem.sellerOrderId,
        reason: returnReason,
        items: [
          {
            orderItemId: activeReturnItem.item.id,
            skuId: activeReturnItem.item.skuId,
            quantity: returnQty,
            reason: returnReason,
          },
        ],
      });

      setReturnSuccessMsg(`Return requested successfully for ${activeReturnItem.item.productName || 'item'}!`);
      setActiveReturnItem(null);
      await loadData();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to submit return request.');
    } finally {
      setIsSubmittingReturn(false);
    }
  };

  if (!isAuthenticated) {
    return (
      <div className="container" style={{ padding: '3rem 1rem', maxWidth: '600px', margin: '0 auto', textAlign: 'center' }}>
        <div className="card" style={{ padding: '2.5rem' }}>
          <h2 style={{ fontSize: '1.5rem', marginBottom: '0.75rem' }}>My Orders</h2>
          <p className="text-muted" style={{ marginBottom: '1.5rem' }}>
            Please log in to review your order history, delivery tracking, and seller fulfillments.
          </p>
          <div style={{ display: 'flex', gap: '1rem', justifyContent: 'center' }}>
            <Link to="/account" className="btn btn-primary">
              Log In
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

  if (isLoading) {
    return (
      <div className="container" style={{ padding: '3rem 1rem', textAlign: 'center' }}>
        <p className="text-muted">Loading your orders...</p>
      </div>
    );
  }

  return (
    <div className="container" style={{ padding: '2rem 1rem 4rem' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem' }}>
        <h1 className="font-display" style={{ fontSize: '2rem' }}>
          My Orders ({orders.length})
        </h1>
        <Link to="/search" className="btn btn-secondary">
          Continue Shopping
        </Link>
      </div>

      {returnSuccessMsg && (
        <div className="card" style={{ borderColor: 'var(--accent-green)', background: 'rgba(34, 197, 94, 0.1)', color: 'var(--accent-green)', padding: '1rem', marginBottom: '1.5rem' }}>
          ✓ {returnSuccessMsg}
        </div>
      )}

      {error && (
        <div className="card" style={{ borderColor: 'var(--accent-red)', color: 'var(--accent-red)', marginBottom: '1.5rem' }}>
          {error}
        </div>
      )}

      {orders.length === 0 ? (
        <div className="card" style={{ padding: '3rem 2rem', textAlign: 'center' }}>
          <div style={{ fontSize: '3rem', marginBottom: '1rem' }}>📦</div>
          <h2 style={{ fontSize: '1.5rem', marginBottom: '0.5rem' }}>No orders placed yet</h2>
          <p className="text-muted" style={{ marginBottom: '1.5rem' }}>
            When you complete a purchase, your order history and seller tracking will appear here.
          </p>
          <Link to="/search" className="btn btn-primary">
            Explore Marketplace Catalog
          </Link>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
          {orders.map((order) => {
            const orderReturns = returns.filter((r) => r.customerOrderId === order.id);

            return (
              <div key={order.id} className="card" style={{ padding: '1.5rem' }}>
                {/* Order Header */}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid var(--border)', paddingBottom: '1rem', marginBottom: '1rem', flexWrap: 'wrap', gap: '1rem' }}>
                  <div>
                    <div style={{ fontSize: '1.1rem', fontWeight: 700 }}>
                      Order #{order.orderNumber}
                    </div>
                    <div style={{ fontSize: '0.85rem', color: 'var(--primary-muted)' }}>
                      Placed on {new Date(order.createdAt).toLocaleDateString(undefined, { dateStyle: 'long' })}
                    </div>
                  </div>

                  <div style={{ display: 'flex', alignItems: 'center', gap: '1.5rem' }}>
                    <div>
                      <span className="text-muted" style={{ fontSize: '0.85rem', display: 'block' }}>Total Amount</span>
                      <strong style={{ fontSize: '1.1rem', color: 'var(--brand)' }}>
                        {formatPrice(order.totalAmount, order.currency)}
                      </strong>
                    </div>

                    <span
                      style={{
                        background: 'rgba(34, 197, 94, 0.15)',
                        color: 'var(--accent-green)',
                        padding: '0.35rem 0.75rem',
                        borderRadius: '999px',
                        fontSize: '0.85rem',
                        fontWeight: 600,
                      }}
                    >
                      {order.status}
                    </span>
                  </div>
                </div>

                {/* Returns section if active for this order */}
                {orderReturns.length > 0 && (
                  <div style={{ marginBottom: '1rem', padding: '0.75rem', background: 'rgba(234, 179, 8, 0.1)', border: '1px solid rgba(234, 179, 8, 0.3)', borderRadius: '6px' }}>
                    <div style={{ fontWeight: 600, fontSize: '0.85rem', color: 'var(--text-main)', marginBottom: '0.25rem' }}>
                      Return Requests on this Order:
                    </div>
                    {orderReturns.map((ret) => (
                      <div key={ret.id} style={{ fontSize: '0.8rem', display: 'flex', justifyContent: 'space-between' }}>
                        <span>Return #{ret.id.slice(0, 8)}: {ret.reason}</span>
                        <strong style={{ color: 'var(--brand)' }}>Status: {ret.status}</strong>
                      </div>
                    ))}
                  </div>
                )}

                {/* Multi-Seller Orders Breakdown */}
                {order.sellerOrders && order.sellerOrders.length > 0 && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                    {order.sellerOrders.map((sellerOrder) => (
                      <div key={sellerOrder.id} style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: '6px', padding: '1rem' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.5rem', fontSize: '0.9rem' }}>
                          <span>
                            <strong>Seller Order:</strong> {sellerOrder.sellerTenantId}
                          </span>
                          <span style={{ color: 'var(--brand)', fontWeight: 600 }}>
                            Fulfillment: {sellerOrder.status}
                          </span>
                        </div>

                        {sellerOrder.items && sellerOrder.items.length > 0 && (
                          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', marginTop: '0.5rem' }}>
                            {sellerOrder.items.map((item) => (
                              <div key={item.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '0.9rem', borderTop: '1px dashed var(--border)', paddingTop: '0.5rem' }}>
                                <div>
                                  <div style={{ fontWeight: 600 }}>{item.productName || item.skuCode}</div>
                                  <div style={{ fontSize: '0.8rem', color: 'var(--primary-muted)' }}>
                                    Qty: {item.quantity} • {formatPrice(item.unitPriceAmount, item.currency)} each
                                  </div>
                                </div>
                                <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
                                  <span style={{ fontWeight: 600 }}>
                                    {formatPrice(item.lineTotalAmount, item.currency)}
                                  </span>

                                  {/* Return Action Button */}
                                  <button
                                    type="button"
                                    className="btn btn-secondary"
                                    style={{ padding: '0.3rem 0.6rem', fontSize: '0.75rem' }}
                                    onClick={() => {
                                      setActiveReturnItem({
                                        customerOrderId: order.id,
                                        sellerOrderId: sellerOrder.id,
                                        item,
                                      });
                                      setReturnQty(item.quantity);
                                      setReturnReason('Defective or not working properly');
                                    }}
                                  >
                                    Return Item
                                  </button>
                                </div>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Return Request Modal Dialog */}
      {activeReturnItem && (
        <div
          role="dialog"
          aria-modal="true"
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.6)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 10000,
            padding: '1rem',
          }}
        >
          <div className="card" style={{ maxWidth: '500px', width: '100%', padding: '2rem' }}>
            <h2 style={{ fontSize: '1.25rem', marginBottom: '0.5rem' }}>
              Request Return
            </h2>
            <p className="text-muted" style={{ fontSize: '0.85rem', marginBottom: '1.25rem' }}>
              Item: <strong>{activeReturnItem.item.productName || activeReturnItem.item.skuCode}</strong>
            </p>

            <form onSubmit={handleReturnSubmit}>
              <div style={{ marginBottom: '1rem' }}>
                <label style={{ display: 'block', fontSize: '0.85rem', marginBottom: '0.5rem', fontWeight: 600 }}>
                  Reason for Return
                </label>
                <select
                  value={returnReason}
                  onChange={(e) => setReturnReason(e.target.value)}
                  style={{
                    width: '100%',
                    padding: '0.6rem',
                    borderRadius: '6px',
                    border: '1px solid var(--border)',
                    background: 'var(--bg-card)',
                    color: 'var(--text-main)',
                  }}
                >
                  <option value="Defective or not working properly">Defective or not working properly</option>
                  <option value="Damaged in transit">Damaged in transit</option>
                  <option value="Incorrect item or variant delivered">Incorrect item or variant delivered</option>
                  <option value="Changed mind / No longer needed">Changed mind / No longer needed</option>
                </select>
              </div>

              <div style={{ marginBottom: '1.5rem' }}>
                <label style={{ display: 'block', fontSize: '0.85rem', marginBottom: '0.5rem', fontWeight: 600 }}>
                  Quantity to Return (Max {activeReturnItem.item.quantity})
                </label>
                <input
                  type="number"
                  min="1"
                  max={activeReturnItem.item.quantity}
                  value={returnQty}
                  onChange={(e) => setReturnQty(Math.max(1, Math.min(activeReturnItem.item.quantity, Number(e.target.value))))}
                  style={{
                    width: '100%',
                    padding: '0.6rem',
                    borderRadius: '6px',
                    border: '1px solid var(--border)',
                    background: 'var(--bg-card)',
                    color: 'var(--text-main)',
                  }}
                />
              </div>

              <div style={{ display: 'flex', gap: '0.75rem', justifyContent: 'flex-end' }}>
                <button
                  type="button"
                  className="btn btn-secondary"
                  disabled={isSubmittingReturn}
                  onClick={() => setActiveReturnItem(null)}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="btn btn-primary"
                  disabled={isSubmittingReturn}
                >
                  {isSubmittingReturn ? 'Submitting...' : 'Confirm Return Request'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
