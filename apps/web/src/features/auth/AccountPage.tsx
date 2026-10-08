import { useState, useEffect } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Bell, MailCheck, MapPin, UserRound, BellRing } from "lucide-react";
import { useAuth, isEmailNotVerifiedError, type LoginCredentials, type UserContext } from "./AuthContext";
import { apiClient } from "../../api/client";
import { Button, buttonVariants } from "../../components/ui/button";
import { Card, CardContent } from "../../components/ui/card";
import { Badge } from "../../components/ui/badge";
import { Alert } from "../../components/ui/alert";
import { Input, Label } from "../../components/ui/input";
import { cn } from "../../lib/utils";
import { AddressBook } from "../customer/AddressBook";
import { backInStockApi, type BackInStockSubscriptionDto } from "../customer/api/back-in-stock";

interface NotificationPrefDto {
  emailEnabled?: boolean;
  smsEnabled?: boolean;
  pushEnabled?: boolean;
}

type Tab = "profile" | "preferences" | "addresses" | "alerts";

export const AccountPage = ({ redirectAfterLogin = false }: { redirectAfterLogin?: boolean } = {}) => {
  const navigate = useNavigate();
  const { isAuthenticated, user, login, register, resendVerification, logout, isLoading } = useAuth();
  const [activeTab, setActiveTab] = useState<Tab>("profile");
  const [authMode, setAuthMode] = useState<"signin" | "signup">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [storeName, setStoreName] = useState("");
  const [signupRole, setSignupRole] = useState<"CUSTOMER" | "MERCHANT">("CUSTOMER");
  const [pendingVerificationEmail, setPendingVerificationEmail] = useState<string | null>(null);
  const [needsVerificationEmail, setNeedsVerificationEmail] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

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
    if (isAuthenticated && activeTab === "alerts") {
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
      setError(err instanceof Error ? err.message : "Failed to cancel stock alert");
    } finally {
      setCancellingSubId(null);
    }
  };

  useEffect(() => {
    if (isAuthenticated) {
      apiClient<NotificationPrefDto>("/customers/me/notification-preferences")
        .then((p) => {
          if (p) setPrefs(p);
        })
        .catch(() => null);
    }
  }, [isAuthenticated]);

  const handleSavePreferences = async () => {
    try {
      await apiClient<NotificationPrefDto>("/customers/me/notification-preferences", {
        method: "PUT",
        body: JSON.stringify(prefs),
      });
      setPrefSavedMsg("Notification preferences saved.");
      setTimeout(() => setPrefSavedMsg(null), 3000);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Could not save preferences.");
    }
  };

  if (isLoading) {
    return <div className="p-4 text-sm text-muted-foreground">Loading account…</div>;
  }

  if (isAuthenticated && user) {
    const tabs: Array<{ id: Tab; label: string; icon: typeof UserRound }> = [
      { id: "profile", label: "Profile", icon: UserRound },
      { id: "preferences", label: "Notifications", icon: Bell },
      { id: "addresses", label: "Addresses", icon: MapPin },
      ...(user.role === "CUSTOMER" ? [{ id: "alerts" as Tab, label: "Stock Alerts", icon: BellRing }] : []),
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

            <div className="mt-4 flex gap-1 border-b border-border" role="tablist" aria-label="Account sections">
              {tabs.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  role="tab"
                  aria-selected={activeTab === t.id}
                  onClick={() => setActiveTab(t.id)}
                  className={cn(
                    "-mb-px flex items-center gap-1.5 border-b-2 px-2.5 py-1.5 text-[13px] font-medium",
                    activeTab === t.id
                      ? "border-primary text-foreground"
                      : "border-transparent text-muted-foreground hover:text-foreground"
                  )}
                >
                  <t.icon className="size-4" aria-hidden />
                  {t.label}
                </button>
              ))}
            </div>

            {activeTab === "profile" && (
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
                  <Link to="/orders" className={cn(buttonVariants({ variant: "outline", size: "sm" }))}>
                    View orders
                  </Link>
                  <Link to="/returns" className={cn(buttonVariants({ variant: "outline", size: "sm" }))}>
                    View returns
                  </Link>
                  <Link to="/price-alerts" className={cn(buttonVariants({ variant: "outline", size: "sm" }))}>
                    View price alerts
                  </Link>
                </div>
              </dl>
            )}

            {activeTab === "preferences" && (
              <div className="mt-4 flex flex-col gap-2" role="tabpanel">
                {prefSavedMsg && (
                  <Alert tone="success">{prefSavedMsg}</Alert>
                )}
                {(
                  [
                    { key: "emailEnabled", label: "Email notifications", hint: "Order receipts and invoices" },
                    { key: "smsEnabled", label: "SMS alerts", hint: "Verification codes and delivery updates" },
                    { key: "pushEnabled", label: "Push notifications", hint: "Live shipment tracking" },
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

            {activeTab === "addresses" && (
              <div className="mt-4" role="tabpanel">
                <AddressBook />
              </div>
            )}

            {activeTab === "alerts" && (
              <div className="mt-4 flex flex-col gap-3" role="tabpanel">
                {alertFeedback && <Alert tone="success">{alertFeedback}</Alert>}
                {isLoadingAlerts ? (
                  <div className="py-6 text-center text-sm text-muted-foreground">Loading stock alerts…</div>
                ) : stockAlerts.length === 0 ? (
                  <div className="rounded-lg border border-dashed border-border p-6 text-center">
                    <BellRing className="mx-auto size-8 text-muted-foreground/60 mb-2" />
                    <p className="text-sm font-medium text-foreground">No stock alerts</p>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      When products are out of stock, click "Notify me when available" to get alerts when restocked.
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
                                sub.status === "ACTIVE"
                                  ? "warning"
                                  : sub.status === "NOTIFIED"
                                  ? "success"
                                  : "outline"
                              }
                              className="text-[10px]"
                            >
                              {sub.status}
                            </Badge>
                          </div>
                          <p className="text-xs text-muted-foreground mt-0.5">
                            Subscribed on {new Date(sub.createdAt).toLocaleDateString()}
                            {sub.notifiedAt && ` • Notified on ${new Date(sub.notifiedAt).toLocaleDateString()}`}
                          </p>
                        </div>
                        {sub.status === "ACTIVE" && (
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={cancellingSubId === sub.id}
                            onClick={() => handleCancelAlert(sub)}
                            data-testid={`cancel-alert-${sub.productId}`}
                          >
                            {cancellingSubId === sub.id ? "Cancelling…" : "Cancel Alert"}
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
    const me = (await login(creds)) as UserContext | undefined;
    if (redirectAfterLogin && me) {
      if (me.role === "MERCHANT") navigate("/merchant");
      else if (me.role === "ADMINISTRATOR") navigate("/admin");
      else navigate("/orders");
    }
  };

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setNeedsVerificationEmail(null);
    setIsSubmitting(true);
    try {
      await doLoginAndRedirect({ email, password });
    } catch (err: unknown) {
      if (isEmailNotVerifiedError(err)) {
        setNeedsVerificationEmail(email);
        setError("This email is not verified yet. Check your inbox, or request a new link below.");
      } else {
        setError(err instanceof Error ? err.message : "Sign in failed. Check your email and password.");
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleSignup = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setIsSubmitting(true);
    try {
      const result = (await register({
        email,
        password,
        tenantName: storeName.trim() || (signupRole === "MERCHANT" ? `${email} store` : `${email}`),
        role: signupRole,
      })) as { email?: string } | undefined;
      if (!result?.email) throw new Error("Could not create account.");
      setPendingVerificationEmail(result.email);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Could not create account.");
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleResend = async (targetEmail: string) => {
    setError("");
    setIsSubmitting(true);
    try {
      await resendVerification(targetEmail);
      setPendingVerificationEmail(targetEmail);
      setNeedsVerificationEmail(null);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Could not resend the link.");
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
              A verification link is on its way to <strong>{pendingVerificationEmail}</strong>.
              Sign in after clicking it. The link expires in 24 hours.
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
          <div className="flex gap-1 rounded-md bg-muted p-1" role="tablist" aria-label="Sign in or create account">
            {(
              [
                { id: "signin", label: "Sign in" },
                { id: "signup", label: "Create account" },
              ] as const
            ).map((m) => (
              <button
                key={m.id}
                type="button"
                role="tab"
                aria-selected={authMode === m.id}
                onClick={() => {
                  setAuthMode(m.id);
                  setError("");
                  setNeedsVerificationEmail(null);
                }}
                className={cn(
                  "flex-1 rounded px-2 py-1.5 text-[13px] font-medium",
                  authMode === m.id ? "bg-background shadow-sm" : "text-muted-foreground"
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

          {authMode === "signin" ? (
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
                <Label htmlFor="login-password">Password</Label>
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
                {isSubmitting ? "Signing in…" : "Sign in"}
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
                    onChange={(e) => setSignupRole(e.target.value as "CUSTOMER" | "MERCHANT")}
                    className="h-8 rounded-md border border-input bg-background px-2.5 text-[13px] outline-none focus-visible:border-ring"
                  >
                    <option value="CUSTOMER">Shop</option>
                    <option value="MERCHANT">Sell</option>
                  </select>
                </div>
                <div className="flex flex-col gap-1">
                  <Label htmlFor="signup-store">
                    {signupRole === "MERCHANT" ? "Store name" : "Display name"}
                  </Label>
                  <Input
                    id="signup-store"
                    placeholder={signupRole === "MERCHANT" ? "e.g. Apex Electronics" : "e.g. Asha Rao"}
                    value={storeName}
                    onChange={(e) => setStoreName(e.target.value)}
                    required
                  />
                </div>
              </div>
              <Button type="submit" disabled={isSubmitting}>
                {isSubmitting ? "Creating account…" : "Create account"}
              </Button>
              <p className="text-center text-xs text-muted-foreground">
                Verification is required before first sign in.
              </p>
            </form>
          )}

          <div className="mt-4 border-t border-border pt-3 text-center">
            <p className="text-xs text-muted-foreground">
              Demo sign in (password: <code className="font-mono">password123</code>)
            </p>
            <div className="mt-2 flex flex-wrap justify-center gap-1.5">
              {(
                [
                  { label: "Customer", email: "customer@example.com" },
                  { label: "Merchant", email: "merchant@example.com" },
                  { label: "Admin", email: "admin@example.com" },
                ] as const
              ).map((d) => (
                <Button
                  key={d.email}
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => doLoginAndRedirect({ email: d.email, password: "password123" })}
                >
                  {d.label}
                </Button>
              ))}
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
};
