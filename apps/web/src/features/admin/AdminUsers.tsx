import { useState, useEffect } from 'react';
import { useAuth } from '../auth/AuthContext';
import { apiClient } from '../../api/client';
import { Navigate } from 'react-router-dom';

interface UserRecord {
  id: string;
  email: string;
  role: string;
  tenantId: string;
  createdAt: string;
  isActive?: boolean;
}

export const AdminUsers = () => {
  const { user } = useAuth();
  const [users, setUsers] = useState<UserRecord[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [roleFilter, setRoleFilter] = useState<string>('ALL');

  useEffect(() => {
    if (user?.role !== 'ADMINISTRATOR') return;
    setIsLoading(true);
    setError(null);
    apiClient<unknown>('/admin/users')
      .then((res) => {
        const list = Array.isArray(res)
          ? (res as UserRecord[])
          : ((res as { users?: UserRecord[]; data?: UserRecord[]; items?: UserRecord[] }).users ??
             (res as { users?: UserRecord[]; data?: UserRecord[] }).data ??
             []);
        setUsers(list);
      })
      .catch(() => {
        apiClient<unknown>('/users')
          .then((res2) => {
            const list = Array.isArray(res2) ? (res2 as UserRecord[]) : [];
            setUsers(list);
          })
          .catch((err2: unknown) => {
            setError(err2 instanceof Error ? err2.message : 'Failed to load users');
          });
      })
      .finally(() => setIsLoading(false));
  }, [user]);

  if (user?.role !== 'ADMINISTRATOR') return <Navigate to="/account" replace />;

  const filtered = users.filter((u) => {
    const matchSearch =
      !searchTerm ||
      u.email.toLowerCase().includes(searchTerm.toLowerCase()) ||
      u.id.toLowerCase().includes(searchTerm.toLowerCase());
    const matchRole = roleFilter === 'ALL' || u.role === roleFilter;
    return matchSearch && matchRole;
  });

  const roleBadgeColor = (role: string) => {
    if (role === 'ADMINISTRATOR') return 'var(--accent-red)';
    if (role === 'MERCHANT') return 'var(--accent-amber)';
    return 'var(--accent-green)';
  };

  return (
    <div style={{ padding: '2rem 0 4rem' }}>
      <div style={{ marginBottom: '1.5rem' }}>
        <h1 className="font-display" style={{ fontSize: '1.75rem', marginBottom: '0.25rem' }}>
          User Management
        </h1>
        <p className="text-muted" style={{ fontSize: '0.9rem' }}>
          All registered users across all tenants. Total: <strong>{users.length}</strong>
        </p>
      </div>

      <div
        className="card"
        style={{ padding: '1rem 1.25rem', marginBottom: '1.5rem', display: 'flex', gap: '1rem', flexWrap: 'wrap', alignItems: 'center' }}
      >
        <input
          type="search"
          placeholder="Search by email or user ID..."
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
          style={{
            flex: 1, minWidth: '220px', padding: '0.5rem 0.85rem',
            borderRadius: '8px', border: '1px solid var(--border)',
            background: 'var(--bg-main)', color: 'var(--text-main)', fontSize: '0.9rem',
          }}
        />
        <select
          value={roleFilter}
          onChange={(e) => setRoleFilter(e.target.value)}
          style={{
            padding: '0.5rem 0.85rem', borderRadius: '8px',
            border: '1px solid var(--border)', background: 'var(--bg-main)',
            color: 'var(--text-main)', fontSize: '0.9rem',
          }}
        >
          <option value="ALL">All Roles</option>
          <option value="CUSTOMER">Customer</option>
          <option value="MERCHANT">Merchant</option>
          <option value="ADMINISTRATOR">Administrator</option>
        </select>
      </div>

      {isLoading && (
        <div className="card" style={{ padding: '3rem', textAlign: 'center', color: 'var(--primary-muted)' }}>
          <div style={{ fontSize: '2rem', marginBottom: '1rem' }}></div>
          <p>Loading users...</p>
        </div>
      )}

      {error && !isLoading && (
        <div className="card" style={{ padding: '2rem', textAlign: 'center', borderColor: 'var(--accent-red)' }}>
          <div style={{ fontSize: '2rem', marginBottom: '0.75rem' }}>⚠️</div>
          <p style={{ color: 'var(--accent-red)', fontWeight: 600 }}>{error}</p>
          <p className="text-muted" style={{ fontSize: '0.85rem', marginTop: '0.5rem' }}>
            The /admin/users endpoint may need to be implemented in the backend.
          </p>
        </div>
      )}

      {!isLoading && !error && filtered.length === 0 && (
        <div className="card" style={{ padding: '3rem', textAlign: 'center', color: 'var(--primary-muted)' }}>
          <div style={{ fontSize: '2.5rem', marginBottom: '1rem' }}></div>
          <p style={{ fontWeight: 600, marginBottom: '0.5rem' }}>No users found</p>
          <p style={{ fontSize: '0.85rem' }}>
            {searchTerm || roleFilter !== 'ALL' ? 'Try adjusting your filters.' : 'No users registered yet.'}
          </p>
        </div>
      )}

      {!isLoading && !error && filtered.length > 0 && (
        <div className="card" style={{ overflow: 'hidden' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border)', background: 'var(--bg-main)' }}>
                {['User', 'Role', 'Tenant', 'Registered', 'Status'].map((h) => (
                  <th key={h} style={{ padding: '0.75rem 1rem', textAlign: 'left', color: 'var(--primary-muted)', fontWeight: 600 }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.map((u, idx) => (
                <tr key={u.id} style={{ borderBottom: idx < filtered.length - 1 ? '1px solid var(--border)' : 'none' }}>
                  <td style={{ padding: '0.85rem 1rem' }}>
                    <div style={{ fontWeight: 600 }}>{u.email}</div>
                    <div style={{ fontSize: '0.72rem', color: 'var(--primary-muted)', fontFamily: 'monospace', marginTop: '0.15rem' }}>{u.id}</div>
                  </td>
                  <td style={{ padding: '0.85rem 1rem' }}>
                    <span style={{
                      background: roleBadgeColor(u.role) + '22', color: roleBadgeColor(u.role),
                      padding: '0.2rem 0.6rem', borderRadius: '6px', fontSize: '0.78rem', fontWeight: 700,
                    }}>
                      {u.role}
                    </span>
                  </td>
                  <td style={{ padding: '0.85rem 1rem', fontFamily: 'monospace', fontSize: '0.78rem', color: 'var(--primary-muted)' }}>{u.tenantId}</td>
                  <td style={{ padding: '0.85rem 1rem', color: 'var(--primary-muted)' }}>
                    {u.createdAt ? new Date(u.createdAt).toLocaleDateString() : '—'}
                  </td>
                  <td style={{ padding: '0.85rem 1rem' }}>
                    <span style={{ color: u.isActive !== false ? 'var(--accent-green)' : 'var(--accent-red)', fontWeight: 600, fontSize: '0.8rem' }}>
                      {u.isActive !== false ? '● Active' : '● Suspended'}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};
