import { useState, useEffect } from 'react';
import { useAuth } from '../auth/AuthContext';
import { apiClient } from '../../api/client';
import { Navigate } from 'react-router-dom';

interface OutboxEvent {
  id: string;
  eventType: string;
  aggregateId?: string;
  status?: string;
  processedAt?: string;
  createdAt: string;
}

export const AdminEvents = () => {
  const { user } = useAuth();
  const [events, setEvents] = useState<OutboxEvent[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [typeFilter, setTypeFilter] = useState('');

  useEffect(() => {
    if (user?.role !== 'ADMINISTRATOR') return;
    apiClient<unknown>('/events?limit=50')
      .then((res) => {
        const list = Array.isArray(res)
          ? (res as OutboxEvent[])
          : ((res as { events?: OutboxEvent[] }).events ?? []);
        setEvents(list);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : 'Failed to load events'))
      .finally(() => setIsLoading(false));
  }, [user]);

  if (user?.role !== 'ADMINISTRATOR') return <Navigate to="/account" replace />;

  const eventTypes = [...new Set(events.map((e) => e.eventType))].slice(0, 20);
  const filtered = events.filter((e) => !typeFilter || e.eventType === typeFilter);

  return (
    <div style={{ padding: '2rem 0 4rem' }}>
      <div style={{ marginBottom: '1.5rem' }}>
        <h1 className="font-display" style={{ fontSize: '1.75rem' }}>Domain Events & Outbox</h1>
        <p className="text-muted">Transactional outbox event log ({events.length} events loaded)</p>
      </div>

      <div className="card" style={{ padding: '1rem', marginBottom: '1.5rem', display: 'flex', gap: '1rem', alignItems: 'center', flexWrap: 'wrap' }}>
        <select
          value={typeFilter}
          onChange={(e) => setTypeFilter(e.target.value)}
          style={{
            padding: '0.5rem 0.85rem', borderRadius: '8px',
            border: '1px solid var(--border)', background: 'var(--bg-main)', color: 'var(--text-main)',
          }}
        >
          <option value="">All Event Types</option>
          {eventTypes.map((t) => (
            <option key={t} value={t}>{t}</option>
          ))}
        </select>
        <span className="text-muted" style={{ fontSize: '0.85rem' }}>
          Showing {filtered.length} of {events.length} events
        </span>
      </div>

      {isLoading && <div className="card" style={{ padding: '3rem', textAlign: 'center' }}>Loading events...</div>}
      {error && <div className="card" style={{ padding: '2rem', textAlign: 'center', color: 'var(--accent-red)' }}>⚠️ {error}</div>}
      {!isLoading && !error && filtered.length === 0 && (
        <div className="card" style={{ padding: '3rem', textAlign: 'center', color: 'var(--primary-muted)' }}>📡 No events found</div>
      )}
      {!isLoading && !error && filtered.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
          {filtered.slice(0, 30).map((e) => (
            <div
              key={e.id}
              className="card"
              style={{ padding: '0.85rem 1rem', display: 'flex', gap: '1rem', alignItems: 'center', flexWrap: 'wrap' }}
            >
              <span style={{ fontFamily: 'monospace', fontSize: '0.78rem', color: 'var(--primary-muted)', minWidth: '80px' }}>
                {e.id.slice(0, 8)}
              </span>
              <span style={{
                background: 'rgba(99,102,241,0.15)', color: 'var(--brand)',
                padding: '0.2rem 0.6rem', borderRadius: '4px', fontSize: '0.8rem', fontWeight: 700, flexShrink: 0,
              }}>
                {e.eventType}
              </span>
              <span style={{ fontSize: '0.8rem', color: 'var(--primary-muted)', fontFamily: 'monospace' }}>
                {e.aggregateId?.slice(0, 12) ?? '—'}
              </span>
              <span style={{
                fontSize: '0.8rem',
                color: e.processedAt ? 'var(--accent-green)' : 'var(--accent-amber)',
                fontWeight: 600, marginLeft: 'auto',
              }}>
                {e.processedAt ? 'Processed' : 'Pending'}
              </span>
              <span style={{ fontSize: '0.78rem', color: 'var(--primary-muted)' }}>
                {e.createdAt ? new Date(e.createdAt).toLocaleString() : ''}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
