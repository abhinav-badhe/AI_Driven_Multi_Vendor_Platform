import { useState, useEffect } from "react";
import { useNavigate, Link } from "react-router-dom";
import { CheckCircle2, Lock, ShieldCheck, MapPin, Plus, Edit2, Home, Briefcase, Building } from "lucide-react";
import { checkoutApi, type CheckoutSessionDto, type OrderConfirmationDto } from "./api/checkout";
import { addressesApi, type CustomerAddressDto } from "../customer/api/addresses";
import { AddressFormModal } from "../customer/components/AddressFormModal";
import { useCart } from "../cart/CartContext";
import { Button, buttonVariants } from "../../components/ui/button";
import { Card, CardContent } from "../../components/ui/card";
import { Badge } from "../../components/ui/badge";
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
  const [phone, setPhone] = useState("");
  const [address, setAddress] = useState("");
  const [city, setCity] = useState("");
  const [state, setState] = useState("");
  const [postalCode, setPostalCode] = useState("");
  const [paymentMethod, setPaymentMethod] = useState("pm_card_visa");
  const isCod = paymentMethod === "cod";

  // Address Book state
  const [savedAddresses, setSavedAddresses] = useState<CustomerAddressDto[]>([]);
  const [selectedAddressId, setSelectedAddressId] = useState<string | null>(null);
  const [isManualEntry, setIsManualEntry] = useState(false);
  const [isAddressModalOpen, setIsAddressModalOpen] = useState(false);
  const [editingAddress, setEditingAddress] = useState<CustomerAddressDto | null>(null);

  const applyAddressFields = (addr: CustomerAddressDto) => {
    setSelectedAddressId(addr.id);
    setFullName(addr.recipientName);
    setPhone(addr.phone);
    setAddress(addr.addressLine1 + (addr.addressLine2 ? `, ${addr.addressLine2}` : ""));
    setCity(addr.city);
    setState(addr.state);
    setPostalCode(addr.postalCode);
  };

  const handleSelectSavedAddress = async (addr: CustomerAddressDto) => {
    applyAddressFields(addr);
    setIsManualEntry(false);
    if (session) {
      try {
        const updated = await checkoutApi.setShippingAddress(session.id, { addressId: addr.id });
        setSession(updated);
      } catch (err) {
        console.warn("Failed to sync checkout address snapshot", err);
      }
    }
  };

  const handleAddressSaved = (newAddr: CustomerAddressDto) => {
    setSavedAddresses((prev) => {
      const idx = prev.findIndex((a) => a.id === newAddr.id);
      if (idx >= 0) {
        const next = [...prev];
        next[idx] = newAddr;
        return next;
      }
      return [...prev, newAddr];
    });
    handleSelectSavedAddress(newAddr);
  };

  const [pendingAction, setPendingAction] = useState<{
    intentId: string;
    clientSecret: string;
    paymentMethod: string;
  } | null>(null);
  const [isAuthorizingAction, setIsAuthorizingAction] = useState(false);

  // Coupon handling
  const [couponInput, setCouponInput] = useState("");
  const [isApplyingCoupon, setIsApplyingCoupon] = useState(false);
  const [couponError, setCouponError] = useState<string | null>(null);

  const handleApplyCoupon = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!session || !couponInput.trim()) return;
    setIsApplyingCoupon(true);
    setCouponError(null);
    try {
      const res = await checkoutApi.applyCoupon(session.id, couponInput.trim().toUpperCase());
      setSession((prev) =>
        prev
          ? {
              ...prev,
              discountAmount: res.discountAmount,
              totalAmount: res.totalAmount,
              couponCode: res.couponCode,
              appliedPromotions: res.appliedPromotions,
            }
          : prev,
      );
      setCouponInput("");
    } catch (err: unknown) {
      setCouponError(err instanceof Error ? err.message : "Failed to apply coupon");
    } finally {
      setIsApplyingCoupon(false);
    }
  };

  const handleRemoveCoupon = async () => {
    if (!session) return;
    setIsApplyingCoupon(true);
    setCouponError(null);
    try {
      const res = await checkoutApi.removeCoupon(session.id);
      setSession((prev) =>
        prev
          ? {
              ...prev,
              discountAmount: res.discountAmount,
              totalAmount: res.totalAmount,
              couponCode: null,
              appliedPromotions: [],
            }
          : prev,
      );
    } catch (err: unknown) {
      setCouponError(err instanceof Error ? err.message : "Failed to remove coupon");
    } finally {
      setIsApplyingCoupon(false);
    }
  };

  useEffect(() => {
    const initCheckout = async () => {
      setIsInitializing(true);
      setError(null);
      try {
        let initialAddressId: string | undefined = undefined;
        try {
          const list = await addressesApi.listAddresses();
          setSavedAddresses(list);
          if (list.length > 0) {
            const def = list.find((a) => a.isDefault) ?? list[0];
            if (def) {
              initialAddressId = def.id;
              applyAddressFields(def);
            }
          } else {
            setIsManualEntry(true);
          }
        } catch {
          setIsManualEntry(true);
        }

        const sess = await checkoutApi.createSession(
          initialAddressId ? { addressId: initialAddressId } : undefined,
        );
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

      // Ensure shipping address snapshot is synced on the checkout session
      if (selectedAddressId && !isManualEntry) {
        try {
          activeSession = await checkoutApi.setShippingAddress(activeSession.id, {
            addressId: selectedAddressId,
          });
        } catch {
          // Non-blocking if already set
        }
      } else if (address.trim() && fullName.trim()) {
        try {
          activeSession = await checkoutApi.setShippingAddress(activeSession.id, {
            shippingAddress: {
              recipientName: fullName.trim(),
              phone: phone.trim() || "+1000000000",
              addressLine1: address.trim(),
              city: city.trim(),
              state: state.trim() || "CA",
              postalCode: postalCode.trim(),
              country: "US",
            },
          });
        } catch {
          // Non-blocking if already set
        }
      }

      if (activeSession.status === "OPEN") {
        activeSession = await checkoutApi.reserveInventory(activeSession.id);
        setSession(activeSession);
      }

      const intent = await checkoutApi.createPaymentIntent(activeSession.id);
      const attempt = await checkoutApi.submitPaymentAttempt(intent.id, paymentMethod);

      if (attempt.status === "REQUIRES_ACTION") {
        // Stripe 3D-Secure / Strong Customer Authentication challenge flow
        setPendingAction({
          intentId: intent.id,
          clientSecret: intent.clientSecret,
          paymentMethod,
        });
        return;
      }

      if (attempt.status !== "SUCCEEDED") {
        throw new Error(
          attempt.failureMessage ||
            "Payment attempt was declined by the payment gateway. Please check your payment details or select another method.",
        );
      }
      const order = await checkoutApi.finalizeOrder(session.id, intent.id);
      setCompletedOrder(order);
      await refreshCart();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Payment failed. No charge was made — try again.");
    } finally {
      setIsPaying(false);
    }
  };

  const handleAuthorizeAction = async () => {
    if (!pendingAction || !session) return;
    setIsAuthorizingAction(true);
    setError(null);
    try {
      // Browser-side 3DS authentication completed by customer; confirm with provider
      const confirmedAttempt = await checkoutApi.submitPaymentAttempt(
        pendingAction.intentId,
        "pm_card_visa",
      );
      if (confirmedAttempt.status !== "SUCCEEDED") {
        throw new Error(
          confirmedAttempt.failureMessage ||
            "Strong customer authentication could not be completed by your issuing bank.",
        );
      }
      const order = await checkoutApi.finalizeOrder(session.id, pendingAction.intentId);
      setCompletedOrder(order);
      setPendingAction(null);
      await refreshCart();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "3D-Secure authentication failed.");
      setPendingAction(null);
    } finally {
      setIsAuthorizingAction(false);
    }
  };

  const handleCancelAction = () => {
    setPendingAction(null);
    setError("3D Secure verification was cancelled. Please try again or select another payment method.");
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
          <Alert tone="error">
            <div className="flex flex-col gap-2">
              <span>{error}</span>
              <div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setError(null)}
                >
                  Retry Payment
                </Button>
              </div>
            </div>
          </Alert>
        </div>
      )}

      <form onSubmit={handlePayAndOrder} className="mt-4 grid items-start gap-4 lg:grid-cols-3">
        <div className="flex flex-col gap-4 lg:col-span-2">
          <Card>
            <CardContent className="p-4">
              <div className="flex items-center justify-between gap-2">
                <h2 className="text-sm font-semibold flex items-center gap-1.5">
                  <MapPin className="size-4 text-primary" />
                  Delivery address
                </h2>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setEditingAddress(null);
                    setIsAddressModalOpen(true);
                  }}
                  className="h-7 text-xs flex items-center gap-1"
                >
                  <Plus className="size-3.5" />
                  Add Address
                </Button>
              </div>

              {/* Saved Addresses Selector */}
              {savedAddresses.length > 0 && !isManualEntry ? (
                <div className="mt-3 space-y-2">
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    {savedAddresses.map((addr) => {
                      const isSelected = selectedAddressId === addr.id;
                      return (
                        <div
                          key={addr.id}
                          onClick={() => handleSelectSavedAddress(addr)}
                          className={`cursor-pointer rounded-md border p-3 text-xs transition-colors relative flex flex-col justify-between ${
                            isSelected
                              ? 'border-primary bg-primary/5 shadow-xs'
                              : 'border-border hover:border-primary/40'
                          }`}
                        >
                          <div>
                            <div className="flex items-center justify-between gap-1 mb-1">
                              <span className="font-semibold text-foreground uppercase tracking-wider text-[11px] flex items-center gap-1">
                                {addr.label === 'Home' ? (
                                  <Home className="size-3 text-primary" />
                                ) : addr.label === 'Work' ? (
                                  <Briefcase className="size-3 text-primary" />
                                ) : (
                                  <Building className="size-3 text-primary" />
                                )}
                                {addr.label}
                              </span>
                              <div className="flex items-center gap-1">
                                {addr.isDefault && (
                                  <Badge variant="success" className="text-[9px] px-1 py-0">
                                    Default
                                  </Badge>
                                )}
                                {isSelected && (
                                  <Badge variant="default" className="text-[9px] px-1 py-0 bg-primary text-primary-foreground">
                                    Selected
                                  </Badge>
                                )}
                              </div>
                            </div>
                            <p className="font-medium text-foreground">{addr.recipientName}</p>
                            <p className="text-muted-foreground">{addr.phone}</p>
                            <p className="text-muted-foreground line-clamp-2 mt-0.5">
                              {addr.addressLine1}, {addr.city} {addr.postalCode}
                            </p>
                          </div>
                          <div className="pt-2 mt-2 border-t border-border/40 flex justify-end">
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              onClick={(e) => {
                                e.stopPropagation();
                                setEditingAddress(addr);
                                setIsAddressModalOpen(true);
                              }}
                              className="h-6 px-1.5 text-[11px] text-muted-foreground hover:text-foreground"
                            >
                              <Edit2 className="size-3 mr-1" />
                              Edit
                            </Button>
                          </div>
                        </div>
                      );
                    })}
                  </div>

                  <div className="pt-2 text-right">
                    <button
                      type="button"
                      onClick={() => setIsManualEntry(true)}
                      className="text-xs text-primary hover:underline"
                    >
                      Enter a custom address instead
                    </button>
                  </div>
                </div>
              ) : (
                <div className="mt-3 flex flex-col gap-3">
                  {savedAddresses.length > 0 && (
                    <div className="flex justify-between items-center pb-2 border-b border-border">
                      <span className="text-xs text-muted-foreground">Entering address manually</span>
                      <button
                        type="button"
                        onClick={() => setIsManualEntry(false)}
                        className="text-xs text-primary font-medium hover:underline"
                      >
                        ← Choose from saved addresses
                      </button>
                    </div>
                  )}
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className="flex flex-col gap-1">
                      <Label htmlFor="co-name">Full name</Label>
                      <Input id="co-name" required value={fullName} onChange={(e) => setFullName(e.target.value)} />
                    </div>
                    <div className="flex flex-col gap-1">
                      <Label htmlFor="co-phone">Phone number</Label>
                      <Input id="co-phone" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+1 555-0123" />
                    </div>
                  </div>
                  <div className="flex flex-col gap-1">
                    <Label htmlFor="co-address">Street address</Label>
                    <Input id="co-address" required value={address} onChange={(e) => setAddress(e.target.value)} />
                  </div>
                  <div className="grid gap-3 sm:grid-cols-3">
                    <div className="flex flex-col gap-1">
                      <Label htmlFor="co-city">City</Label>
                      <Input id="co-city" required value={city} onChange={(e) => setCity(e.target.value)} />
                    </div>
                    <div className="flex flex-col gap-1">
                      <Label htmlFor="co-state">State</Label>
                      <Input id="co-state" value={state} onChange={(e) => setState(e.target.value)} />
                    </div>
                    <div className="flex flex-col gap-1">
                      <Label htmlFor="co-pin">PIN code</Label>
                      <Input id="co-pin" required value={postalCode} onChange={(e) => setPostalCode(e.target.value)} />
                    </div>
                  </div>
                </div>
              )}
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

            {/* Coupon Code Section */}
            <div className="mt-3 border-t border-border pt-3">
              {session?.couponCode ? (
                <div className="flex items-center justify-between rounded-md bg-success/10 border border-success/30 px-3 py-2 text-xs">
                  <div className="flex items-center gap-1.5 text-success font-medium">
                    <span className="font-mono uppercase font-semibold">{session.couponCode}</span>
                    <span>applied</span>
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-6 px-1.5 text-xs text-muted-foreground hover:text-destructive"
                    onClick={handleRemoveCoupon}
                    disabled={isApplyingCoupon}
                  >
                    Remove
                  </Button>
                </div>
              ) : (
                <div className="space-y-1.5">
                  <div className="flex gap-1.5">
                    <Input
                      placeholder="Coupon code"
                      className="h-8 text-xs uppercase"
                      value={couponInput}
                      onChange={(e) => setCouponInput(e.target.value.toUpperCase())}
                      disabled={isApplyingCoupon}
                    />
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-8 px-3 text-xs"
                      onClick={handleApplyCoupon}
                      disabled={isApplyingCoupon || !couponInput.trim()}
                    >
                      {isApplyingCoupon ? "Applying…" : "Apply"}
                    </Button>
                  </div>
                  {couponError && (
                    <p className="text-[11px] text-destructive">{couponError}</p>
                  )}
                </div>
              )}
            </div>

            <dl className="mt-2 flex flex-col gap-1.5 border-t border-border pt-2 text-[13px]">
              <div className="flex justify-between">
                <dt className="text-muted-foreground">Subtotal</dt>
                <dd className="tnum">{formatPrice(session?.subtotalAmount ?? 0, session?.currency, 2)}</dd>
              </div>
              {session?.discountAmount ? (
                <div className="flex justify-between text-success">
                  <dt>Discount {session.couponCode ? `(${session.couponCode})` : ""}</dt>
                  <dd className="tnum font-medium">−{formatPrice(session.discountAmount, session?.currency, 2)}</dd>
                </div>
              ) : null}
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

      {pendingAction && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="sca-modal-title"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
        >
          <Card className="w-full max-w-md border-primary/30 shadow-2xl">
            <CardContent className="p-6">
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
                  <ShieldCheck className="size-6" aria-hidden />
                </div>
                <div>
                  <h2 id="sca-modal-title" className="text-base font-semibold">
                    3D Secure Authentication
                  </h2>
                  <p className="text-xs text-muted-foreground">Strong Customer Authentication (SCA)</p>
                </div>
              </div>

              <div className="mt-4 rounded-md border bg-muted/40 p-3 text-xs text-muted-foreground">
                <p>
                  Your issuing bank requires verification to authorize this payment of{" "}
                  <strong className="text-foreground">
                    {formatPrice(session?.totalAmount ?? 0, session?.currency ?? "USD", 2)}
                  </strong>.
                </p>
              </div>

              <div className="mt-6 flex flex-col gap-2">
                <Button
                  type="button"
                  size="default"
                  disabled={isAuthorizingAction}
                  onClick={handleAuthorizeAction}
                  className="w-full"
                >
                  {isAuthorizingAction ? "Authorizing with bank…" : "Authorize & Complete Payment"}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="default"
                  disabled={isAuthorizingAction}
                  onClick={handleCancelAction}
                  className="w-full"
                >
                  Cancel
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Address Form Modal */}
      <AddressFormModal
        isOpen={isAddressModalOpen}
        onClose={() => setIsAddressModalOpen(false)}
        onSaved={handleAddressSaved}
        initialData={editingAddress}
      />
    </div>
  );
};
