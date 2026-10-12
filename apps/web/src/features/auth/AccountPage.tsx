import { useState, useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  Bell,
  MailCheck,
  MapPin,
  UserRound,
  BellRing,
  ShieldCheck,
  Copy,
  Check,
  Smartphone,
  KeyRound,
  ArrowLeft,
} from 'lucide-react';
import {
  useAuth,
  isEmailNotVerifiedError,
  type LoginCredentials,
  type UserContext,
} from './AuthContext';
import { apiClient } from '../../api/client';
import { Button, buttonVariants } from '../../components/ui/button';
import { Card, CardContent } from '../../components/ui/card';
import { Badge } from '../../components/ui/badge';
import { Alert } from '../../components/ui/alert';
import { Input, Label } from '../../components/ui/input';
import { cn } from '../../lib/utils';
import { AddressBook } from '../customer/AddressBook';
import { backInStockApi, type BackInStockSubscriptionDto } from '../customer/api/back-in-stock';
import { twoFactorApi, type TwoFactorSetupResponse } from './api/twoFactorApi';
import QRCode from 'qrcode';

interface NotificationPrefDto {
  emailEnabled?: boolean;
  smsEnabled?: boolean;
  pushEnabled?: boolean;
}

type Tab = 'profile' | 'security' | 'preferences' | 'addresses' | 'alerts';

