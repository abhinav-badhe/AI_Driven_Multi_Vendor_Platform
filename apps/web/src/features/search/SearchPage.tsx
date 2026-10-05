import { useState, useEffect, useCallback, type FormEvent } from "react";
import { useSearchParams, Link } from "react-router-dom";
import { SearchX } from "lucide-react";
import { searchApi, type SearchResponseDto, type SearchSortBy } from "./api/search";
import { useCart } from "../cart/CartContext";
import { useAuth } from "../auth/AuthContext";
import { Button, buttonVariants } from "../../components/ui/button";
import { Card, CardContent } from "../../components/ui/card";
import { Alert } from "../../components/ui/alert";
import { EmptyState, Skeleton } from "../../components/ui/empty";
import { Input, Label } from "../../components/ui/input";
import { ProductCard, QtyControl } from "../../components/product/ProductCard";
import { getDisplay } from "../../components/product/display";
import { formatPrice } from "../../lib/format";
import { cn } from "../../lib/utils";

export const SearchPage = () => {
  const [searchParams, setSearchParams] = useSearchParams();
  const { isAuthenticated, login } = useAuth();
  const { cart, addItem, updateQuantity, removeItem } = useCart();
  const [actionLoadingId, setActionLoadingId] = useState<string | null>(null);

  const queryQ = searchParams.get("q") || "";
  const queryCategory = searchParams.get("categoryId") || "";
  const queryBrand = searchParams.get("brand") || "";
  const queryInStock = searchParams.get("inStock") === "true";
  const querySort = (searchParams.get("sortBy") as SearchSortBy) || "relevance";
  const queryPage = parseInt(searchParams.get("page") || "1", 10);

  const [inputQuery, setInputQuery] = useState(queryQ);
  const [data, setData] = useState<SearchResponseDto | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleAddToCart = async (listingId: string) => {
    setActionLoadingId(listingId);
    try {
      if (!isAuthenticated) {
        await login({ email: "customer@example.com", password: "password123" });
      }
      await addItem(listingId, 1);
    } catch (err: unknown) {
      alert(`Could not add to cart: ${err instanceof Error ? err.message : "Error"}`);
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

  const performSearch = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const response = await searchApi.search({
        q: queryQ || undefined,
        categoryId: queryCategory || undefined,
        brand: queryBrand || undefined,
        inStock: queryInStock ? true : undefined,
        sortBy: querySort,
        page: queryPage,
        pageSize: 12,
      });
      setData(response);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Search failed. Please try again.");
    } finally {
      setIsLoading(false);
    }
  }, [queryQ, queryCategory, queryBrand, queryInStock, querySort, queryPage]);

  useEffect(() => {
    performSearch();
  }, [performSearch]);

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    const next = new URLSearchParams(searchParams);
    if (inputQuery.trim()) {
      next.set("q", inputQuery.trim());
    } else {
      next.delete("q");
    }
    next.set("page", "1");
    setSearchParams(next);
  };

  const handleFilterChange = (key: string, value: string | null) => {
    const next = new URLSearchParams(searchParams);
    if (value) {
      next.set(key, value);
    } else {
      next.delete(key);
    }
    next.set("page", "1");
    setSearchParams(next);
  };

  const handlePageChange = (newPage: number) => {
    const next = new URLSearchParams(searchParams);
    next.set("page", newPage.toString());
    setSearchParams(next);
    window.scrollTo({ top: 0 });
  };

  return (
    <div className="mx-auto w-full max-w-6xl p-4">
      <h1 className="text-xl font-semibold tracking-tight">Search products</h1>
      <form onSubmit={handleSubmit} className="mt-3 flex max-w-xl gap-2">
        <Input
          id="search-input"
          type="search"
          placeholder="Search by title, brand, category, or SKU"
          value={inputQuery}
          onChange={(e) => setInputQuery(e.target.value)}
          aria-label="Search products"
        />
        <Button id="search-submit" type="submit" disabled={isLoading}>
          {isLoading ? "Searching…" : "Search"}
        </Button>
      </form>

      {/* Narrow filter rail + results (not equal columns) */}
      <div className="mt-4 grid items-start gap-4 lg:grid-cols-4">
        <aside className="flex flex-col gap-3 lg:col-span-1">
          <Card>
            <CardContent className="p-4">
              <div className="flex flex-col gap-1">
                <Label htmlFor="sort-select">Sort by</Label>
                <select
                  id="sort-select"
                  value={querySort}
                  onChange={(e) => handleFilterChange("sortBy", e.target.value)}
                  aria-label="Sort products"
                  className="h-8 rounded-md border border-input bg-background px-2.5 text-[13px] outline-none focus-visible:border-ring"
                >
                  <option value="relevance">Relevance</option>
                  <option value="price_asc">Price: Low to High</option>
                  <option value="price_desc">Price: High to Low</option>
                  <option value="newest">Newest Arrivals</option>
                </select>
              </div>
              <label className="mt-3 flex cursor-pointer items-center gap-2 text-[13px]">
                <input
                  id="filter-in-stock"
                  type="checkbox"
                  checked={queryInStock}
                  onChange={(e) => handleFilterChange("inStock", e.target.checked ? "true" : null)}
                  className="size-4 accent-primary"
                />
                In stock only
              </label>
            </CardContent>
          </Card>

          {data?.facets?.categories && data.facets.categories.length > 0 && (
            <Card>
              <CardContent className="p-4">
                <p className="text-sm font-semibold">Categories</p>
                <ul className="mt-1 flex flex-col">
                  <li>
                    <button
                      type="button"
                      onClick={() => handleFilterChange("categoryId", null)}
                      className={cn(
                        "w-full rounded px-1 py-1 text-left text-[13px]",
                        !queryCategory ? "font-semibold text-primary" : "text-muted-foreground hover:text-foreground"
                      )}
                    >
                      All categories
                    </button>
                  </li>
                  {data.facets.categories.map((cat) => (
                    <li key={cat.id}>
                      <button
                        type="button"
                        onClick={() => handleFilterChange("categoryId", cat.id)}
                        className={cn(
                          "flex w-full items-center justify-between gap-2 rounded px-1 py-1 text-left text-[13px]",
                          queryCategory === cat.id
                            ? "font-semibold text-primary"
                            : "text-muted-foreground hover:text-foreground"
                        )}
                      >
                        <span>{cat.name}</span>
                        <span className="tnum text-xs">({cat.count})</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          )}

          {data?.facets?.brands && data.facets.brands.length > 0 && (
            <Card>
              <CardContent className="p-4">
                <p className="text-sm font-semibold">Brands</p>
                <ul className="mt-1 flex flex-col">
                  <li>
                    <button
                      type="button"
                      onClick={() => handleFilterChange("brand", null)}
                      className={cn(
                        "w-full rounded px-1 py-1 text-left text-[13px]",
                        !queryBrand ? "font-semibold text-primary" : "text-muted-foreground hover:text-foreground"
                      )}
                    >
                      All brands
                    </button>
                  </li>
                  {data.facets.brands.map((b) => (
                    <li key={b.name}>
                      <button
                        type="button"
                        onClick={() => handleFilterChange("brand", b.name)}
                        className={cn(
                          "flex w-full items-center justify-between gap-2 rounded px-1 py-1 text-left text-[13px]",
                          queryBrand === b.name
                            ? "font-semibold text-primary"
                            : "text-muted-foreground hover:text-foreground"
                        )}
                      >
                        <span>{b.name}</span>
                        <span className="tnum text-xs">({b.count})</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          )}
        </aside>

        <div className="lg:col-span-3">
          {error && (
            <Alert tone="error" title="Search failed">
              {error}
            </Alert>
          )}

          {isLoading ? (
            <div className="grid gap-3 sm:grid-cols-2" aria-label="Loading results">
              {Array.from({ length: 4 }).map((_, i) => (
                <Skeleton key={i} className="h-44" />
              ))}
            </div>
          ) : data?.items && data.items.length > 0 ? (
            <>
              <p className="text-[13px] text-muted-foreground" role="status">
                Showing {data.items.length} of {data.total} {data.total === 1 ? "product" : "products"}
                {queryQ && (
                  <span>
                    {" "}for “<strong className="text-foreground">{queryQ}</strong>”
                  </span>
                )}
              </p>

              <div className="mt-2 grid gap-3 sm:grid-cols-2">
                {data.items.map((item) => {
                  const bestOffer = item.bestOffer || item.offers?.[0];
                  const cartItem = cart?.items?.find((it) => it.listingId === bestOffer?.listingId);
                  const display = getDisplay(item.attributes);
                  const priceLabel =
                    item.minPrice === item.maxPrice
                      ? formatPrice(item.minPrice, item.currency, 2)
                      : `${formatPrice(item.minPrice, item.currency, 2)} – ${formatPrice(item.maxPrice, item.currency, 2)}`;

                  return (
                    <ProductCard
                      key={item.productId}
                      productId={item.productId}
                      title={item.title}
                      brand={item.brand}
                      categoryName={item.categoryName}
                      merchantName={bestOffer?.merchantName}
                      priceLabel={priceLabel}
                      compareAtLabel={
                        bestOffer?.compareAtPrice && bestOffer.compareAtPrice > item.minPrice
                          ? formatPrice(bestOffer.compareAtPrice, item.currency, 2)
                          : null
                      }
                      compareAtPrice={bestOffer?.compareAtPrice}
                      price={item.minPrice}
                      offerCount={item.totalOffersCount}
                      inStock={item.hasInStockOffer}
                      thumbnailUrl={display.thumbnailUrl}
                      rating={display.rating}
                      reviewCount={display.reviewCount}
                      action={
                        item.hasInStockOffer && bestOffer ? (
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
                            to={`/product/${item.productId}`}
                            className={cn(buttonVariants({ variant: "outline", size: "sm" }))}
                          >
                            Details
                          </Link>
                        )
                      }
                    />
                  );
                })}
              </div>

              {data.totalPages > 1 && (
                <nav aria-label="Pagination" className="mt-4 flex items-center justify-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => handlePageChange(data.page - 1)}
                    disabled={data.page <= 1}
                    aria-label="Previous page"
                  >
                    Previous
                  </Button>
                  <span className="tnum text-[13px] text-muted-foreground">
                    Page {data.page} of {data.totalPages}
                  </span>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => handlePageChange(data.page + 1)}
                    disabled={data.page >= data.totalPages}
                    aria-label="Next page"
                  >
                    Next
                  </Button>
                </nav>
              )}
            </>
          ) : (
            <EmptyState
              icon={SearchX}
              title="No products found"
              description="No products match your query or filters. Try different keywords or reset the filters."
              actionLabel="Reset all filters"
              onAction={() => {
                setInputQuery("");
                setSearchParams(new URLSearchParams());
              }}
            />
          )}
        </div>
      </div>
    </div>
  );
};
