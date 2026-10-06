import { useState, useEffect } from "react";
import { useNavigate, Link } from "react-router-dom";
import { CheckCircle2, Lock, ShieldCheck } from "lucide-react";
import { checkoutApi, type CheckoutSessionDto, type OrderConfirmationDto } from "./api/checkout";
import { useCart } from "../cart/CartContext";
import { Button, buttonVariants } from "../../components/ui/button";
import { Card, CardContent } from "../../components/ui/card";
import { Alert } from "../../components/ui/alert";
import { EmptyState, Skeleton } from "../../components/ui/empty";
import { Input, Label } from "../../components/ui/input";
import { formatPrice } from "../../lib/format";
import { cn } from "../../lib/utils";

export const CheckoutPage = () => {
  const navigate = useNavigate();
  const { refreshCart } = useCart();
  const [session, setSession] = useState<CheckoutSessionDto | null>(null);
  const [isInitializing, setIsInitializing] = useState(true);
  const [isReserving, setIsReserving] = useState(false);
  const [isPaying, setIsPaying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [completedOrder, setCompletedOrder] = useState<OrderConfirmationDto | null>(null);

  const [fullName, setFullName] = useState("");
  const [address, setAddress] = useState("");
  const [city, setCity] = useState("");
  const [postalCode, setPostalCode] = useState("");
  const [paymentMethod, setPaymentMethod] = useState("pm_card_visa");
  const isCod = paymentMethod === "cod";

  useEffect(() => {
    const initCheckout = async () => {
      setIsInitializing(true);
      setError(null);
      try {
        const sess = await checkoutApi.createSession();
        setSession(sess);
        setIsReserving(true);
        const reserved = await checkoutApi.reserveInventory(sess.id);
        setSession(reserved);
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : "Could not start checkout. Return to your cart and try again.");
      } finally {
        setIsInitializing(false);
        setIsReserving(false);
      }
    };
    initCheckout();
  }, []);

  const handlePayAndOrder = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!session) return;
    setIsPaying(true);
    setError(null);
    try {
      let activeSession = session;
      if (activeSession.status === "OPEN") {
        activeSession = await checkoutApi.reserveInventory(activeSession.id);
        setSession(activeSession);
      }

      const intent = await checkoutApi.createPaymentIntent(activeSession.id);
      await checkoutApi.submitPaymentAttempt(intent.id, paymentMethod);
      const order = await checkoutApi.finalizeOrder(session.id, intent.id);
      setCompletedOrder(order);
      await refreshCart();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Payment failed. No charge was made — try again.");
    } finally {
      setIsPaying(false);
    }
  };

  if (isInitializing) {
    return (
      <div className="mx-auto w-full max-w-6xl space-y-3 p-4" aria-label="Loading checkout">
        <Skeleton className="h-6 w-48" />
        <div className="grid gap-4 lg:grid-cols-3">
          <Skeleton className="h-64 lg:col-span-2" />
          <Skeleton className="h-64" />
        </div>
      </div>
    );
  }

  if (completedOrder) {
    return (
      <div className="mx-auto w-full max-w-xl p-4">
        <Card>
          <CardContent className="p-4 text-center">
            <CheckCircle2 className="mx-auto size-8 text-success" aria-hidden />
            <h1 className="mt-2 text-xl font-semibold tracking-tight">Order confirmed</h1>
            <p className="mt-1 text-[13px] text-muted-foreground">
              {isCod
                ? "Pay in cash when your order arrives. The seller has been notified."
                : "Payment received. The seller has been notified."}
            </p>
            <dl className="mt-3 rounded-md bg-muted px-3 py-2 text-left text-[13px]">
              <div className="flex justify-between gap-2">
                <dt className="text-muted-foreground">Order</dt>
                <dd className="font-medium">{completedOrder.orderNumber}</dd>
              </div>
              <div className="mt-1 flex justify-between gap-2">
                <dt className="text-muted-foreground">Total</dt>
                <dd className="tnum font-semibold">
                  {formatPrice(completedOrder.totalAmount, completedOrder.currency, 2)}
                </dd>
              </div>
              <div className="mt-1 flex justify-between gap-2">
                <dt className="text-muted-foreground">Status</dt>
                <dd>{completedOrder.status}</dd>
              </div>
            </dl>
            <div className="mt-3 flex justify-center gap-1.5">
              <Link to="/orders" className={cn(buttonVariants({ size: "sm" }))}>
                View my orders
              </Link>
              <Link to="/search" className={cn(buttonVariants({ variant: "outline", size: "sm" }))}>
                Continue shopping
              </Link>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (error && !session) {
    return (
      <div className="mx-auto w-full max-w-xl p-4">
        <EmptyState
          icon={Lock}
          title="Checkout unavailable"
          description={error}
          actionLabel="Return to cart"
          onAction={() => navigate("/cart")}
        />
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-6xl p-4">
      <h1 className="text-xl font-semibold tracking-tight">Checkout</h1>

      <Alert tone="success" title="Inventory reserved" className="mt-3">
        <span className="flex items-center gap-1.5">
          <ShieldCheck className="size-4 shrink-0" aria-hidden />
          Items are held for this session while you complete payment.
        </span>
      </Alert>

      {error && (
        <div className="mt-3">
          <Alert tone="error">{error}</Alert>
        </div>
      )}

      <form onSubmit={handlePayAndOrder} className="mt-4 grid items-start gap-4 lg:grid-cols-3">
        <div className="flex flex-col gap-4 lg:col-span-2">
          <Card>
            <CardContent className="p-4">
              <h2 className="text-sm font-semibold">Delivery address</h2>
              <div className="mt-2 flex flex-col gap-3">
                <div className="flex flex-col gap-1">
                  <Label htmlFor="co-name">Full name</Label>
                  <Input id="co-name" required value={fullName} onChange={(e) => setFullName(e.target.value)} />
                </div>
                <div className="flex flex-col gap-1">
                  <Label htmlFor="co-address">Street address</Label>
                  <Input id="co-address" required value={address} onChange={(e) => setAddress(e.target.value)} />
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="flex flex-col gap-1">
                    <Label htmlFor="co-city">City</Label>
                    <Input id="co-city" required value={city} onChange={(e) => setCity(e.target.value)} />
                  </div>
                  <div className="flex flex-col gap-1">
                    <Label htmlFor="co-pin">PIN code</Label>
                    <Input id="co-pin" required value={postalCode} onChange={(e) => setPostalCode(e.target.value)} />
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-4">
              <h2 className="text-sm font-semibold">Payment method</h2>
              <div className="mt-2 flex flex-col gap-2">
                {(
                  [
                    { value: "pm_card_visa", label: "Credit / debit card (Visa / Mastercard)" },
                    { value: "pm_upi", label: "UPI (Google Pay / PhonePe / Paytm)" },
                    { value: "cod", label: "Cash on delivery (pay when your order arrives)" },
                  ] as const
                ).map((opt) => (
                  <label
                    key={opt.value}
                    className="flex cursor-pointer items-center gap-2 rounded-md border border-border px-3 py-2 text-[13px]"
                  >
                    <input
                      type="radio"
                      name="paymentMethod"
                      value={opt.value}
                      checked={paymentMethod === opt.value}
                      onChange={(e) => setPaymentMethod(e.target.value)}
                      className="size-4 accent-primary"
                    />
                    {opt.label}
                  </label>
                ))}
              </div>
            </CardContent>
          </Card>
        </div>

        <Card>
          <CardContent className="p-4">
            <p className="text-sm font-semibold">Order summary</p>
            <ul className="mt-2 flex flex-col gap-2">
              {session?.items.map((it) => (
                <li key={it.id} className="flex items-center gap-2 text-[13px]">
                  {it.productThumbnailUrl ? (
                    <img
                      src={it.productThumbnailUrl}
                      alt=""
                      loading="lazy"
                      className="size-9 shrink-0 rounded border border-border object-cover"
                    />
                  ) : (
                    <span className="size-9 shrink-0 rounded border border-border bg-muted" aria-hidden />
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">
                      {it.productTitle || `Offer ${it.listingId.slice(0, 8)}`}
                    </span>
                    <span className="tnum block text-xs text-muted-foreground">
                      × {it.quantity}
                      {it.productBrand ? ` · ${it.productBrand}` : ""}
                    </span>
                  </span>
                  <span className="tnum shrink-0 font-medium">{formatPrice(it.lineTotalAmount, it.currency, 2)}</span>
                </li>
              ))}
            </ul>
            <dl className="mt-2 flex flex-col gap-1.5 border-t border-border pt-2 text-[13px]">
              <div className="flex justify-between">
                <dt className="text-muted-foreground">Subtotal</dt>
                <dd className="tnum">{formatPrice(session?.subtotalAmount ?? 0, session?.currency, 2)}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-muted-foreground">Delivery</dt>
                <dd className="text-success">Free</dd>
              </div>
              <div className="flex justify-between border-t border-border pt-1.5 text-sm font-semibold">
                <dt>Total</dt>
                <dd className="tnum">{formatPrice(session?.totalAmount ?? 0, session?.currency, 2)}</dd>
              </div>
            </dl>
            <Button type="submit" className="mt-3 w-full" disabled={isPaying || isReserving}>
              {isPaying
                ? "Processing payment…"
                : isCod
                  ? `Place order · pay ${formatPrice(session?.totalAmount ?? 0, session?.currency, 2)} on delivery`
                  : `Pay ${formatPrice(session?.totalAmount ?? 0, session?.currency, 2)}`}
            </Button>
          </CardContent>
        </Card>
      </form>
    </div>
  );
};
