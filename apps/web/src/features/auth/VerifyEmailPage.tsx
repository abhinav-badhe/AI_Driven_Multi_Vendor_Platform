import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { CheckCircle2, MailWarning } from 'lucide-react';
import { useAuth } from './AuthContext';
import { buttonVariants } from '../../components/ui/button';
import { Card, CardContent } from '../../components/ui/card';
import { Alert } from '../../components/ui/alert';
import { Skeleton } from '../../components/ui/empty';
import { cn } from '../../lib/utils';

// One in-flight verification per token, shared across remounts. The first
// mount fires the single POST; every later effect (StrictMode remounts,
// parent re-renders) attaches to the same promise instead of re-POSTing —
// and, crucially, still receives the outcome to update its own state.
const verificationPromises = new Map<string, Promise<void>>();

export const VerifyEmailPage = () => {
  const [params] = useSearchParams();
  const { verifyEmail } = useAuth();
  const [status, setStatus] = useState<'working' | 'done' | 'failed'>('working');
  const [error, setError] = useState<string | null>(null);
  const token = params.get('token') ?? '';

  useEffect(() => {
    // verifyEmail is re-created on every AuthProvider render, so it cannot be
    // a stable effect dep — but re-running is harmless: the shared promise
    // below guarantees exactly one POST per token while every mounted
    // instance still learns the result.
    if (!token) return;
    let promise = verificationPromises.get(token);
    if (!promise) {
      promise = verifyEmail(token);
      verificationPromises.set(token, promise);
    }
    let cancelled = false;
    promise.then(
      () => {
        if (!cancelled) setStatus('done');
      },
      (err: unknown) => {
        if (!cancelled) {
          setStatus('failed');
          setError(err instanceof Error ? err.message : 'Verification failed.');
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [token]);

  if (!token) {
    return (
      <div className="mx-auto w-full max-w-md p-4">
        <Card>
          <CardContent className="p-4 text-center">
            <MailWarning className="mx-auto size-8 text-warning-foreground" aria-hidden />
            <h1 className="mt-2 text-xl font-semibold tracking-tight">Link invalid or expired</h1>
            <div className="mt-2">
              <Alert tone="error">
                This verification link is missing its token. Request a new one from the sign-in
                page.
              </Alert>
            </div>
            <Link
              to="/account"
              className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), 'mt-3')}
            >
              Back to sign in
            </Link>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-md p-4">
      <Card>
        <CardContent className="p-4 text-center">
          {status === 'working' && (
            <div aria-label="Verifying email">
              <Skeleton className="mx-auto h-6 w-40" />
              <p className="mt-2 text-[13px] text-muted-foreground">Verifying your email…</p>
            </div>
          )}
          {status === 'done' && (
            <>
              <CheckCircle2 className="mx-auto size-8 text-success" aria-hidden />
              <h1 className="mt-2 text-xl font-semibold tracking-tight">Email verified</h1>
              <p className="mt-1 text-[13px] text-muted-foreground">
                Your account is active. Sign in to continue.
              </p>
              <Link to="/account" className={cn(buttonVariants({ size: 'sm' }), 'mt-3')}>
                Sign in
              </Link>
            </>
          )}
          {status === 'failed' && (
            <>
              <MailWarning className="mx-auto size-8 text-warning-foreground" aria-hidden />
              <h1 className="mt-2 text-xl font-semibold tracking-tight">Link invalid or expired</h1>
              <div className="mt-2">
                <Alert tone="error">{error ?? 'Verification failed.'}</Alert>
              </div>
              <Link
                to="/account"
                className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), 'mt-3')}
              >
                Back to sign in
              </Link>
              <p className="mt-2 text-xs text-muted-foreground">
                Request a fresh link from the sign-in page.
              </p>
            </>
          )}
        </CardContent>
      </Card>
      <div className="mt-3 text-center">
        <Link to="/" className={cn(buttonVariants({ variant: 'ghost', size: 'sm' }))}>
          Back to storefront
        </Link>
      </div>
    </div>
  );
};
