import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { merchantApi, type SellerOrderDto } from './api/merchant';

export const MerchantOrders = () => {
  const [orders, setOrders] = useState<SellerOrderDto[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [updatingId, setUpdatingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const fetchOrders = async () => {
    setIsLoading(true);
    setError(null);
    try {
      const data = await merchantApi.getSellerOrders();
      setOrders(data);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to fetch seller orders');
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchOrders();
  }, []);

  const handleUpdateStatus = async (orderId: string, newStatus: string) => {
    setUpdatingId(orderId);
    try {
      await merchantApi.updateOrderStatus(orderId, newStatus);
      await fetchOrders();
    } catch (err: unknown) {
      alert(err instanceof Error ? err.message : 'Failed to update order status');
    } finally {
      setUpdatingId(null);
    }
  };

  return (
    <div className="container" style={{ padding: '2rem 1rem 4rem' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '2rem' }}>
        <div>
          <h1 className="font-display" style={{ fontSize: '2rem', marginBottom: '0.25rem' }}>
            Merchant Orders & Fulfillment
          </h1>
          <p className="text-muted">
            Manage your orders, update delivery milestones, and trigger customer tracking updates.
          </p>
        </div>
        <Link to="/merchant" className="btn btn-secondary">
          &larr; Back to Dashboard
        </Link>
      </div>

      {error && (
        <div className="card" style={{ borderColor: 'var(--accent-red)', color: 'var(--accent-red)', marginBottom: '1.5rem' }}>
          {error}
        </div>
      )}

      {isLoading ? (
        <div style={{ textAlign: 'center', padding: '3rem' }}>
          <p className="text-muted">Loading orders...</p>
        </div>
      ) : orders.length === 0 ? (
        <div className="card" style={{ padding: '3rem', textAlign: 'center' }}>
          <p className="text-muted">No orders currently assigned to your seller account.</p>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
          {orders.map((order) => (
            <div key={order.id} className="card" style={{ padding: '1.5rem' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: '1rem', borderBottom: '1px solid var(--border)', paddingBottom: '1rem', marginBottom: '1rem' }}>
                <div>
                  <h3 style={{ fontSize: '1.1rem', fontWeight: 700 }}>
                    Seller Order #{order.id.slice(0, 8)}
                  </h3>
                  <div style={{ fontSize: '0.85rem', color: 'var(--primary-muted)' }}>
                    Customer Order: {order.customerOrderId} &bull; {new Date(order.createdAt).toLocaleString()}
                  </div>
                </div>

                <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
                  <div style={{ textAlign: 'right' }}>
                    <div style={{ fontSize: '1.1rem', fontWeight: 700, color: 'var(--brand)' }}>
                      ₹{(order.totalAmount / 100).toLocaleString('en-IN')}
                    </div>
                    <span style={{ fontSize: '0.8rem', color: 'var(--accent-green)', fontWeight: 600 }}>
                      Status: {order.status}
                    </span>
                  </div>

                  {/* Status Actions */}
                  <div style={{ display: 'flex', gap: '0.5rem' }}>
                    {order.status === 'CONFIRMED' && (
                      <button
                        type="button"
                        className="btn btn-secondary"
                        disabled={updatingId === order.id}
                        onClick={() => handleUpdateStatus(order.id, 'PROCESSING')}
                      >
                        Start Processing
                      </button>
                    )}
                    {order.status === 'PROCESSING' && (
                      <button
                        type="button"
                        className="btn btn-primary"
                        disabled={updatingId === order.id}
                        onClick={() => handleUpdateStatus(order.id, 'SHIPPED')}
                      >
                        Mark Shipped
                      </button>
                    )}
                    {order.status === 'SHIPPED' && (
                      <button
                        type="button"
                        className="btn btn-primary"
                        disabled={updatingId === order.id}
                        onClick={() => handleUpdateStatus(order.id, 'DELIVERED')}
                      >
                        Mark Delivered
                      </button>
                    )}
                  </div>
                </div>
              </div>

              {/* Order Items */}
              {order.items && order.items.length > 0 && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                  {order.items.map((it) => (
                    <div key={it.id} style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.9rem', color: 'var(--primary-muted)' }}>
                      <span>{it.productName || it.skuCode} × {it.quantity}</span>
                      <span>₹{(it.lineTotalAmount / 100).toLocaleString('en-IN')}</span>
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
};
