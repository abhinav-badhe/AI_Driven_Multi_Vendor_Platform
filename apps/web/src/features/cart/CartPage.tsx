import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Heart, ImageOff, Lock, ShoppingCart, Trash2 } from "lucide-react";
import { useCart } from "./CartContext";
import { useAuth } from "../auth/AuthContext";
import { wishlistApi } from "../customer/api/wishlist";
import { Button, buttonVariants } from "../../components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "../../components/ui/card";
import { Badge } from "../../components/ui/badge";
import { Alert } from "../../components/ui/alert";
import { EmptyState, TableSkeleton } from "../../components/ui/empty";
import { QtyControl } from "../../components/product/ProductCard";
import { formatPrice } from "../../lib/format";
import { cn } from "../../lib/utils";

export const CartPage = () => {
  const { cart, updateQuantity, removeItem, refreshCart, isLoading } = useCart();
  const { isAuthenticated, login } = useAuth();
  const navigate = useNavigate();
  const [updatingId, setUpdatingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  const handleSaveForLater = async (itemId: string) => {
    setUpdatingId(itemId);
    setError(null);
    try {
      await wishlistApi.saveForLater(itemId);
      await refreshCart();
      setSuccessMsg("Item saved to your wishlist.");
      setTimeout(() => setSuccessMsg(null), 3000);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to save item for later");
    } finally {
      setUpdatingId(null);
    }
  };

  const handleUpdate = async (itemId: string, newQty: number) => {
    if (newQty <= 0) {
      handleRemove(itemId);
      return;
    }
    setUpdatingId(itemId);
    setError(null);
    try {
      await updateQuantity(itemId, newQty);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to update quantity");
    } finally {
      setUpdatingId(null);
    }
  };

  const handleRemove = async (itemId: string) => {
    setUpdatingId(itemId);
    setError(null);
    try {
      await removeItem(itemId);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to remove item");
    } finally {
      setUpdatingId(null);
    }
  };

  if (!isAuthenticated) {
    return (
      <div className="mx-auto w-full max-w-xl p-4">
        <Card>
          <CardHeader>
            <CardTitle>Your Shopping Cart</CardTitle>
            <CardDescription>Please log in to view your saved cart items and complete checkout.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-2.5">
            <Button
              size="sm"
              onClick={() => login({ email: "customer@example.com", password: "password123" })}
            >
              Sign in as Demo Customer
            </Button>
            <Link to="/account" className={cn(buttonVariants({ variant: "outline", size: "sm" }))}>
              Sign in with Other Account
            </Link>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (isLoading && !cart) {
    return (
      <div className="mx-auto w-full max-w-6xl p-4" aria-label="Loading cart">
        <TableSkeleton rows={3} />
      </div>
    );
  }

  if (!cart || !cart.items || cart.items.length === 0) {
    return (
      <div className="mx-auto w-full max-w-xl p-4">
        <EmptyState
          icon={ShoppingCart}
          title="Your cart is empty"
          description="You have not added any items yet. Browse the catalog to get started."
          actionLabel="Browse products"
          onAction={() => navigate("/")}
        />
      </div>
    );
  }

  const itemCount = cart.items.reduce((s, it) => s + it.quantity, 0);

  return (
    <div className="mx-auto w-full max-w-6xl p-4">
      <h1 className="text-xl font-semibold tracking-tight">
        Cart ({itemCount} {itemCount === 1 ? "item" : "items"})
      </h1>

      {successMsg && (
        <div className="mt-3">
          <Alert tone="success" title="Cart updated">
            {successMsg}
          </Alert>
        </div>
      )}

      {error && (
        <div className="mt-3">
          <Alert tone="error" title="Cart update failed">
            {error}
          </Alert>
        </div>
      )}

      {/* Asymmetric split: items take the room, summary is a narrow rail */}
      <div className="mt-4 grid items-start gap-4 lg:grid-cols-3">
        <div className="flex flex-col gap-3 lg:col-span-2">
          {cart.items.map((item) => (
            <Card key={item.id}>
              <CardContent className="flex items-center gap-3 p-4">
                {item.productThumbnailUrl ? (
                  <img
                    src={item.productThumbnailUrl}
                    alt=""
                    loading="lazy"
                    className="size-16 shrink-0 rounded-md border border-border object-cover"
                  />
                ) : (
                  <span className="flex size-16 shrink-0 items-center justify-center rounded-md border border-border bg-muted">
                    <ImageOff className="size-5 text-muted-foreground" aria-hidden />
                  </span>
                )}
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">
                    {item.productTitle || `Offer ${item.listingId.slice(0, 8)}`}
                  </p>
                  <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
                    {item.productBrand && <span>{item.productBrand}</span>}
                    <span className="tnum">
                      {formatPrice(item.unitPriceAmount, item.currency, 2)} each
                    </span>
                    {!item.isAvailable && <Badge variant="destructive">Unavailable</Badge>}
                  </p>
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <QtyControl
                      small
                      quantity={item.quantity}
                      disabled={updatingId === item.id}
                      onDecrease={() => handleUpdate(item.id, item.quantity - 1)}
                      onIncrease={() => handleUpdate(item.id, item.quantity + 1)}
                    />
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={updatingId === item.id}
                      onClick={() => handleSaveForLater(item.id)}
                      className="text-muted-foreground hover:text-foreground"
                    >
                      <Heart aria-hidden className="size-4" />
                      Save for later
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={updatingId === item.id}
                      onClick={() => handleRemove(item.id)}
                      className="text-destructive hover:text-destructive"
                    >
                      <Trash2 aria-hidden />
                      Remove
                    </Button>
                  </div>
                </div>
                <p className="tnum shrink-0 text-base font-semibold">
                  {formatPrice(item.lineTotalAmount, item.currency, 2)}
                </p>
              </CardContent>
            </Card>
          ))}
        </div>

        <Card>
          <CardContent className="p-4">
            <p className="text-sm font-semibold">Order summary</p>
            <dl className="mt-2 flex flex-col gap-1.5 text-[13px]">
              <div className="flex justify-between">
                <dt className="text-muted-foreground">Subtotal</dt>
                <dd className="tnum">{formatPrice(cart.subtotalAmount, cart.currency || "INR", 2)}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-muted-foreground">Delivery</dt>
                <dd className="text-success">Free</dd>
              </div>
              <div className="flex justify-between border-t border-border pt-1.5 text-sm font-semibold">
                <dt>Total</dt>
                <dd className="tnum">{formatPrice(cart.subtotalAmount, cart.currency || "INR", 2)}</dd>
              </div>
            </dl>
            <Button className="mt-3 w-full" onClick={() => navigate("/checkout")}>
              Proceed to checkout
            </Button>
            <p className="mt-2 flex items-start gap-1.5 text-xs text-muted-foreground">
              <Lock className="mt-0.5 size-3.5 shrink-0" aria-hidden />
              Inventory is reserved for 15 minutes once checkout starts.
            </p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
};
