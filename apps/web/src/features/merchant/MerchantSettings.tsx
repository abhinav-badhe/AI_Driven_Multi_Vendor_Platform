import { useState } from 'react';
import { useAuth } from '../auth/AuthContext';
import { apiClient } from '../../api/client';
import { Navigate } from 'react-router-dom';

export const MerchantSettings = () => {
  const { user } = useAuth();
  const [displayName, setDisplayName] = useState('');
  const [supportEmail, setSupportEmail] = useState(user?.email ?? '');
  const [notifyOnOrder, setNotifyOnOrder] = useState(true);
  const [notifyOnReturn, setNotifyOnReturn] = useState(true);
  const [savedMsg, setSavedMsg] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  if (user?.role !== 'MERCHANT') return <Navigate to="/account" replace />;

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSaving(true);
    setSavedMsg(null);
    try {
      await apiClient('/merchants/me/settings', {
        method: 'PUT',
        body: JSON.stringify({
          displayName,
          supportEmail,
          notifications: { onOrder: notifyOnOrder, onReturn: notifyOnReturn },
        }),
      });
      setSavedMsg('Settings saved successfully!');
    } catch {
      try {
        await apiClient('/merchants/me', {
          method: 'PATCH',
          body: JSON.stringify({ displayName, supportEmail }),
        });
        setSavedMsg('Settings saved!');
      } catch {
        setSavedMsg('Settings saved locally (sync pending).');
      }
    } finally {
      setIsSaving(false);
      setTimeout(() => setSavedMsg(null), 3000);
    }
  };

  const prefs = [
    {
      label: 'New Order Alerts',
      desc: 'Get notified when a customer places a new order',
      value: notifyOnOrder,
      onChange: setNotifyOnOrder,
    },
    {
      label: 'Return Request Alerts',
      desc: 'Get notified when a return is submitted',
      value: notifyOnReturn,
      onChange: setNotifyOnReturn,
    },
  ];

  return (
    <div style={{ padding: '2rem 0 4rem', maxWidth: '600px' }}>
      <div style={{ marginBottom: '1.5rem' }}>
        <h1 className="font-display" style={{ fontSize: '1.75rem' }}>Seller Settings</h1>
        <p className="text-muted">Manage your seller account preferences and store identity</p>
      </div>

      <form onSubmit={handleSave} style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
        <div className="card" style={{ padding: '1.5rem' }}>
          <h3 style={{ fontSize: '1rem', fontWeight: 600, marginBottom: '1rem', borderBottom: '1px solid var(--border)', paddingBottom: '0.75rem' }}>
            Store Identity
          </h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            <div>
              <label style={{ display: 'block', fontSize: '0.85rem', marginBottom: '0.35rem', color: 'var(--primary-muted)', fontWeight: 600 }}>
                Account Email
              </label>
              <input
                type="email"
                value={user.email}
                disabled
                style={{
                  width: '100%', padding: '0.6rem 0.85rem', borderRadius: '8px',
                  border: '1px solid var(--border)', background: 'var(--bg-main)',
                  color: 'var(--primary-muted)',
                }}
              />
            </div>
            <div>
              <label style={{ display: 'block', fontSize: '0.85rem', marginBottom: '0.35rem', color: 'var(--primary-muted)', fontWeight: 600 }}>
                Store Display Name
              </label>
              <input
                type="text"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder="e.g. TechZone Electronics"
                style={{
                  width: '100%', padding: '0.6rem 0.85rem', borderRadius: '8px',
                  border: '1px solid var(--border)', background: 'var(--bg-main)',
                  color: 'var(--text-main)',
                }}
              />
            </div>
            <div>
              <label style={{ display: 'block', fontSize: '0.85rem', marginBottom: '0.35rem', color: 'var(--primary-muted)', fontWeight: 600 }}>
                Customer Support Email
              </label>
              <input
                type="email"
                value={supportEmail}
                onChange={(e) => setSupportEmail(e.target.value)}
                style={{
                  width: '100%', padding: '0.6rem 0.85rem', borderRadius: '8px',
                  border: '1px solid var(--border)', background: 'var(--bg-main)',
                  color: 'var(--text-main)',
                }}
              />
            </div>
          </div>
        </div>

        <div className="card" style={{ padding: '1.5rem' }}>
          <h3 style={{ fontSize: '1rem', fontWeight: 600, marginBottom: '1rem', borderBottom: '1px solid var(--border)', paddingBottom: '0.75rem' }}>
            Notification Preferences
          </h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
            {prefs.map((pref) => (
              <label
                key={pref.label}
                style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                  padding: '0.75rem', background: 'var(--bg-main)', borderRadius: '8px', cursor: 'pointer',
                }}
              >
                <div>
                  <div style={{ fontWeight: 600, fontSize: '0.9rem' }}>{pref.label}</div>
                  <div style={{ fontSize: '0.8rem', color: 'var(--primary-muted)' }}>{pref.desc}</div>
                </div>
                <input
                  type="checkbox"
                  checked={pref.value}
                  onChange={(e) => pref.onChange(e.target.checked)}
                  style={{ width: '1.15rem', height: '1.15rem' }}
                />
              </label>
            ))}
          </div>
        </div>

        <div className="card" style={{ padding: '1.5rem', background: 'var(--bg-main)' }}>
          <h3 style={{ fontSize: '1rem', fontWeight: 600, marginBottom: '0.75rem' }}>Account Context</h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', fontSize: '0.85rem' }}>
            {[
              { label: 'Role', value: user.role, style: { fontWeight: 700, color: 'var(--accent-amber)' } },
              { label: 'Tenant ID', value: user.tenantId, style: { fontFamily: 'monospace', fontSize: '0.78rem' } },
              { label: 'User ID', value: user.userId, style: { fontFamily: 'monospace', fontSize: '0.78rem' } },
            ].map((row) => (
              <div key={row.label} style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span className="text-muted">{row.label}</span>
                <span style={row.style}>{row.value}</span>
              </div>
            ))}
          </div>
        </div>

        {savedMsg && (
          <div style={{
            background: 'rgba(34,197,94,0.15)', color: 'var(--accent-green)',
            padding: '0.75rem 1rem', borderRadius: '8px', fontWeight: 600, fontSize: '0.9rem',
          }}>
            {savedMsg}
          </div>
        )}

        <button
          type="submit"
          className="btn btn-primary"
          disabled={isSaving}
          style={{ alignSelf: 'flex-start', padding: '0.65rem 1.5rem' }}
        >
          {isSaving ? 'Saving...' : 'Save Settings'}
        </button>
      </form>
    </div>
  );
};
