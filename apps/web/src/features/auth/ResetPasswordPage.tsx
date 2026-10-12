import { useState } from "react";
import { Link, useSearchParams, useNavigate } from "react-router-dom";
import { CheckCircle2, KeyRound, AlertCircle, ArrowLeft, Lock } from "lucide-react";
import { useAuth } from "./AuthContext";
import { Button, buttonVariants } from "../../components/ui/button";
import { Card, CardContent } from "../../components/ui/card";
import { Alert } from "../../components/ui/alert";
import { Input, Label } from "../../components/ui/input";
import { cn } from "../../lib/utils";

export const ResetPasswordPage = () => {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const { resetPassword } = useAuth();
  const token = params.get("token") ?? "";

  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isSuccess, setIsSuccess] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (password.length < 8) {
      setError("Password must be at least 8 characters long.");
      return;
    }

    if (password !== confirmPassword) {
      setError("Passwords do not match. Please verify and try again.");
      return;
    }

    setIsSubmitting(true);
    try {
      await resetPassword(token, password);
      setIsSuccess(true);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to reset password. The link may have expired.");
    } finally {
      setIsSubmitting(false);
    }
  };

  if (!token) {
    return (
      <div className="mx-auto w-full max-w-md p-4">
        <Card>
          <CardContent className="p-6 text-center space-y-3">
            <div className="mx-auto flex size-12 items-center justify-center rounded-full bg-destructive/10 text-destructive">
              <AlertCircle className="size-6" />
            </div>
            <h1 className="text-xl font-semibold tracking-tight">Invalid Reset Link</h1>
            <p className="text-[13px] text-muted-foreground">
              This password reset link is missing a valid reset token or is incomplete.
            </p>
            <div className="pt-2">
              <Link to="/account" className={cn(buttonVariants({ variant: "outline", size: "sm" }), "w-full")}>
                <ArrowLeft className="mr-1.5 size-4" />
                Back to Sign in
              </Link>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (isSuccess) {
    return (
      <div className="mx-auto w-full max-w-md p-4">
        <Card>
          <CardContent className="p-6 text-center space-y-4">
            <div className="mx-auto flex size-12 items-center justify-center rounded-full bg-emerald-500/10 text-emerald-600">
              <CheckCircle2 className="size-6" />
            </div>
            <div>
              <h1 className="text-xl font-semibold tracking-tight">Password Reset Complete</h1>
              <p className="mt-1 text-[13px] text-muted-foreground">
                Your password has been securely updated. You can now sign in with your new credentials.
              </p>
            </div>
            <div className="pt-2">
              <Button
                className="w-full"
                onClick={() => navigate("/login")}
              >
                Sign in to your account
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
        <CardContent className="p-6 space-y-4">
          <div className="text-center space-y-1">
            <div className="mx-auto flex size-12 items-center justify-center rounded-full bg-primary/10 text-primary mb-2">
              <KeyRound className="size-6" />
            </div>
            <h1 className="text-xl font-semibold tracking-tight">Set New Password</h1>
            <p className="text-[13px] text-muted-foreground">
              Enter and confirm your new password below.
            </p>
          </div>

          {error && (
            <Alert tone="error">
              {error}
            </Alert>
          )}

          <form onSubmit={handleSubmit} className="flex flex-col gap-3.5">
            <div className="flex flex-col gap-1">
              <Label htmlFor="new-password">New Password</Label>
              <Input
                id="new-password"
                type="password"
                placeholder="At least 8 characters"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                minLength={8}
                required
                autoFocus
              />
            </div>

            <div className="flex flex-col gap-1">
              <Label htmlFor="confirm-password">Confirm New Password</Label>
              <Input
                id="confirm-password"
                type="password"
                placeholder="Re-enter your password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                minLength={8}
                required
              />
            </div>

            <Button
              type="submit"
              disabled={isSubmitting || !password || !confirmPassword}
              className="mt-1 w-full"
            >
              {isSubmitting ? (
                "Updating password…"
              ) : (
                <>
                  <Lock className="mr-1.5 size-4" />
                  Reset Password
                </>
              )}
            </Button>
          </form>

          <div className="pt-1 text-center">
            <Link
              to="/account"
              className="inline-flex items-center text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              <ArrowLeft className="mr-1 size-3.5" />
              Cancel and back to sign in
            </Link>
          </div>
        </CardContent>
      </Card>
    </div>
  );
};
