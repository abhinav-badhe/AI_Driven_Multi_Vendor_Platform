import { useState, useEffect } from 'react';
import { useAuth } from '../auth/AuthContext';
import { apiClient } from '../../api/client';

export interface ShipmentItemDto {
  orderItemId: string;
  quantity: number;
}

export interface ShipmentDto {
  id: string;
  sellerOrderId: string;
  customerOrderId: string;
  carrier?: string;
  trackingNumber?: string;
  trackingUrl?: string;
  status: 'PREPARING' | 'PACKED' | 'SHIPPED' | 'IN_TRANSIT' | 'OUT_FOR_DELIVERY' | 'DELIVERED' | 'FAILED';
  items: ShipmentItemDto[];
  dispatchedAt?: string;
  deliveredAt?: string;
  createdAt: string;
}

export const MerchantFulfillment = () => {
  const { user } = useAuth();
  const [shipments, setShipments] = useState<ShipmentDto[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Form modal/panel for creating shipment
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [newSellerOrderId, setNewSellerOrderId] = useState('');
  const [newCarrier, setNewCarrier] = useState('BlueDart Express');
  const [newTrackingNumber, setNewTrackingNumber] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [actionMessage, setActionMessage] = useState<string | null>(null);

  const loadShipments = async () => {
    setIsLoading(true);
    setError(null);
    try {
      const data = await apiClient<ShipmentDto[]>('/fulfillment/shipments');
      setShipments(data || []);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to load shipments');
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    loadShipments();
  }, [user]);

  const handleUpdateStatus = async (shipmentId: string, nextStatus: ShipmentDto['status']) => {
    try {
      await apiClient<ShipmentDto>(`/fulfillment/shipments/${shipmentId}/status`, {
        method: 'POST',
        body: JSON.stringify({ status: nextStatus }),
      });
      setActionMessage(`Shipment ${shipmentId} transitioned to ${nextStatus}`);
      await loadShipments();
    } catch (err: unknown) {
      alert(`Status update failed: ${err instanceof Error ? err.message : 'Error'}`);
    }
  };

  const handleCreateShipment = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newSellerOrderId.trim() || !newTrackingNumber.trim()) return;
    setIsSubmitting(true);
    try {
      await apiClient<ShipmentDto>('/fulfillment/shipments', {
        method: 'POST',
        body: JSON.stringify({
          sellerOrderId: newSellerOrderId.trim(),
          carrier: newCarrier.trim(),
          trackingNumber: newTrackingNumber.trim(),
          items: [{ orderItemId: 'item-default-1', quantity: 1 }],
        }),
      });
      setShowCreateModal(false);
      setNewSellerOrderId('');
      setNewTrackingNumber('');
      setActionMessage('Shipment successfully registered with carrier!');
      await loadShipments();
    } catch (err: unknown) {
      alert(`Failed to create shipment: ${err instanceof Error ? err.message : 'Error'}`);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '2rem' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '1rem' }}>
        <div>
          <h1 className="font-display" style={{ fontSize: '1.75rem', marginBottom: '0.25rem' }}>
            Fulfillment &amp; Dispatch Hub
          </h1>
          <p className="text-muted" style={{ fontSize: '0.9rem' }}>
            Manage order package milestones, carrier handovers, tracking numbers, and delivery confirmation.
          </p>
        </div>

        <div style={{ display: 'flex', gap: '0.75rem' }}>
          <button type="button" className="btn btn-secondary" onClick={loadShipments}>
            🔄 Refresh
          </button>
          <button type="button" className="btn btn-primary" onClick={() => setShowCreateModal(true)}>
            📦 Register Shipment
          </button>
        </div>
      </div>

      {actionMessage && (
        <div className="card" style={{ background: 'rgba(34, 197, 94, 0.1)', borderColor: 'var(--accent-green)', padding: '0.75rem 1rem' }}>
          {actionMessage}
        </div>
      )}

      {error && (
        <div className="card" style={{ borderColor: 'var(--accent-red)', color: 'var(--accent-red)', padding: '1rem' }}>
          {error}
        </div>
      )}

      {/* Create Shipment Modal */}
      {showCreateModal && (
        <div className="card" style={{ padding: '1.5rem', background: 'var(--bg-card)', border: '2px solid var(--brand)' }}>
          <h3 style={{ fontSize: '1.15rem', fontWeight: 600, marginBottom: '1rem' }}>Register New Carrier Shipment</h3>
          <form onSubmit={handleCreateShipment} style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '1rem' }}>
            <div>
              <label style={{ display: 'block', fontSize: '0.8rem', color: 'var(--primary-muted)', marginBottom: '0.25rem' }}>
                Seller Order ID
              </label>
              <input
                type="text"
                className="input-field"
                placeholder="e.g. ord_..."
                value={newSellerOrderId}
                onChange={(e) => setNewSellerOrderId(e.target.value)}
                required
                style={{ width: '100%' }}
              />
            </div>
            <div>
              <label style={{ display: 'block', fontSize: '0.8rem', color: 'var(--primary-muted)', marginBottom: '0.25rem' }}>
                Logistics Carrier
              </label>
              <select
                className="input-field"
                value={newCarrier}
                onChange={(e) => setNewCarrier(e.target.value)}
                style={{ width: '100%' }}
              >
                <option value="BlueDart Express">BlueDart Express (Hyperlocal)</option>
                <option value="Delhivery Surface">Delhivery Surface</option>
                <option value="FedEx India">FedEx Express</option>
                <option value="Shadowfax Local">Shadowfax Quick-Commerce</option>
              </select>
            </div>
            <div>
              <label style={{ display: 'block', fontSize: '0.8rem', color: 'var(--primary-muted)', marginBottom: '0.25rem' }}>
                Tracking Airway Bill (AWB)
              </label>
              <input
                type="text"
                className="input-field"
                placeholder="e.g. AWB-982348271"
                value={newTrackingNumber}
                onChange={(e) => setNewTrackingNumber(e.target.value)}
                required
                style={{ width: '100%' }}
              />
            </div>
            <div style={{ display: 'flex', alignItems: 'flex-end', gap: '0.5rem' }}>
              <button type="submit" className="btn btn-primary" disabled={isSubmitting}>
                {isSubmitting ? 'Registering...' : 'Save Shipment'}
              </button>
              <button type="button" className="btn btn-secondary" onClick={() => setShowCreateModal(false)}>
                Cancel
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Shipments List */}
      <div className="card" style={{ padding: '1.5rem' }}>
        <h2 style={{ fontSize: '1.2rem', fontWeight: 600, marginBottom: '1rem' }}>Active Fulfillment Shipments</h2>

        {isLoading ? (
          <p className="text-muted" style={{ padding: '2rem', textAlign: 'center' }}>Loading shipments...</p>
        ) : shipments.length === 0 ? (
          <p className="text-muted" style={{ padding: '2rem', textAlign: 'center' }}>
            No shipments registered yet. When orders are received in the Orders tab, register them for carrier pickup here.
          </p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            {shipments.map((s) => (
              <div
                key={s.id}
                style={{
                  border: '1px solid var(--border)',
                  borderRadius: '8px',
                  padding: '1.25rem',
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  flexWrap: 'wrap',
                  gap: '1rem',
                  background: 'var(--bg-main)',
                }}
              >
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '0.35rem' }}>
                    <span style={{ fontWeight: 700, fontSize: '1rem' }}>Shipment #{s.id.slice(0, 8)}</span>
                    <span
                      style={{
                        padding: '2px 8px',
                        borderRadius: '999px',
                        fontSize: '0.75rem',
                        fontWeight: 700,
                        background:
                          s.status === 'DELIVERED'
                            ? 'rgba(34, 197, 94, 0.15)'
                            : s.status === 'SHIPPED'
                            ? 'rgba(37, 99, 235, 0.15)'
                            : 'rgba(234, 179, 8, 0.15)',
                        color:
                          s.status === 'DELIVERED'
                            ? 'var(--accent-green)'
                            : s.status === 'SHIPPED'
                            ? 'var(--brand)'
                            : 'var(--accent-amber)',
                      }}
                    >
                      {s.status}
                    </span>
                  </div>
                  <div style={{ fontSize: '0.8rem', color: 'var(--primary-muted)' }}>
                    Carrier: <strong>{s.carrier || 'Standard Courier'}</strong> &bull; Tracking: <code>{s.trackingNumber || 'Pending AWB'}</code>
                  </div>
                  <div style={{ fontSize: '0.75rem', color: 'var(--primary-muted)', marginTop: '0.2rem' }}>
                    Seller Order: <code>{s.sellerOrderId}</code> &bull; Items count: {s.items?.length || 1}
                  </div>
                </div>

                <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                  {s.status === 'PREPARING' && (
                    <button
                      type="button"
                      className="btn btn-secondary"
                      style={{ fontSize: '0.8rem', padding: '0.35rem 0.75rem' }}
                      onClick={() => handleUpdateStatus(s.id, 'PACKED')}
                    >
                      Mark Packed &rarr;
                    </button>
                  )}
                  {(s.status === 'PREPARING' || s.status === 'PACKED') && (
                    <button
                      type="button"
                      className="btn btn-primary"
                      style={{ fontSize: '0.8rem', padding: '0.35rem 0.75rem' }}
                      onClick={() => handleUpdateStatus(s.id, 'SHIPPED')}
                    >
                      Dispatch / Ship &rarr;
                    </button>
                  )}
                  {s.status === 'SHIPPED' && (
                    <button
                      type="button"
                      className="btn btn-primary"
                      style={{ fontSize: '0.8rem', padding: '0.35rem 0.75rem', background: 'var(--accent-green)' }}
                      onClick={() => handleUpdateStatus(s.id, 'DELIVERED')}
                    >
                      Confirm Delivery ✓
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};
