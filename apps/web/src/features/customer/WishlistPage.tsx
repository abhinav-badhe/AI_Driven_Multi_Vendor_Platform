import { useState, useEffect } from "react";
import { Link } from "react-router-dom";
import { Heart, ShoppingCart, Trash2, ImageOff, CheckCircle2, Bell } from "lucide-react";
import { wishlistApi, type WishlistItem } from "./api/wishlist";
import { backInStockApi } from "./api/back-in-stock";
import { useCart } from "../cart/CartContext";
import { useAuth } from "../auth/AuthContext";
import { Button, buttonVariants } from "../../components/ui/button";
import { Card, CardContent } from "../../components/ui/card";
import { Badge } from "../../components/ui/badge";
import { Alert } from "../../components/ui/alert";
import { EmptyState, TableSkeleton } from "../../components/ui/empty";
import { Rating } from "../../components/product/display";
import { formatPrice } from "../../lib/format";
import { cn } from "../../lib/utils";

export const WishlistPage = () => {
  const { refreshCart } = useCart();
  const { isAuthenticated, login } = useAuth();
  const [items, setItems] = useState<WishlistItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [movingProductId, setMovingProductId] = useState<string | null>(null);
  const [removingProductId, setRemovingProductId] = useState<string | null>(null);
  const [subscribedStockProductIds, setSubscribedStockProductIds] = useState<Set<string>>(new Set());
  const [alertingProductId, setAlertingProductId] = useState<string | null>(null);

  const fetchWishlist = async () => {
    setIsLoading(true);
    setError(null);
    try {
      const [data, subs] = await Promise.all([
        wishlistApi.getWishlist(),
        backInStockApi.getSubscriptions().catch(() => []),
      ]);
      setItems(Array.isArray(data) ? data : []);
      const activeIds = new Set(
        subs.filter((s) => s.status === 'ACTIVE').map((s) => s.productId),
      );
      setSubscribedStockProductIds(activeIds);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to load wishlist");
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    if (isAuthenticated) {
      fetchWishlist();
    } else {
      setIsLoading(false);
    }
  }, [isAuthenticated]);

  const handleToggleStockAlert = async (item: WishlistItem) => {
    setAlertingProductId(item.productId);
    setError(null);
    const isSubbed = subscribedStockProductIds.has(item.productId);
    try {
      if (isSubbed) {
        await backInStockApi.cancelSubscription(item.productId);
        setSubscribedStockProductIds((prev) => {
          const next = new Set(prev);
          next.delete(item.productId);
          return next;
        });
        setFeedback(`Stock alert cancelled for "${item.product.title}".`);
      } else {
        await backInStockApi.subscribe(item.productId, item.skuId ?? undefined);
        setSubscribedStockProductIds((prev) => new Set(prev).add(item.productId));
        setFeedback(`You'll be notified when "${item.product.title}" is back in stock.`);
      }
      setTimeout(() => setFeedback(null), 4000);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to update stock alert");
    } finally {
      setAlertingProductId(null);
    }
  };

  const handleMoveToCart = async (item: WishlistItem) => {
    setMovingProductId(item.productId);
    setError(null);
    setFeedback(null);
    try {
      await wishlistApi.moveToCart(item.productId, item.offer?.listingId);
      await refreshCart();
      setItems((prev) => prev.filter((it) => it.productId !== item.productId));
      setFeedback(`"${item.product.title}" moved to your shopping cart.`);
      setTimeout(() => setFeedback(null), 4000);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to move item to cart");
    } finally {
      setMovingProductId(null);
    }
  };

  const handleRemove = async (item: WishlistItem) => {
    setRemovingProductId(item.productId);
    setError(null);
    try {
      await wishlistApi.removeFromWishlist(item.productId);
      setItems((prev) => prev.filter((it) => it.productId !== item.productId));
      setFeedback(`"${item.product.title}" removed from your wishlist.`);
      setTimeout(() => setFeedback(null), 3000);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to remove item from wishlist");
    } finally {
      setRemovingProductId(null);
    }
  };

  if (!isAuthenticated) {
    return (
      <div className="mx-auto w-full max-w-xl p-4">
        <Card>
          <CardContent className="p-6">
            <div className="flex flex-col items-center text-center">
              <span className="flex size-12 items-center justify-center rounded-full bg-primary/10 text-primary">
                <Heart className="size-6" />
              </span>
              <h1 className="mt-3 text-lg font-semibold tracking-tight">Your Wishlist</h1>
              <p className="mt-1 text-sm text-muted-foreground">
                Sign in to view items saved for later and sync across your devices.
              </p>
              <div className="mt-4 flex flex-wrap justify-center gap-2">
                <Link to="/account" className={cn(buttonVariants({ size: "sm" }))}>
                  Sign in
                </Link>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => login({ email: "customer@example.com", password: "password123" })}
                >
                  Demo customer sign in
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="mx-auto w-full max-w-4xl p-4" aria-label="Loading wishlist">
        <div className="mb-4 h-6 w-36 animate-pulse rounded bg-muted" />
        <TableSkeleton rows={4} />
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-4xl p-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">
            My Wishlist ({items.length} {items.length === 1 ? "item" : "items"})
          </h1>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Items saved for later. Move to cart anytime.
          </p>
        </div>
        <Link to="/cart" className={cn(buttonVariants({ variant: "outline", size: "sm" }))}>
          <ShoppingCart className="size-4" />
          View Cart
        </Link>
      </div>

      {feedback && (
        <div className="mt-3">
          <Alert tone="success" title="Success">
            <div className="flex items-center gap-2">
              <CheckCircle2 className="size-4 shrink-0 text-success" />
              <span>{feedback}</span>
            </div>
          </Alert>
        </div>
      )}

      {error && (
        <div className="mt-3">
          <Alert tone="error" title="Wishlist operation failed">
            {error}
          </Alert>
        </div>
      )}

      {items.length === 0 ? (
        <div className="mt-6">
          <EmptyState
            icon={Heart}
            title="Your wishlist is empty"
            description="Explore our catalog and click 'Save to Wishlist' on products you want to keep an eye on."
            actionLabel="Browse products"
            onAction={() => window.location.assign("/")}
          />
        </div>
      ) : (
        <div className="mt-4 flex flex-col gap-3">
          {items.map((item) => {
            const isMoving = movingProductId === item.productId;
            const isRemoving = removingProductId === item.productId;
            const canAddToCart = item.availability.isAvailable && item.offer != null;

            return (
              <Card key={item.id} className="overflow-hidden">
                <CardContent className="flex flex-col gap-4 p-4 sm:flex-row sm:items-center sm:justify-between">
                  <div className="flex min-w-0 flex-1 items-start gap-3">
                    {item.product.thumbnailUrl ? (
                      <Link to={`/product/${item.productId}`} className="shrink-0">
                        <img
                          src={item.product.thumbnailUrl}
                          alt=""
                          loading="lazy"
                          className="size-20 rounded-md border border-border object-cover"
                        />
                      </Link>
                    ) : (
                      <span className="flex size-20 shrink-0 items-center justify-center rounded-md border border-border bg-muted">
                        <ImageOff className="size-6 text-muted-foreground" aria-hidden />
                      </span>
                    )}

                    <div className="min-w-0 flex-1">
                      <Link
                        to={`/product/${item.productId}`}
                        className="line-clamp-2 text-sm font-medium leading-snug hover:underline"
                      >
                        {item.product.title}
                      </Link>

                      <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                        {item.product.brand && <span>{item.product.brand}</span>}
                        {item.product.rating != null && (
                          <Rating
                            rating={item.product.rating}
                            reviewCount={item.product.reviewCount}
                          />
                        )}
                        {item.sku && (
                          <span className="rounded bg-muted px-1.5 py-0.5 text-[11px] font-mono">
                            {item.sku.skuCode}
                          </span>
                        )}
                      </div>

                      <div className="mt-2 flex flex-wrap items-center gap-2">
                        {item.offer ? (
                          <div className="flex items-baseline gap-1.5">
                            <span className="tnum text-base font-semibold">
                              {formatPrice(item.offer.priceAmount, item.offer.currency, 2)}
                            </span>
                            {item.offer.compareAtPrice && (
                              <span className="tnum text-xs text-muted-foreground line-through">
                                {formatPrice(item.offer.compareAtPrice, item.offer.currency, 2)}
                              </span>
                            )}
                          </div>
                        ) : (
                          <span className="text-xs text-muted-foreground">No active offers</span>
                        )}

                        {item.availability.status === "IN_STOCK" && (
                          <Badge variant="success">In Stock</Badge>
                        )}
                        {item.availability.status === "OUT_OF_STOCK" && (
                          <Badge variant="warning">Out of Stock</Badge>
                        )}
                        {item.availability.status === "UNAVAILABLE" && (
                          <Badge variant="destructive">Unavailable</Badge>
                        )}
                      </div>
                    </div>
                  </div>

                  <div className="flex shrink-0 items-center gap-2 sm:flex-col sm:items-end">
                    {canAddToCart ? (
                      <Button
                        size="sm"
                        disabled={isMoving || isRemoving}
                        onClick={() => handleMoveToCart(item)}
                        className="gap-1.5"
                      >
                        <ShoppingCart className="size-4" />
                        {isMoving ? "Moving…" : "Move to Cart"}
                      </Button>
                    ) : (
                      <Button
                        size="sm"
                        variant={subscribedStockProductIds.has(item.productId) ? "secondary" : "outline"}
                        disabled={alertingProductId === item.productId || isMoving || isRemoving}
                        onClick={() => handleToggleStockAlert(item)}
                        className="gap-1.5"
                        data-testid={`stock-alert-button-${item.productId}`}
                      >
                        <Bell
                          className={cn(
                            "size-4",
                            subscribedStockProductIds.has(item.productId) && "fill-primary text-primary",
                          )}
                        />
                        {alertingProductId === item.productId
                          ? "Updating…"
                          : subscribedStockProductIds.has(item.productId)
                          ? "Alert Active"
                          : "Notify Me"}
                      </Button>
                    )}

                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={isMoving || isRemoving}
                      onClick={() => handleRemove(item)}
                      className="text-destructive hover:text-destructive"
                    >
                      <Trash2 className="size-4" />
                      {isRemoving ? "Removing…" : "Remove"}
                    </Button>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
};
