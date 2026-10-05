import { useState, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import { Check } from 'lucide-react';
import { apiClient } from '../../api/client';

export interface ShipmentDto {
  id: string;
  sellerOrderId: string;
  customerOrderId: string;
  carrier?: string | null;
  trackingNumber?: string | null;
  trackingUrl?: string | null;
  status: 'PREPARING' | 'PICKED' | 'PACKED' | 'SHIPPED' | 'DELIVERED' | 'CANCELLED';
  estimatedDeliveryDate?: string | null;
  shippedAt?: string | null;
  deliveredAt?: string | null;
  createdAt: string;
}

export const ShipmentTracker = () => {
  const { id } = useParams<{ id: string }>();
  const [shipment, setShipment] = useState<ShipmentDto | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    const fetchShipment = async () => {
      setIsLoading(true);
      setError(null);
      try {
        const data = await apiClient<ShipmentDto>(`/fulfillment/shipments/${id}`);
        setShipment(data);
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : 'Failed to locate shipment tracking');
      } finally {
        setIsLoading(false);
      }
    };
    fetchShipment();
  }, [id]);

  const milestones: Array<{ label: string; key: ShipmentDto['status'] }> = [
    { label: 'Order Allocated', key: 'PREPARING' },
    { label: 'Picked & Packed', key: 'PACKED' },
    { label: 'In Transit / Shipped', key: 'SHIPPED' },
    { label: 'Delivered', key: 'DELIVERED' },
  ];

  const getStepStatus = (stepKey: ShipmentDto['status'], currentStatus: ShipmentDto['status']) => {
    const order = ['PREPARING', 'PICKED', 'PACKED', 'SHIPPED', 'DELIVERED'];
    const stepIdx = order.indexOf(stepKey);
    const currIdx = order.indexOf(currentStatus);
    if (currIdx >= stepIdx) return 'completed';
    return 'pending';
  };

  if (isLoading) {
    return (
      <div className="container" style={{ padding: '4rem 1rem', textAlign: 'center' }}>
        <p className="text-muted">Querying carrier telemetry &amp; delivery timeline...</p>
      </div>
    );
  }

  if (error || !shipment) {
    return (
      <div className="container" style={{ padding: '3rem 1rem', maxWidth: '600px', margin: '0 auto', textAlign: 'center' }}>
        <div className="card" style={{ padding: '2rem' }}>
          <h2 style={{ fontSize: '1.25rem', marginBottom: '0.5rem' }}>Tracking Unavailable</h2>
          <p className="text-muted" style={{ marginBottom: '1.5rem' }}>
            {error || 'Shipment record not found.'}
          </p>
          <Link to="/orders" className="btn btn-secondary">
            &larr; Back to My Orders
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="container" style={{ padding: '2rem 1rem 4rem', maxWidth: '700px', margin: '0 auto' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '2rem' }}>
        <div>
          <h1 className="font-display" style={{ fontSize: '1.75rem', marginBottom: '0.25rem' }}>
            Shipment Live Tracking
          </h1>
          <p className="text-muted" style={{ fontSize: '0.85rem' }}>
            Authoritative fulfillment progression from warehouse dispatch to delivery.
          </p>
        </div>
        <Link to="/orders" className="btn btn-secondary">
          &larr; My Orders
        </Link>
      </div>

      {/* Main Status Card */}
      <div className="card" style={{ padding: '2rem', marginBottom: '2rem' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid var(--border)', paddingBottom: '1rem', marginBottom: '1.5rem' }}>
          <div>
            <span className="text-muted" style={{ fontSize: '0.8rem' }}>Shipment ID:</span>
            <div style={{ fontWeight: 700, fontSize: '1.1rem' }}>#{shipment.id.slice(0, 8)}</div>
          </div>
          <span style={{
            padding: '0.35rem 0.85rem',
            borderRadius: '999px',
            fontSize: '0.85rem',
            fontWeight: 600,
            background: shipment.status === 'DELIVERED' ? 'rgba(34, 197, 94, 0.15)' : 'rgba(59, 130, 246, 0.15)',
            color: shipment.status === 'DELIVERED' ? 'var(--accent-green)' : 'var(--accent-blue)',
          }}>
            {shipment.status}
          </span>
        </div>

        {/* Carrier Info */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '1rem', marginBottom: '2rem' }}>
          <div style={{ background: 'var(--bg-main)', padding: '1rem', borderRadius: '8px' }}>
            <span className="text-muted" style={{ fontSize: '0.75rem' }}>Logistics Partner</span>
            <div style={{ fontWeight: 600, marginTop: '0.25rem' }}>{shipment.carrier || 'Express Logistics'}</div>
          </div>
          <div style={{ background: 'var(--bg-main)', padding: '1rem', borderRadius: '8px' }}>
            <span className="text-muted" style={{ fontSize: '0.75rem' }}>Tracking Number</span>
            <div style={{ fontWeight: 600, marginTop: '0.25rem' }}>{shipment.trackingNumber || 'TRK-IN-009823'}</div>
          </div>
        </div>

        {/* Vertical / Horizontal Milestone Tracker */}
        <div style={{ display: 'flex', justifyContent: 'space-between', position: 'relative', marginTop: '1.5rem' }}>
          {milestones.map((m, idx) => {
            const state = getStepStatus(m.key, shipment.status);
            return (
              <div key={idx} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center', flex: 1 }}>
                <div style={{
                  width: '32px',
                  height: '32px',
                  borderRadius: '50%',
                  background: state === 'completed' ? 'var(--brand)' : 'var(--border)',
                  color: '#ffffff',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: '0.85rem',
                  fontWeight: 700,
                  marginBottom: '0.5rem',
                }}>
                  {state === 'completed' ? <Check size={14} strokeWidth={3} /> : idx + 1}
                </div>
                <div style={{ fontSize: '0.8rem', fontWeight: state === 'completed' ? 600 : 400, color: state === 'completed' ? 'var(--text-main)' : 'var(--primary-muted)' }}>
                  {m.label}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};
