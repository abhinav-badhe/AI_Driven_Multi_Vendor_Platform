import { useState, useEffect } from 'react';
import { useAuth } from '../auth/AuthContext';
import { apiClient } from '../../api/client';
import { Navigate } from 'react-router-dom';
import { Button } from '../../components/ui/button';
import { Card, CardContent } from '../../components/ui/card';
import { Mail, Smartphone, Bell, AlertTriangle } from 'lucide-react';

export interface NotificationRecordDto {
  id: string;
  tenantId: string;
  eventId: string;
  notificationType: string;
  channel: 'EMAIL' | 'SMS' | 'PUSH';
  recipient: string;
  status: 'PENDING' | 'PROCESSING' | 'SENT' | 'FAILED' | 'RETRY_SCHEDULED' | 'DEAD_LETTERED';
  attemptCount: number;
  maxAttempts: number;
  sentAt: string | null;
  lastError: string | null;
  createdAt: string;
}

export const AdminNotifications = () => {
  const { user } = useAuth();
  const [notifications, setNotifications] = useState<NotificationRecordDto[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);

  const loadNotifications = async () => {
    setIsLoading(true);
    setError(null);
    try {
      const data = await apiClient<{ items: NotificationRecordDto[] }>('/notifications?limit=50');
      setNotifications(data.items || []);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to load notifications');
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    if (user?.role !== 'ADMINISTRATOR') return;
    loadNotifications();
  }, [user]);

  const handleRetry = async (id: string) => {
    try {
      await apiClient(`/notifications/${id}/retry`, { method: 'POST' });
      setFeedback(`Retry triggered for notification ${id}`);
      setTimeout(() => setFeedback(null), 3000);
      loadNotifications();
    } catch (err: unknown) {
      alert(err instanceof Error ? err.message : 'Retry failed');
    }
  };

  if (user?.role !== 'ADMINISTRATOR') return <Navigate to="/account" replace />;

  return (
    <div style={{ padding: '2rem 0 4rem' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem' }}>
        <div>
          <h1 className="font-display" style={{ fontSize: '1.75rem' }}>Platform Notifications</h1>
          <p className="text-muted">Monitor outgoing transactional emails, SMS, and push notifications.</p>
        </div>
        <Button variant="outline" onClick={loadNotifications}>Refresh</Button>
      </div>

      {feedback && (
        <div className="card" style={{ background: 'rgba(34, 197, 94, 0.1)', borderColor: 'var(--accent-green)', padding: '0.75rem 1rem', marginBottom: '1.5rem' }}>
          {feedback}
        </div>
      )}

      {isLoading && <div className="card" style={{ padding: '3rem', textAlign: 'center' }}>Loading notifications...</div>}
      {error && <div className="card" style={{ padding: '2rem', textAlign: 'center', color: 'var(--accent-red)' }}>⚠️ {error}</div>}

      {!isLoading && !error && notifications.length === 0 && (
        <div className="card" style={{ padding: '3rem', textAlign: 'center', color: 'var(--primary-muted)' }}>
          No notifications found.
        </div>
      )}

      {!isLoading && !error && notifications.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          {notifications.map((n) => (
            <Card key={n.id}>
              <CardContent style={{ padding: '1.5rem', display: 'flex', gap: '1.5rem', flexWrap: 'wrap' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', minWidth: '40px' }}>
                  {n.channel === 'EMAIL' ? <Mail size={24} color="var(--brand)" /> :
                   n.channel === 'SMS' ? <Smartphone size={24} color="var(--accent-blue)" /> :
                   <Bell size={24} color="var(--accent-amber)" />}
                </div>

                <div style={{ flex: 1, minWidth: '250px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.5rem' }}>
                    <span style={{ fontWeight: 600 }}>{n.notificationType}</span>
                    <span style={{
                      padding: '0.15rem 0.5rem', borderRadius: '12px', fontSize: '0.75rem', fontWeight: 600,
                      background: n.status === 'SENT' ? 'rgba(34,197,94,0.1)' : n.status === 'FAILED' ? 'rgba(239,68,68,0.1)' : 'rgba(245,158,11,0.1)',
                      color: n.status === 'SENT' ? 'var(--accent-green)' : n.status === 'FAILED' ? 'var(--accent-red)' : 'var(--accent-amber)'
                    }}>
                      {n.status}
                    </span>
                  </div>
                  
                  <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '0.35rem 1rem', fontSize: '0.8rem', color: 'var(--primary-muted)' }}>
                    <span>Recipient:</span> <span style={{ fontWeight: 500 }}>{n.recipient}</span>
                    <span>Event ID:</span> <span style={{ fontFamily: 'monospace' }}>{n.eventId}</span>
                    <span>Created:</span> <span>{new Date(n.createdAt).toLocaleString()}</span>
                    <span>Attempts:</span> <span>{n.attemptCount} / {n.maxAttempts}</span>
                    {n.lastError && (
                      <>
                        <span style={{ color: 'var(--accent-red)' }}>Error:</span> 
                        <span style={{ color: 'var(--accent-red)', fontWeight: 500 }}>{n.lastError}</span>
                      </>
                    )}
                  </div>
                </div>

                <div style={{ display: 'flex', alignItems: 'center' }}>
                  {(n.status === 'FAILED' || n.status === 'DEAD_LETTERED') && (
                    <Button variant="outline" onClick={() => handleRetry(n.id)}>
                      <AlertTriangle size={14} className="mr-2" /> Retry
                    </Button>
                  )}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
};