export const AccountPage = ({
  redirectAfterLogin = false,
}: { redirectAfterLogin?: boolean } = {}) => {
  const navigate = useNavigate();
  const {
    isAuthenticated,
    user,
    login,
    verify2FALogin,
    register,
    resendVerification,
    forgotPassword,
    logout,
    isLoading,
  } = useAuth();
  const [activeTab, setActiveTab] = useState<Tab>('profile');
  const [authMode, setAuthMode] = useState<'signin' | 'signup'>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [storeName, setStoreName] = useState('');
  const [signupRole, setSignupRole] = useState<'CUSTOMER' | 'MERCHANT'>('CUSTOMER');
  const [pendingVerificationEmail, setPendingVerificationEmail] = useState<string | null>(null);
  const [needsVerificationEmail, setNeedsVerificationEmail] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Forgot password state
  const [isForgotPassword, setIsForgotPassword] = useState(false);
  const [forgotEmail, setForgotEmail] = useState('');
  const [forgotSuccessMsg, setForgotSuccessMsg] = useState<string | null>(null);
  const [isForgotSubmitting, setIsForgotSubmitting] = useState(false);

  // 2FA login challenge state
  const [twoFactorChallenge, setTwoFactorChallenge] = useState<{ tempToken: string } | null>(null);
  const [twoFactorCode, setTwoFactorCode] = useState('');
  const [isVerifying2FA, setIsVerifying2FA] = useState(false);

  // 2FA security tab state
  const [twoFactorEnabled, setTwoFactorEnabled] = useState<boolean | null>(null);
  const [isLoading2FAStatus, setIsLoading2FAStatus] = useState(false);
  const [twoFactorSetupData, setTwoFactorSetupData] = useState<TwoFactorSetupResponse | null>(null);
  const [confirm2FACode, setConfirm2FACode] = useState('');
  const [disablePassword, setDisablePassword] = useState('');
  const [isDisabling2FA, setIsDisabling2FA] = useState(false);
  const [copiedKey, setCopiedKey] = useState(false);
  const [copiedCodes, setCopiedCodes] = useState(false);
  const [twoFactorMsg, setTwoFactorMsg] = useState<string | null>(null);
  const [qrCodeDataUrl, setQrCodeDataUrl] = useState<string>('');

  const [prefs, setPrefs] = useState<NotificationPrefDto>({
    emailEnabled: true,
    smsEnabled: true,
    pushEnabled: true,
  });
  const [prefSavedMsg, setPrefSavedMsg] = useState<string | null>(null);

  const [stockAlerts, setStockAlerts] = useState<BackInStockSubscriptionDto[]>([]);
  const [isLoadingAlerts, setIsLoadingAlerts] = useState(false);
  const [cancellingSubId, setCancellingSubId] = useState<string | null>(null);
  const [alertFeedback, setAlertFeedback] = useState<string | null>(null);

  const loadStockAlerts = async () => {
    setIsLoadingAlerts(true);
    try {
      const list = await backInStockApi.getSubscriptions();
      setStockAlerts(Array.isArray(list) ? list : []);
    } catch {
      setStockAlerts([]);
    } finally {
      setIsLoadingAlerts(false);
    }
  };

  useEffect(() => {
    if (isAuthenticated && activeTab === 'alerts') {
      loadStockAlerts();
    }
  }, [isAuthenticated, activeTab]);

  const handleCancelAlert = async (sub: BackInStockSubscriptionDto) => {
    setCancellingSubId(sub.id);
    try {
      await backInStockApi.cancelSubscription(sub.productId);
      setStockAlerts((prev) =>
        prev.map((s) => (s.id === sub.id ? { ...s, status: 'CANCELLED' as const } : s)),
      );
      setAlertFeedback(`Stock alert cancelled.`);
      setTimeout(() => setAlertFeedback(null), 3000);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to cancel stock alert');
    } finally {
      setCancellingSubId(null);
    }
  };

  useEffect(() => {
    if (isAuthenticated) {
      apiClient<NotificationPrefDto>('/customers/me/notification-preferences')
        .then((p) => {
          if (p) setPrefs(p);
        })
        .catch(() => null);
    }
  }, [isAuthenticated]);

  const handleSavePreferences = async () => {
    try {
      await apiClient<NotificationPrefDto>('/customers/me/notification-preferences', {
        method: 'PUT',
        body: JSON.stringify(prefs),
      });
      setPrefSavedMsg('Notification preferences saved.');
      setTimeout(() => setPrefSavedMsg(null), 3000);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not save preferences.');
    }
  };

  const load2FAStatus = async () => {
    setIsLoading2FAStatus(true);
    try {
      const res = await twoFactorApi.getStatus();
      setTwoFactorEnabled(res.isEnabled);
    } catch {
      setTwoFactorEnabled(false);
    } finally {
      setIsLoading2FAStatus(false);
    }
  };

  useEffect(() => {
    if (isAuthenticated && activeTab === 'security') {
      load2FAStatus();
    }
  }, [isAuthenticated, activeTab]);

  useEffect(() => {
    if (twoFactorSetupData?.otpAuthUri) {
      QRCode.toDataURL(twoFactorSetupData.otpAuthUri, { width: 180, margin: 1 })
        .then((url: string) => setQrCodeDataUrl(url))
        .catch(() => setQrCodeDataUrl(''));
    } else {
      setQrCodeDataUrl('');
    }
  }, [twoFactorSetupData]);

  if (isLoading) {
    return <div className="p-4 text-sm text-muted-foreground">Loading account…</div>;
  }

  if (isAuthenticated && user) {
    const tabs: Array<{ id: Tab; label: string; icon: typeof UserRound }> = [
      { id: 'profile', label: 'Profile', icon: UserRound },
      { id: 'security', label: 'Security & 2FA', icon: ShieldCheck },
      { id: 'preferences', label: 'Notifications', icon: Bell },
      { id: 'addresses', label: 'Addresses', icon: MapPin },
      ...(user.role === 'CUSTOMER'
        ? [{ id: 'alerts' as Tab, label: 'Stock Alerts', icon: BellRing }]
        : []),
    ];
    return (
      <div className="mx-auto w-full max-w-2xl p-4">
        <Card>
          <CardContent className="p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h1 className="text-xl font-semibold tracking-tight">My Account</h1>
                <p className="mt-1 text-[13px] text-muted-foreground">
                  Profile, orders, and notification settings.
                </p>
              </div>
              <Button variant="outline" size="sm" onClick={() => logout()}>
                Log out
              </Button>
            </div>

            <div
              className="mt-4 flex gap-1 border-b border-border"
              role="tablist"
              aria-label="Account sections"
            >
              {tabs.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  role="tab"
                  aria-selected={activeTab === t.id}
                  onClick={() => setActiveTab(t.id)}
                  className={cn(
                    '-mb-px flex items-center gap-1.5 border-b-2 px-2.5 py-1.5 text-[13px] font-medium',
                    activeTab === t.id
                      ? 'border-primary text-foreground'
                      : 'border-transparent text-muted-foreground hover:text-foreground',
                  )}
                >
                  <t.icon className="size-4" aria-hidden />
                  {t.label}
                </button>
              ))}
            </div>

            {activeTab === 'profile' && (
              <dl className="mt-4 flex flex-col gap-2" role="tabpanel">
                <div className="rounded-md bg-muted px-3 py-2">
                  <dt className="text-xs text-muted-foreground">Email</dt>
                  <dd className="mt-0.5 text-sm font-medium">{user.email}</dd>
                </div>
                <div className="rounded-md bg-muted px-3 py-2">
                  <dt className="text-xs text-muted-foreground">Role</dt>
                  <dd className="mt-0.5 text-sm font-medium">{user.role}</dd>
                </div>
                <div className="rounded-md bg-muted px-3 py-2">
                  <dt className="text-xs text-muted-foreground">Tenant</dt>
                  <dd className="mt-0.5 font-mono text-xs">{user.tenantId}</dd>
                </div>
                <div className="mt-1 flex gap-1.5 flex-wrap">
                  <Link
                    to="/orders"
                    className={cn(buttonVariants({ variant: 'outline', size: 'sm' }))}
                  >
                    View orders
                  </Link>
                  <Link
                    to="/returns"
                    className={cn(buttonVariants({ variant: 'outline', size: 'sm' }))}
                  >
                    View returns
                  </Link>
                  <Link
                    to="/price-alerts"
                    className={cn(buttonVariants({ variant: 'outline', size: 'sm' }))}
                  >
                    View price alerts
                  </Link>
                </div>
              </dl>
            )}

            {activeTab === 'security' && (
              <div className="mt-4 space-y-4" role="tabpanel">
                <div className="flex items-center justify-between rounded-lg border border-border p-3.5">
                  <div className="flex items-center gap-3">
                    <div className="flex size-9 items-center justify-center rounded-md bg-muted">
                      <ShieldCheck className="size-5 text-primary" />
                    </div>
                    <div>
                      <p className="text-sm font-semibold">Two-factor authentication (TOTP)</p>
                      <p className="text-[13px] text-muted-foreground">
                        Require a 6-digit code from Google Authenticator, Microsoft Authenticator,
                        or Authy on login.
                      </p>
                    </div>
                  </div>
                  {isLoading2FAStatus ? (
                    <span className="text-xs text-muted-foreground">Loading…</span>
                  ) : (
                    <Badge variant={twoFactorEnabled ? 'success' : 'outline'}>
                      {twoFactorEnabled ? 'Enabled' : 'Disabled'}
                    </Badge>
                  )}
                </div>

                {twoFactorMsg && (
                  <Alert tone="success" title="Success">
                    {twoFactorMsg}
                  </Alert>
                )}

                {!twoFactorEnabled && !twoFactorSetupData && (
                  <div className="rounded-lg border border-border p-4">
                    <h3 className="text-sm font-semibold">Set up an authenticator app</h3>
                    <p className="mt-1 text-[13px] text-muted-foreground">
                      Add an extra layer of security to your account. You will need an authenticator
                      app on your mobile device.
                    </p>
                    <Button
                      size="sm"
                      className="mt-3"
                      onClick={async () => {
                        setError('');
                        try {
                          const setup = await twoFactorApi.setup();
                          setTwoFactorSetupData(setup);
                          try {
                            const dataUrl = await QRCode.toDataURL(setup.otpAuthUri, {
                              width: 180,
                              margin: 1,
                            });
                            setQrCodeDataUrl(dataUrl);
                          } catch {
                            setQrCodeDataUrl(
                              `https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=${encodeURIComponent(setup.otpAuthUri)}`,
                            );
                          }
                        } catch (err: unknown) {
                          setError(
                            err instanceof Error ? err.message : 'Failed to initiate 2FA setup',
                          );
                        }
                      }}
                    >
                      <Smartphone className="mr-1.5 size-4" />
                      Enable 2FA
                    </Button>
                  </div>
                )}

                {!twoFactorEnabled && twoFactorSetupData && (
                  <div className="rounded-lg border border-border p-4 space-y-4">
                    <div className="flex items-center justify-between">
                      <h3 className="text-sm font-semibold">
                        Step 1: Scan with Google Authenticator
                      </h3>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          setTwoFactorSetupData(null);
                          setQrCodeDataUrl('');
                          setConfirm2FACode('');
                        }}
                      >
                        Cancel
                      </Button>
                    </div>

                    <div className="flex flex-col sm:flex-row items-center gap-4 rounded-md border border-border bg-card p-3">
                      {qrCodeDataUrl && (
                        <div className="rounded-md border border-border bg-white p-2 shrink-0">
                          <img
                            src={qrCodeDataUrl}
                            alt="Google Authenticator QR Code"
                            className="size-36 block"
                          />
                        </div>
                      )}
                      <div className="flex-1 space-y-2 text-left w-full">
                        <p className="text-[13px] font-medium text-foreground">
                          Scan this QR code using your mobile app:
                        </p>
                        <ol className="text-xs text-muted-foreground list-decimal list-inside space-y-1">
                          <li>
                            Open <strong>Google Authenticator</strong> (or Authy / 1Password) on
                            your phone.
                          </li>
                          <li>
                            Tap the <strong>+</strong> button and select{' '}
                            <strong>Scan a QR code</strong>.
                          </li>
                          <li>Point your phone camera at this QR code.</li>
                        </ol>
                        <div className="pt-1.5 border-t border-border/60">
                          <p className="text-[11px] text-muted-foreground mb-1">
                            Cannot scan? Enter this setup key manually:
                          </p>
                          <div className="flex items-center gap-2 rounded bg-muted px-2.5 py-1.5 font-mono text-xs">
                            <span className="flex-1 break-all select-all font-semibold tracking-wider">
                              {twoFactorSetupData.secret}
                            </span>
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              className="h-6 text-xs px-2 shrink-0"
                              onClick={() => {
                                navigator.clipboard.writeText(twoFactorSetupData.secret);
                                setCopiedKey(true);
                                setTimeout(() => setCopiedKey(false), 2000);
                              }}
                            >
                              {copiedKey ? (
                                <Check className="size-3" />
                              ) : (
                                <Copy className="size-3" />
                              )}
                              <span className="ml-1 text-[11px]">
                                {copiedKey ? 'Copied' : 'Copy'}
                              </span>
                            </Button>
                          </div>
                        </div>
                      </div>
                    </div>

                    <div className="space-y-1.5">
                      <h3 className="text-sm font-semibold">
                        Step 2: Save your backup recovery codes
                      </h3>
                      <p className="text-[13px] text-muted-foreground">
                        Keep these single-use recovery codes in a safe place. If you ever lose your
                        phone, you can use one of these codes to sign in.
                      </p>
                      <div className="grid grid-cols-2 gap-2 rounded-md bg-muted p-3 font-mono text-xs">
                        {twoFactorSetupData.recoveryCodes.map((code) => (
                          <div key={code} className="text-foreground">
                            {code}
                          </div>
                        ))}
                      </div>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          navigator.clipboard.writeText(
                            twoFactorSetupData.recoveryCodes.join('\n'),
                          );
                          setCopiedCodes(true);
                          setTimeout(() => setCopiedCodes(false), 2000);
                        }}
                      >
                        {copiedCodes ? (
                          <Check className="size-3.5" />
                        ) : (
                          <Copy className="size-3.5" />
                        )}
                        <span className="ml-1 text-xs">
                          {copiedCodes ? 'Codes copied' : 'Copy recovery codes'}
                        </span>
                      </Button>
                    </div>

                    <div className="space-y-2 border-t border-border pt-3">
                      <h3 className="text-sm font-semibold">
                        Step 3: Enter the 6-digit code to confirm
                      </h3>
                      <div className="flex items-center gap-2">
                        <Input
                          type="text"
                          inputMode="numeric"
                          maxLength={6}
                          placeholder="123456"
                          className="w-36 font-mono text-center tracking-widest"
                          value={confirm2FACode}
                          onChange={(e) => setConfirm2FACode(e.target.value)}
                        />
                        <Button
                          size="sm"
                          disabled={confirm2FACode.trim().length !== 6}
                          onClick={async () => {
                            setError('');
                            try {
                              await twoFactorApi.enable(confirm2FACode);
                              setTwoFactorEnabled(true);
                              setTwoFactorSetupData(null);
                              setQrCodeDataUrl('');
                              setConfirm2FACode('');
                              setTwoFactorMsg(
                                'Two-factor authentication is now enabled on your account.',
                              );
                              setTimeout(() => setTwoFactorMsg(null), 4000);
                            } catch (err: unknown) {
                              setError(
                                err instanceof Error ? err.message : 'Failed to activate 2FA',
                              );
                            }
                          }}
                        >
                          Confirm & activate
                        </Button>
                      </div>
                    </div>
                  </div>
                )}

                {twoFactorEnabled && (
                  <div className="rounded-lg border border-border p-4 space-y-3">
                    <h3 className="text-sm font-semibold">Disable two-factor authentication</h3>
                    <p className="text-[13px] text-muted-foreground">
                      To disable 2FA, enter your current account password for security.
                    </p>
                    <div className="flex flex-col gap-2 max-w-sm">
                      <Input
                        type="password"
                        placeholder="Account password"
                        value={disablePassword}
                        onChange={(e) => setDisablePassword(e.target.value)}
                      />
                      <Button
                        variant="outline"
                        size="sm"
                        className="w-fit text-destructive hover:text-destructive"
                        disabled={!disablePassword || isDisabling2FA}
                        onClick={async () => {
                          setError('');
                          setIsDisabling2FA(true);
                          try {
                            await twoFactorApi.disable(disablePassword);
                            setTwoFactorEnabled(false);
                            setDisablePassword('');
                            setTwoFactorMsg('Two-factor authentication has been disabled.');
                            setTimeout(() => setTwoFactorMsg(null), 4000);
                          } catch (err: unknown) {
                            setError(err instanceof Error ? err.message : 'Failed to disable 2FA');
                          } finally {
                            setIsDisabling2FA(false);
                          }
                        }}
                      >
                        {isDisabling2FA ? 'Disabling…' : 'Disable 2FA'}
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            )}

            {activeTab === 'preferences' && (
              <div className="mt-4 flex flex-col gap-2" role="tabpanel">
                {prefSavedMsg && <Alert tone="success">{prefSavedMsg}</Alert>}
                {(
                  [
                    {
                      key: 'emailEnabled',
                      label: 'Email notifications',
                      hint: 'Order receipts and invoices',
                    },
                    {
                      key: 'smsEnabled',
                      label: 'SMS alerts',
                      hint: 'Verification codes and delivery updates',
                    },
                    {
                      key: 'pushEnabled',
                      label: 'Push notifications',
                      hint: 'Live shipment tracking',
                    },
                  ] as const
                ).map((row) => (
                  <label
                    key={row.key}
                    className="flex cursor-pointer items-center justify-between gap-3 rounded-md bg-muted px-3 py-2"
                  >
                    <span>
                      <span className="block text-[13px] font-medium">{row.label}</span>
                      <span className="block text-xs text-muted-foreground">{row.hint}</span>
                    </span>
                    <input
                      type="checkbox"
                      checked={prefs[row.key] ?? true}
                      onChange={(e) => setPrefs({ ...prefs, [row.key]: e.target.checked })}
                      className="size-4 accent-primary"
                    />
                  </label>
                ))}
                <Button size="sm" className="self-start" onClick={handleSavePreferences}>
                  Save preferences
                </Button>
              </div>
            )}

            {activeTab === 'addresses' && (
              <div className="mt-4" role="tabpanel">
                <AddressBook />
              </div>
            )}

            {activeTab === 'alerts' && (
              <div className="mt-4 flex flex-col gap-3" role="tabpanel">
                {alertFeedback && <Alert tone="success">{alertFeedback}</Alert>}
                {isLoadingAlerts ? (
                  <div className="py-6 text-center text-sm text-muted-foreground">
                    Loading stock alerts…
                  </div>
                ) : stockAlerts.length === 0 ? (
                  <div className="rounded-lg border border-dashed border-border p-6 text-center">
                    <BellRing className="mx-auto size-8 text-muted-foreground/60 mb-2" />
                    <p className="text-sm font-medium text-foreground">No stock alerts</p>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      When products are out of stock, click "Notify me when available" to get alerts
                      when restocked.
                    </p>
                  </div>
                ) : (
                  <ul className="flex flex-col gap-2.5">
                    {stockAlerts.map((sub) => (
                      <li
                        key={sub.id}
                        className="flex items-center justify-between gap-3 rounded-lg border border-border p-3 bg-card"
                      >
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <Link
                              to={`/product/${sub.productId}`}
                              className="font-medium text-sm hover:underline truncate"
                            >
                              {sub.product?.title ?? `Product ${sub.productId.slice(0, 8)}`}
                            </Link>
                            <Badge
                              variant={
                                sub.status === 'ACTIVE'
                                  ? 'warning'
                                  : sub.status === 'NOTIFIED'
                                    ? 'success'
                                    : 'outline'
                              }
                              className="text-[10px]"
                            >
                              {sub.status}
                            </Badge>
                          </div>
                          <p className="text-xs text-muted-foreground mt-0.5">
                            Subscribed on {new Date(sub.createdAt).toLocaleDateString()}
                            {sub.notifiedAt &&
                              ` • Notified on ${new Date(sub.notifiedAt).toLocaleDateString()}`}
                          </p>
                        </div>
                        {sub.status === 'ACTIVE' && (
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={cancellingSubId === sub.id}
                            onClick={() => handleCancelAlert(sub)}
                            data-testid={`cancel-alert-${sub.productId}`}
                          >
                            {cancellingSubId === sub.id ? 'Cancelling…' : 'Cancel Alert'}
                          </Button>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    );
  }

  const doLoginAndRedirect = async (creds: LoginCredentials) => {
    const outcome = await login(creds);
    if (outcome && 'requires2FA' in outcome && outcome.requires2FA) {
      setTwoFactorChallenge({ tempToken: outcome.tempToken });
      return;
    }
    const me = outcome as UserContext | undefined;
    if (redirectAfterLogin && me) {
      if (me.role === 'MERCHANT') navigate('/merchant');
      else if (me.role === 'ADMINISTRATOR') navigate('/admin');
      else navigate('/orders');
    }
  };

  const handleDemoLogin = async (role: 'CUSTOMER' | 'MERCHANT' | 'ADMINISTRATOR') => {
    setError('');
    setNeedsVerificationEmail(null);
    let creds: LoginCredentials;
    let targetPath = '/';

    if (role === 'ADMINISTRATOR') {
      creds = { email: 'leonsintegration@gmail.com', password: 'Password@2163' };
      targetPath = '/admin';
    } else if (role === 'MERCHANT') {
      creds = { email: 'merchant@example.com', password: 'password123' };
      targetPath = '/merchant';
    } else {
      creds = { email: 'customer@example.com', password: 'password123' };
      targetPath = '/orders';
    }

    setIsSubmitting(true);
    try {
      const outcome = await login(creds);
      if (outcome && 'requires2FA' in outcome && outcome.requires2FA) {
        setTwoFactorChallenge({ tempToken: outcome.tempToken });
        return;
      }
      navigate(targetPath);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Demo sign in failed.');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleVerify2FA = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!twoFactorChallenge) return;
    setError('');
    setIsVerifying2FA(true);
    try {
      const me = await verify2FALogin(twoFactorChallenge.tempToken, twoFactorCode);
      setTwoFactorChallenge(null);
      setTwoFactorCode('');
      if (redirectAfterLogin && me) {
        if (me.role === 'MERCHANT') navigate('/merchant');
        else if (me.role === 'ADMINISTRATOR') navigate('/admin');
        else navigate('/orders');
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Invalid verification code.');
    } finally {
      setIsVerifying2FA(false);
    }
  };

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setNeedsVerificationEmail(null);
    setIsSubmitting(true);
    try {
      await doLoginAndRedirect({ email, password });
    } catch (err: unknown) {
      if (isEmailNotVerifiedError(err)) {
        setNeedsVerificationEmail(email);
        setError('This email is not verified yet. Check your inbox, or request a new link below.');
      } else {
        setError(
          err instanceof Error ? err.message : 'Sign in failed. Check your email and password.',
        );
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleForgotPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setIsForgotSubmitting(true);
    try {
      const res = await forgotPassword(forgotEmail);
      setForgotSuccessMsg(
        res.message || 'If an account exists with this email, a password reset link has been sent.',
      );
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to request password reset.');
    } finally {
      setIsForgotSubmitting(false);
    }
  };

  const handleSignup = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setIsSubmitting(true);
    try {
      const result = (await register({
        email,
        password,
        tenantName: storeName.trim() || (signupRole === 'MERCHANT' ? `${email} store` : `${email}`),
        role: signupRole,
      })) as { email?: string } | undefined;
      if (!result?.email) throw new Error('Could not create account.');
      setPendingVerificationEmail(result.email);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not create account.');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleResend = async (targetEmail: string) => {
    setError('');
    setIsSubmitting(true);
    try {
      await resendVerification(targetEmail);
      setPendingVerificationEmail(targetEmail);
      setNeedsVerificationEmail(null);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not resend the link.');
    } finally {
      setIsSubmitting(false);
    }
  };

  if (pendingVerificationEmail) {
    return (
      <div className="mx-auto w-full max-w-md p-4">
        <Card>
          <CardContent className="p-4 text-center">
            <MailCheck className="mx-auto size-8 text-success" aria-hidden />
            <h1 className="mt-2 text-xl font-semibold tracking-tight">Check your inbox</h1>
            <p className="mt-1 text-[13px] text-muted-foreground">
              A verification link is on its way to <strong>{pendingVerificationEmail}</strong>. Sign
              in after clicking it. The link expires in 24 hours.
            </p>
            <div className="mt-3 flex justify-center gap-1.5">
              <Button variant="outline" size="sm" onClick={() => setPendingVerificationEmail(null)}>
                Back to sign in
              </Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={isSubmitting}
                onClick={() => handleResend(pendingVerificationEmail)}
              >
                Resend link
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-md p-4">
      <Card>
        <CardContent className="p-4">
          {twoFactorChallenge ? (
            <form onSubmit={handleVerify2FA} className="flex flex-col gap-3">
              <div className="rounded-lg border border-border p-3.5 bg-muted/40">
                <div className="flex items-center gap-2">
                  <ShieldCheck className="size-5 text-primary" />
                  <p className="text-sm font-semibold">Two-Factor Authentication</p>
                </div>
                <p className="mt-1 text-[13px] text-muted-foreground">
                  Enter the 6-digit code from Google Authenticator, or enter an 8-character backup
                  recovery code.
                </p>
              </div>

              {error && (
                <div className="mt-1">
                  <Alert tone="error">{error}</Alert>
                </div>
              )}

              <div className="flex flex-col gap-1">
                <Label htmlFor="twofactor-code">Verification Code or Recovery Code</Label>
                <Input
                  id="twofactor-code"
                  type="text"
                  autoFocus
                  placeholder="e.g. 123456 or A1B2-C3D4"
                  value={twoFactorCode}
                  onChange={(e) => setTwoFactorCode(e.target.value)}
                  className="font-mono text-center text-lg tracking-widest"
                  required
                />
              </div>

              <div className="flex items-center justify-between gap-2 mt-2">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setTwoFactorChallenge(null);
                    setTwoFactorCode('');
                    setError('');
                  }}
                >
                  Back to sign in
                </Button>
                <Button type="submit" size="sm" disabled={!twoFactorCode.trim() || isVerifying2FA}>
                  {isVerifying2FA ? 'Verifying…' : 'Verify & Sign in'}
                </Button>
              </div>
            </form>
          ) : isForgotPassword ? (
            <form onSubmit={handleForgotPassword} className="flex flex-col gap-3.5">
              <div className="flex items-center gap-2.5 mb-1">
                <div className="flex size-9 items-center justify-center rounded-lg bg-primary/10 text-primary">
                  <KeyRound className="size-4" />
                </div>
                <div>
                  <h2 className="text-base font-semibold leading-none">Forgot your password?</h2>
                  <p className="text-xs text-muted-foreground mt-1">
                    Enter your email to receive a secure password reset link.
                  </p>
                </div>
              </div>

              {error && <Alert tone="error">{error}</Alert>}
              {forgotSuccessMsg && <Alert tone="success">{forgotSuccessMsg}</Alert>}

              {!forgotSuccessMsg ? (
                <>
                  <div className="flex flex-col gap-1">
                    <Label htmlFor="forgot-email">Account Email</Label>
                    <Input
                      id="forgot-email"
                      type="email"
                      placeholder="you@example.com"
                      value={forgotEmail}
                      onChange={(e) => setForgotEmail(e.target.value)}
                      required
                      autoFocus
                    />
                  </div>

                  <Button type="submit" disabled={isForgotSubmitting || !forgotEmail.trim()}>
                    {isForgotSubmitting ? 'Sending reset link…' : 'Send Reset Link'}
                  </Button>
                </>
              ) : null}

              <div className="pt-1">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="w-full text-xs text-muted-foreground hover:text-foreground"
                  onClick={() => {
                    setIsForgotPassword(false);
                    setError('');
                    setForgotSuccessMsg(null);
                  }}
                >
                  <ArrowLeft className="mr-1.5 size-3.5" />
                  Back to sign in
                </Button>
              </div>
            </form>
          ) : (
            <>
              <div
                className="flex gap-1 rounded-md bg-muted p-1"
                role="tablist"
                aria-label="Sign in or create account"
              >
                {(
                  [
                    { id: 'signin', label: 'Sign in' },
                    { id: 'signup', label: 'Create account' },
                  ] as const
                ).map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    role="tab"
                    aria-selected={authMode === m.id}
                    onClick={() => {
                      setAuthMode(m.id);
                      setError('');
                      setNeedsVerificationEmail(null);
                    }}
                    className={cn(
                      'flex-1 rounded px-2 py-1.5 text-[13px] font-medium',
                      authMode === m.id ? 'bg-background shadow-sm' : 'text-muted-foreground',
                    )}
                  >
                    {m.label}
                  </button>
                ))}
              </div>

              {error && (
                <div className="mt-3">
                  <Alert tone="error">{error}</Alert>
                </div>
              )}
              {needsVerificationEmail && (
                <div className="mt-3">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={isSubmitting}
                    onClick={() => handleResend(needsVerificationEmail)}
                  >
                    Resend verification link
                  </Button>
                </div>
              )}

              {authMode === 'signin' ? (
                <form onSubmit={handleLogin} className="mt-3 flex flex-col gap-3">
                  <div className="flex flex-col gap-1">
                    <Label htmlFor="login-email">Email</Label>
                    <Input
                      id="login-email"
                      type="email"
                      placeholder="you@example.com"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      required
                    />
                  </div>
                  <div className="flex flex-col gap-1">
                    <div className="flex items-center justify-between">
                      <Label htmlFor="login-password">Password</Label>
                      <button
                        type="button"
                        onClick={() => {
                          setIsForgotPassword(true);
                          setForgotEmail(email);
                          setError('');
                          setForgotSuccessMsg(null);
                        }}
                        className="text-xs text-primary hover:underline font-medium"
                      >
                        Forgot password?
                      </button>
                    </div>
                    <Input
                      id="login-password"
                      type="password"
                      placeholder="••••••••"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      required
                    />
                  </div>
                  <Button type="submit" disabled={isSubmitting}>
                    {isSubmitting ? 'Signing in…' : 'Sign in'}
                  </Button>
                </form>
              ) : (
                <form onSubmit={handleSignup} className="mt-3 flex flex-col gap-3">
                  <div className="flex flex-col gap-1">
                    <Label htmlFor="signup-email">Email</Label>
                    <Input
                      id="signup-email"
                      type="email"
                      placeholder="you@example.com"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      required
                    />
                  </div>
                  <div className="flex flex-col gap-1">
                    <Label htmlFor="signup-password">Password (8+ characters)</Label>
                    <Input
                      id="signup-password"
                      type="password"
                      minLength={8}
                      placeholder="••••••••"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      required
                    />
                  </div>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className="flex flex-col gap-1">
                      <Label htmlFor="signup-role">I want to</Label>
                      <select
                        id="signup-role"
                        value={signupRole}
                        onChange={(e) => setSignupRole(e.target.value as 'CUSTOMER' | 'MERCHANT')}
                        className="h-8 rounded-md border border-input bg-background px-2.5 text-[13px] outline-none focus-visible:border-ring"
                      >
                        <option value="CUSTOMER">Shop</option>
                        <option value="MERCHANT">Sell</option>
                      </select>
                    </div>
                    <div className="flex flex-col gap-1">
                      <Label htmlFor="signup-store">
                        {signupRole === 'MERCHANT' ? 'Store name' : 'Display name'}
                      </Label>
                      <Input
                        id="signup-store"
                        placeholder={
                          signupRole === 'MERCHANT' ? 'e.g. Apex Electronics' : 'e.g. Asha Rao'
                        }
                        value={storeName}
                        onChange={(e) => setStoreName(e.target.value)}
                        required
                      />
                    </div>
                  </div>
                  <Button type="submit" disabled={isSubmitting}>
                    {isSubmitting ? 'Creating account…' : 'Create account'}
                  </Button>
                  <p className="text-center text-xs text-muted-foreground">
                    Verification is required before first sign in.
                  </p>
                </form>
              )}

              <div className="mt-5 border-t border-border pt-4">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    Instant Demo Sign-in
                  </span>
                  <span className="text-[11px] text-muted-foreground">Click to log in</span>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                  <button
                    type="button"
                    disabled={isSubmitting}
                    onClick={() => handleDemoLogin('CUSTOMER')}
                    className="flex flex-col items-start p-2.5 rounded-lg border border-border bg-card hover:bg-accent/40 hover:border-primary/40 transition-all text-left"
                  >
                    <div className="flex items-center justify-between w-full">
                      <span className="font-semibold text-xs text-foreground">Demo Customer</span>
                      <span className="text-[10px] px-1 py-0.5 rounded bg-muted text-muted-foreground">
                        Buyer
                      </span>
                    </div>
                    <span className="text-[11px] text-muted-foreground truncate w-full mt-0.5">
                      customer@example.com
                    </span>
                  </button>

                  <button
                    type="button"
                    disabled={isSubmitting}
                    onClick={() => handleDemoLogin('MERCHANT')}
                    className="flex flex-col items-start p-2.5 rounded-lg border border-border bg-card hover:bg-accent/40 hover:border-primary/40 transition-all text-left"
                  >
                    <div className="flex items-center justify-between w-full">
                      <span className="font-semibold text-xs text-foreground">Demo Merchant</span>
                      <span className="text-[10px] px-1 py-0.5 rounded bg-muted text-muted-foreground">
                        Seller
                      </span>
                    </div>
                    <span className="text-[11px] text-muted-foreground truncate w-full mt-0.5">
                      merchant@example.com
                    </span>
                  </button>

                  <button
                    type="button"
                    disabled={isSubmitting}
                    onClick={() => handleDemoLogin('ADMINISTRATOR')}
                    className="flex flex-col items-start p-2.5 rounded-lg border border-border bg-card hover:bg-accent/40 hover:border-primary/40 transition-all text-left"
                  >
                    <div className="flex items-center justify-between w-full">
                      <span className="font-semibold text-xs text-primary">Demo Admin</span>
                      <span className="text-[10px] px-1 py-0.5 rounded bg-primary/10 text-primary font-medium">
                        Platform
                      </span>
                    </div>
                    <span className="text-[11px] text-muted-foreground truncate w-full mt-0.5">
                      leonsintegration@...
                    </span>
                  </button>
                </div>
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
};
