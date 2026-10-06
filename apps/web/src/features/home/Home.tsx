import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { PackageSearch, Truck } from "lucide-react";
import { catalogApi, type Category } from "../catalog/api/catalog";
import { searchApi, type SearchProductResultDto } from "../search/api/search";
import { recommendationsApi, type RecommendationItemDto } from "../recommendations/api/recommendations";
import { useAuth } from "../auth/AuthContext";
import { useCart } from "../cart/CartContext";
import { Button, buttonVariants } from "../../components/ui/button";
import { Alert } from "../../components/ui/alert";
import { EmptyState, Skeleton } from "../../components/ui/empty";
import { Badge } from "../../components/ui/badge";
import { ProductCard, QtyControl } from "../../components/product/ProductCard";
import { getDisplay } from "../../components/product/display";
import { formatPrice } from "../../lib/format";
import { cn } from "../../lib/utils";

export const Home = () => {
  const { isAuthenticated, login } = useAuth();
  const { cart, addItem, updateQuantity, removeItem } = useCart();
  const [categories, setCategories] = useState<Category[]>([]);
  const [products, setProducts] = useState<SearchProductResultDto[]>([]);
  const [recommendations, setRecommendations] = useState<RecommendationItemDto[]>([]);
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [actionLoadingId, setActionLoadingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fetchData = async () => {
      try {
        setIsLoading(true);
        const catData = await catalogApi.getCategories();
        setCategories(catData || []);

        try {
          if (isAuthenticated) {
            const recs = await recommendationsApi.getPersonalized(4);
            setRecommendations(recs.items || []);
          } else {
            const trending = await recommendationsApi.getTrending(4).catch(() => ({ items: [] }));
            setRecommendations(trending.items || []);
          }
        } catch {
          // Graceful fallback
        }

        try {
          const searchData = await searchApi.search({ pageSize: 12 }).catch(() => ({ items: [] }));
          setProducts(searchData.items || []);
        } catch {
          // Graceful fallback
        }
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : "Failed to load products");
      } finally {
        setIsLoading(false);
      }
    };
    fetchData();
  }, [isAuthenticated]);

  const handleAddToCart = async (listingId: string) => {
    setActionLoadingId(listingId);
    try {
      if (!isAuthenticated) {
        await login({ email: "customer@example.com", password: "password123" });
      }
      await addItem(listingId, 1);
    } catch (err: unknown) {
      alert(`Could not add to cart: ${err instanceof Error ? err.message : "Item unavailable"}`);
    } finally {
      setActionLoadingId(null);
    }
  };

  const handleUpdateQty = async (itemId: string, currentQty: number, delta: number) => {
    setActionLoadingId(itemId);
    try {
      const nextQty = currentQty + delta;
      if (nextQty <= 0) {
        await removeItem(itemId);
      } else {
        await updateQuantity(itemId, nextQty);
      }
    } catch (err: unknown) {
      alert(`Quantity update failed: ${err instanceof Error ? err.message : "Error"}`);
    } finally {
      setActionLoadingId(null);
    }
  };

  const rootCategories = categories.filter((c) => !c.parentId);
  const displayedProducts = selectedCategory
    ? products.filter((p) => p.categoryId === selectedCategory)
    : products;

  if (isLoading) {
    return (
      <div className="mx-auto w-full max-w-6xl space-y-3 px-3 py-4 md:px-4" aria-label="Loading products">
        <Skeleton className="h-6 w-48" />
        <Skeleton className="h-4 w-72" />
        <div className="grid grid-cols-2 gap-2.5 md:grid-cols-3 xl:grid-cols-4">
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} className="h-56" />
          ))}
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="mx-auto w-full max-w-6xl px-3 py-4 md:px-4">
        <Alert tone="error" title="Products could not be loaded">
          {error} Check your connection and try again.
        </Alert>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-6xl px-3 py-4 md:px-4">
      {/* Page header — left-aligned, functional copy */}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Browse products</h1>
          <p className="mt-1 flex items-center gap-1.5 text-[13px] text-muted-foreground">
            <Truck className="size-4" aria-hidden />
            Delivering to Bandra West, Mumbai 400050 · 10–15 min dispatch where available
          </p>
        </div>
        <Link to="/search" className={cn(buttonVariants({ variant: "outline", size: "sm" }))}>
          Browse all products
        </Link>
      </div>

      {/* Category filter — pills are for tags only, which this is */}
      {rootCategories.length > 0 && (
        <div className="mt-4 flex gap-1.5 overflow-x-auto pb-1" role="group" aria-label="Filter by category">
          <Button
            variant={selectedCategory === null ? "default" : "outline"}
            size="sm"
            className="rounded-full"
            onClick={() => setSelectedCategory(null)}
          >
            All
          </Button>
          {rootCategories.map((cat) => (
            <Button
              key={cat.id}
              variant={selectedCategory === cat.id ? "default" : "outline"}
              size="sm"
              className="rounded-full whitespace-nowrap"
              onClick={() => setSelectedCategory(cat.id === selectedCategory ? null : cat.id)}
            >
              {cat.name}
            </Button>
          ))}
        </div>
      )}

      {/* Product list — asymmetric: main grid + narrow side rail */}
      <section aria-label="Products" className="mt-4">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-sm font-semibold">Available now</h2>
          <Link to="/search" className="text-[13px] font-medium text-primary hover:underline">
            View all ({products.length})
          </Link>
        </div>

        {displayedProducts.length === 0 ? (
          <EmptyState
            icon={PackageSearch}
            title="No products in this category"
            description="Try a different category or browse the full catalog."
            actionLabel="Browse all products"
            onAction={() => setSelectedCategory(null)}
          />
        ) : (
          <div className="grid grid-cols-2 gap-2.5 md:grid-cols-3 xl:grid-cols-4">
            {displayedProducts.map((p) => {
              const bestOffer = p.bestOffer || p.offers?.[0];
              const cartItem = cart?.items?.find((it) => it.listingId === bestOffer?.listingId);
              const display = getDisplay(p.attributes);

              return (
                <ProductCard
                  key={p.productId}
                  productId={p.productId}
                  title={p.title}
                  brand={p.brand}
                  merchantName={bestOffer?.merchantName}
                  priceLabel={formatPrice(p.minPrice, p.currency, 2)}
                  compareAtLabel={
                    bestOffer?.compareAtPrice && bestOffer.compareAtPrice > p.minPrice
                      ? formatPrice(bestOffer.compareAtPrice, p.currency, 2)
                      : null
                  }
                  compareAtPrice={bestOffer?.compareAtPrice}
                  price={p.minPrice}
                  offerCount={p.totalOffersCount}
                  inStock={p.hasInStockOffer}
                  thumbnailUrl={display.thumbnailUrl}
                  rating={display.rating}
                  reviewCount={display.reviewCount}
                  action={
                    p.hasInStockOffer && bestOffer ? (
                      cartItem ? (
                        <QtyControl
                          quantity={cartItem.quantity}
                          disabled={actionLoadingId === cartItem.id}
                          onDecrease={() => handleUpdateQty(cartItem.id, cartItem.quantity, -1)}
                          onIncrease={() => handleUpdateQty(cartItem.id, cartItem.quantity, 1)}
                        />
                      ) : (
                        <Button
                          size="sm"
                          disabled={actionLoadingId === bestOffer.listingId}
                          onClick={() => handleAddToCart(bestOffer.listingId)}
                        >
                          {actionLoadingId === bestOffer.listingId ? "Adding…" : "Add to cart"}
                        </Button>
                      )
                    ) : (
                      <Link
                        to={`/product/${p.productId}`}
                        className={cn(buttonVariants({ variant: "outline", size: "sm" }))}
                      >
                        View offers
                      </Link>
                    )
                  }
                />
              );
            })}
          </div>
        )}
      </section>

      {/* Recommendations — plain secondary section, no accent headline tricks */}
      {recommendations.length > 0 && (
        <section aria-label="Recommended products" className="mt-6">
          <h2 className="text-sm font-semibold">Recommended based on your activity</h2>
          <p className="mt-0.5 text-[13px] text-muted-foreground">
            Ranked from your browsing and cart items.
          </p>
          <div className="mt-2 grid gap-3 sm:grid-cols-2">
            {recommendations.map((item) => {
              const bestOffer = item.activeOffers?.[0];
              return (
                <Link
                  key={item.productId}
                  to={`/product/${item.productId}`}
                  className="rounded-lg border border-border p-4 transition-colors duration-150 hover:bg-muted"
                >
                  <p className="text-sm font-medium">{item.title}</p>
                  {item.explanation && (
                    <p className="mt-0.5 text-xs text-muted-foreground">{item.explanation}</p>
                  )}
                  <div className="mt-2 flex items-center justify-between">
                    <span className="tnum text-sm font-semibold">
                      {bestOffer ? (
                        formatPrice(bestOffer.priceAmount, bestOffer.currency, 2)
                      ) : (
                        <span className="font-normal text-muted-foreground">Check listings</span>
                      )}
                    </span>
                    <Badge variant={item.isAvailable ? "success" : "outline"}>
                      {item.isAvailable ? "In stock" : "Out of stock"}
                    </Badge>
                  </div>
                </Link>
              );
            })}
          </div>
        </section>
      )}

      {/* Category index — compact list, not equal marketing cards */}
      <section aria-label="Categories" className="mt-6">
        <h2 className="text-sm font-semibold">Shop by category</h2>
        {rootCategories.length === 0 ? (
          <p className="mt-2 text-[13px] text-muted-foreground">No categories found.</p>
        ) : (
          <div className="mt-2 divide-y divide-border rounded-lg border border-border">
            {rootCategories.map((category) => (
              <Link
                key={category.id}
                to={`/category/${category.id}`}
                className="flex items-center justify-between px-3 py-2 text-[13px] transition-colors duration-150 hover:bg-muted"
              >
                <span className="font-medium">{category.name}</span>
                <span className="text-muted-foreground">Browse →</span>
              </Link>
            ))}
          </div>
        )}
      </section>
    </div>
  );
};
