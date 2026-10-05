import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { apiClient } from '../../api/client';
import { useAuth } from '../auth/AuthContext';
import { merchantApi, type MerchantProfileDto } from './api/merchant';

export const MerchantOnboarding = () => {
  const { user } = useAuth();
  const [profile, setProfile] = useState<MerchantProfileDto | null>(null);
  const [businessName, setBusinessName] = useState('');
  const [legalName, setLegalName] = useState('');
  const [contactEmail, setContactEmail] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadProfile = async () => {
    setIsLoading(true);
    setError(null);
    try {
      const p = await merchantApi.getProfile();
      setProfile(p);
      setBusinessName(p.businessName || '');
      setLegalName(p.legalName || '');
      setContactEmail(p.contactEmail || '');
    } catch {
      setProfile(null);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    loadProfile();
  }, []);

  const handleOnboardOrUpdate = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);
    setError(null);
    setMessage(null);

    try {
      if (!profile) {
        const created = await apiClient<MerchantProfileDto>('/merchants/onboard', {
          method: 'POST',
          body: JSON.stringify({
            businessName,
            legalName,
            contactEmail,
          }),
        });
        setProfile(created);
        setMessage('Merchant profile initialized successfully!');
      } else {
        const updated = await apiClient<MerchantProfileDto>('/merchants/me', {
          method: 'PATCH',
          body: JSON.stringify({
            businessName,
            legalName,
            contactEmail,
          }),
        });
        setProfile(updated);
        setMessage('Merchant profile updated successfully!');
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Operation failed');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleSubmitForVerification = async () => {
    setIsSubmitting(true);
    setError(null);
    try {
      const updated = await apiClient<MerchantProfileDto>('/merchants/me/submit', {
        method: 'POST',
        body: JSON.stringify({}),
      });
      setProfile(updated);
      setMessage('Profile submitted for platform compliance review.');
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to submit verification');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleAdminApprove = async () => {
    if (!profile) return;
    setIsSubmitting(true);
    try {
      const updated = await apiClient<MerchantProfileDto>(`/merchants/${profile.tenantId}/approve`, {
        method: 'POST',
        body: JSON.stringify({}),
      });
      setProfile(updated);
      setMessage('Merchant officially approved for marketplace commercial listings.');
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Approval failed');
    } finally {
      setIsSubmitting(false);
    }
  };

  if (isLoading) {
    return (
      <div className="container" style={{ padding: '4rem 1rem', textAlign: 'center' }}>
        <p className="text-muted">Loading merchant onboarding state...</p>
      </div>
    );
  }

  return (
    <div className="container" style={{ padding: '2rem 1rem 4rem', maxWidth: '700px', margin: '0 auto' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '2rem' }}>
        <div>
          <h1 className="font-display" style={{ fontSize: '1.75rem', marginBottom: '0.25rem' }}>
            Merchant Onboarding &amp; KYC
          </h1>
          <p className="text-muted" style={{ fontSize: '0.9rem' }}>
            Multi-vendor store verification and state machine lifecycle (Section 8).
          </p>
        </div>
        <Link to="/merchant" className="btn btn-secondary">
          &larr; Hub
        </Link>
      </div>

      {message && (
        <div className="card" style={{ borderColor: 'var(--accent-green)', background: 'rgba(34, 197, 94, 0.1)', color: 'var(--accent-green)', padding: '1rem', marginBottom: '1.5rem' }}>
          {message}
        </div>
      )}

      {error && (
        <div className="card" style={{ borderColor: 'var(--accent-red)', color: 'var(--accent-red)', padding: '1rem', marginBottom: '1.5rem' }}>
          {error}
        </div>
      )}

      {/* Verification Status Card */}
      {profile && (
        <div className="card" style={{ padding: '1.5rem', marginBottom: '2rem' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div>
              <div style={{ fontSize: '0.85rem', color: 'var(--primary-muted)' }}>Verification Status</div>
              <div style={{ fontSize: '1.25rem', fontWeight: 700, marginTop: '0.25rem', color: profile.verificationStatus === 'VERIFIED' ? 'var(--accent-green)' : 'var(--accent-amber)' }}>
                {profile.verificationStatus}
              </div>
            </div>

            <div style={{ display: 'flex', gap: '0.5rem' }}>
              {profile.verificationStatus === 'DRAFT' && (
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={isSubmitting}
                  onClick={handleSubmitForVerification}
                >
                  Submit for Verification &rarr;
                </button>
              )}

              {user?.role === 'ADMINISTRATOR' && profile.verificationStatus === 'SUBMITTED' && (
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={isSubmitting}
                  onClick={handleAdminApprove}
                >
                  Admin Approve Merchant
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Form */}
      <div className="card" style={{ padding: '2rem' }}>
        <form onSubmit={handleOnboardOrUpdate}>
          <div style={{ marginBottom: '1.25rem' }}>
            <label style={{ display: 'block', fontSize: '0.85rem', fontWeight: 600, marginBottom: '0.5rem' }}>
              Trading / Storefront Business Name
            </label>
            <input
              type="text"
              required
              value={businessName}
              onChange={(e) => setBusinessName(e.target.value)}
              placeholder="e.g. Apex Electronics, QuickStore"
              style={{
                width: '100%',
                padding: '0.65rem 0.85rem',
                borderRadius: '6px',
                border: '1px solid var(--border)',
                background: 'var(--bg-card)',
                color: 'var(--text-main)',
              }}
            />
          </div>

          <div style={{ marginBottom: '1.25rem' }}>
            <label style={{ display: 'block', fontSize: '0.85rem', fontWeight: 600, marginBottom: '0.5rem' }}>
              Registered Legal Entity Name
            </label>
            <input
              type="text"
              required
              value={legalName}
              onChange={(e) => setLegalName(e.target.value)}
              placeholder="e.g. Apex Commercial Pvt Ltd"
              style={{
                width: '100%',
                padding: '0.65rem 0.85rem',
                borderRadius: '6px',
                border: '1px solid var(--border)',
                background: 'var(--bg-card)',
                color: 'var(--text-main)',
              }}
            />
          </div>

          <div style={{ marginBottom: '1.75rem' }}>
            <label style={{ display: 'block', fontSize: '0.85rem', fontWeight: 600, marginBottom: '0.5rem' }}>
              Operational Contact Email
            </label>
            <input
              type="email"
              required
              value={contactEmail}
              onChange={(e) => setContactEmail(e.target.value)}
              placeholder="seller@apex.com"
              style={{
                width: '100%',
                padding: '0.65rem 0.85rem',
                borderRadius: '6px',
                border: '1px solid var(--border)',
                background: 'var(--bg-card)',
                color: 'var(--text-main)',
              }}
            />
          </div>

          <button
            type="submit"
            className="btn btn-primary"
            disabled={isSubmitting}
            style={{ width: '100%', padding: '0.75rem' }}
          >
            {isSubmitting ? 'Saving Profile...' : profile ? 'Save Changes' : 'Initialize Merchant Store'}
          </button>
        </form>
      </div>
    </div>
  );
};
