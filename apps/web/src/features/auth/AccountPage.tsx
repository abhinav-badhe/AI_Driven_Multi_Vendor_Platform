import { useState, useEffect } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Bell, MapPin, UserRound } from "lucide-react";
import { useAuth, type LoginCredentials, type UserContext } from "./AuthContext";
import { apiClient } from "../../api/client";
import { Button, buttonVariants } from "../../components/ui/button";
import { Card, CardContent } from "../../components/ui/card";
import { Alert } from "../../components/ui/alert";
import { Input, Label } from "../../components/ui/input";
import { cn } from "../../lib/utils";

interface NotificationPrefDto {
  emailEnabled?: boolean;
  smsEnabled?: boolean;
  pushEnabled?: boolean;
}

type Tab = "profile" | "preferences" | "addresses";

export const AccountPage = ({ redirectAfterLogin = false }: { redirectAfterLogin?: boolean } = {}) => {
  const navigate = useNavigate();
  const { isAuthenticated, user, login, logout, isLoading } = useAuth();
  const [activeTab, setActiveTab] = useState<Tab>("profile");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  const [prefs, setPrefs] = useState<NotificationPrefDto>({
    emailEnabled: true,
    smsEnabled: true,
    pushEnabled: true,
  });
  const [prefSavedMsg, setPrefSavedMsg] = useState<string | null>(null);

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
                <div className="mt-1 flex gap-1.5">
                  <Link to="/orders" className={cn(buttonVariants({ variant: "outline", size: "sm" }))}>
                    View orders
                  </Link>
                  <Link to="/returns" className={cn(buttonVariants({ variant: "outline", size: "sm" }))}>
                    View returns
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
              <div className="mt-4 flex flex-col gap-2" role="tabpanel">
                <div className="rounded-md border border-border px-3 py-2">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-[13px] font-semibold">Home</p>
                    <span className="rounded-full bg-secondary px-2 py-0.5 text-xs font-medium">Default</span>
                  </div>
                  <p className="mt-1 text-[13px] text-muted-foreground">
                    B-42, Bandra West, Mumbai, Maharashtra 400050
                  </p>
                </div>
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
    setIsSubmitting(true);
    try {
      await doLoginAndRedirect({ email, password });
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Sign in failed. Check your email and password.");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="mx-auto w-full max-w-md p-4">
      <Card>
        <CardContent className="p-4">
          <h1 className="text-center text-xl font-semibold tracking-tight">Sign in</h1>
          {error && (
            <div className="mt-3">
              <Alert tone="error">{error}</Alert>
            </div>
          )}
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
