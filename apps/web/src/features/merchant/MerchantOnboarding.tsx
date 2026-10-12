import { useState, useEffect } from 'react';
import { useAuth } from '../auth/AuthContext';
import { apiClient } from '../../api/client';
import { merchantApi, type MerchantProfileDto } from './api/merchant';
import { Button } from '../../components/ui/button';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from '../../components/ui/card';
import { Badge } from '../../components/ui/badge';
import { Alert } from '../../components/ui/alert';
import { Skeleton } from '../../components/ui/empty';
import { Input, Label } from '../../components/ui/input';

const statusVariant = (s: MerchantProfileDto['verificationStatus']) =>
  s === 'VERIFIED'
    ? ('success' as const)
    : s === 'REJECTED' || s === 'SUSPENDED'
      ? ('destructive' as const)
      : ('warning' as const);

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
          body: JSON.stringify({ businessName, legalName, contactEmail }),
        });
        setProfile(created);
        setMessage('Store profile created.');
      } else {
        const updated = await apiClient<MerchantProfileDto>('/merchants/me', {
          method: 'PATCH',
          body: JSON.stringify({ businessName, legalName, contactEmail }),
        });
        setProfile(updated);
        setMessage('Store profile saved.');
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not save profile.');
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
      setMessage('Submitted for review.');
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not submit for review.');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleAdminApprove = async () => {
    if (!profile) return;
    setIsSubmitting(true);
    try {
      const updated = await apiClient<MerchantProfileDto>(
        `/merchants/${profile.tenantId}/approve`,
        {
          method: 'POST',
          body: JSON.stringify({}),
        },
      );
      setProfile(updated);
      setMessage('Merchant approved.');
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Approval failed.');
    } finally {
      setIsSubmitting(false);
    }
  };

  if (isLoading) {
    return (
      <div className="mx-auto w-full max-w-xl space-y-3 p-4" aria-label="Loading store profile">
        <Skeleton className="h-6 w-48" />
        <Skeleton className="h-40" />
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-xl space-y-4 p-4">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Store setup</h1>
        <p className="mt-1 text-[13px] text-muted-foreground">
          Business details and verification status. Listings activate once verified.
        </p>
      </div>

      {message && <Alert tone="success">{message}</Alert>}
      {error && <Alert tone="error">{error}</Alert>}

      {profile && (
        <Card>
          <CardContent className="flex flex-wrap items-center justify-between gap-3 p-4">
            <div>
              <p className="text-xs text-muted-foreground">Verification status</p>
              <p className="mt-1">
                <Badge variant={statusVariant(profile.verificationStatus)}>
                  {profile.verificationStatus}
                </Badge>
              </p>
            </div>
            {profile.verificationStatus === 'DRAFT' && (
              <Button size="sm" disabled={isSubmitting} onClick={handleSubmitForVerification}>
                {isSubmitting ? 'Submitting…' : 'Submit for verification'}
              </Button>
            )}
            {user?.role === 'ADMINISTRATOR' && profile.verificationStatus === 'SUBMITTED' && (
              <Button size="sm" disabled={isSubmitting} onClick={handleAdminApprove}>
                {isSubmitting ? 'Approving…' : 'Approve merchant'}
              </Button>
            )}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Business details</CardTitle>
          <CardDescription>Shown to customers on your offers.</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleOnboardOrUpdate} className="flex flex-col gap-3">
            <div className="flex flex-col gap-1">
              <Label htmlFor="ob-business">Business name</Label>
              <Input
                id="ob-business"
                required
                value={businessName}
                onChange={(e) => setBusinessName(e.target.value)}
                placeholder="e.g. Apex Electronics"
              />
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="ob-legal">Legal entity name</Label>
              <Input
                id="ob-legal"
                required
                value={legalName}
                onChange={(e) => setLegalName(e.target.value)}
                placeholder="e.g. Apex Commercial Pvt Ltd"
              />
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="ob-email">Contact email</Label>
              <Input
                id="ob-email"
                type="email"
                required
                value={contactEmail}
                onChange={(e) => setContactEmail(e.target.value)}
                placeholder="seller@example.com"
              />
            </div>
            <Button type="submit" disabled={isSubmitting} className="self-start">
              {isSubmitting ? 'Saving…' : profile ? 'Save changes' : 'Create store profile'}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
};
