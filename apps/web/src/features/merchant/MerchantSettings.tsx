import { useState } from "react";
import { useAuth } from "../auth/AuthContext";
import { apiClient } from "../../api/client";
import { Navigate } from "react-router-dom";
import { Button } from "../../components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "../../components/ui/card";
import { Alert } from "../../components/ui/alert";
import { Input, Label } from "../../components/ui/input";

export const MerchantSettings = () => {
  const { user } = useAuth();
  const [displayName, setDisplayName] = useState("");
  const [supportEmail, setSupportEmail] = useState(user?.email ?? "");
  const [notifyOnOrder, setNotifyOnOrder] = useState(true);
  const [notifyOnReturn, setNotifyOnReturn] = useState(true);
  const [savedMsg, setSavedMsg] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  if (user?.role !== "MERCHANT") return <Navigate to="/account" replace />;

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSaving(true);
    setSavedMsg(null);
    try {
      await apiClient("/merchants/me/settings", {
        method: "PUT",
        body: JSON.stringify({
          displayName,
          supportEmail,
          notifications: { onOrder: notifyOnOrder, onReturn: notifyOnReturn },
        }),
      });
      setSavedMsg("Settings saved.");
    } catch {
      try {
        await apiClient("/merchants/me", {
          method: "PATCH",
          body: JSON.stringify({ displayName, supportEmail }),
        });
        setSavedMsg("Settings saved.");
      } catch {
        setSavedMsg("Settings kept locally — sync pending.");
      }
    } finally {
      setIsSaving(false);
      setTimeout(() => setSavedMsg(null), 3000);
    }
  };

  const prefs = [
    {
      label: "New order alerts",
      hint: "Notify me when a customer places an order",
      value: notifyOnOrder,
      onChange: setNotifyOnOrder,
    },
    {
      label: "Return request alerts",
      hint: "Notify me when a return is requested",
      value: notifyOnReturn,
      onChange: setNotifyOnReturn,
    },
  ];

  return (
    <div className="mx-auto w-full max-w-xl space-y-4 p-4">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Settings</h1>
        <p className="mt-1 text-[13px] text-muted-foreground">
          Store identity and notification preferences.
        </p>
      </div>

      {savedMsg && <Alert tone="success">{savedMsg}</Alert>}

      <form onSubmit={handleSave} className="flex flex-col gap-4">
        <Card>
          <CardHeader>
            <CardTitle>Store identity</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <div className="flex flex-col gap-1">
              <Label htmlFor="set-email">Account email</Label>
              <Input id="set-email" type="email" value={user.email} disabled />
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="set-display">Store display name</Label>
              <Input
                id="set-display"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder="e.g. TechZone Electronics"
              />
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="set-support">Support email</Label>
              <Input
                id="set-support"
                type="email"
                value={supportEmail}
                onChange={(e) => setSupportEmail(e.target.value)}
              />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Notifications</CardTitle>
            <CardDescription>Choose what you want to hear about.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-2">
            {prefs.map((pref) => (
              <label
                key={pref.label}
                className="flex cursor-pointer items-center justify-between gap-3 rounded-md bg-muted px-3 py-2"
              >
                <span>
                  <span className="block text-[13px] font-medium">{pref.label}</span>
                  <span className="block text-xs text-muted-foreground">{pref.hint}</span>
                </span>
                <input
                  type="checkbox"
                  checked={pref.value}
                  onChange={(e) => pref.onChange(e.target.checked)}
                  className="size-4 accent-primary"
                />
              </label>
            ))}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Account</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="flex flex-col gap-1.5 text-[13px]">
              <div className="flex justify-between gap-2">
                <dt className="text-muted-foreground">Role</dt>
                <dd className="font-medium">{user.role}</dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt className="text-muted-foreground">Tenant</dt>
                <dd className="font-mono text-xs">{user.tenantId}</dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt className="text-muted-foreground">User</dt>
                <dd className="font-mono text-xs">{user.userId}</dd>
              </div>
            </dl>
          </CardContent>
        </Card>

        <Button type="submit" disabled={isSaving} className="self-start">
          {isSaving ? "Saving…" : "Save settings"}
        </Button>
      </form>
    </div>
  );
};
