import { useEffect, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { Check, PackageSearch } from "lucide-react";
import { catalogApi, type Product, type Sku } from "./api/catalog";
import { marketplaceApi, type Listing } from "../marketplace/api/marketplace";
import { recommendationsApi, type RecommendationItemDto } from "../recommendations/api/recommendations";
import { useCart } from "../cart/CartContext";
import { useAuth } from "../auth/AuthContext";
import { Button, buttonVariants } from "../../components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "../../components/ui/card";
import { Badge } from "../../components/ui/badge";
import { Alert } from "../../components/ui/alert";
import { EmptyState, Skeleton } from "../../components/ui/empty";
import { cn } from "../../lib/utils";

export const ProductPage = () => {
  const { id } = useParams<{ id: string }>();
  const { addItem } = useCart();
  const { isAuthenticated, login } = useAuth();
  const [product, setProduct] = useState<Product | null>(null);
  const [skus, setSkus] = useState<Sku[]>([]);
  const [selectedSku, setSelectedSku] = useState<Sku | null>(null);
  const [listings, setListings] = useState<Listing[]>([]);
  const [addingListingId, setAddingListingId] = useState<string | null>(null);
  const [addedListingId, setAddedListingId] = useState<string | null>(null);

  const [isLoadingProduct, setIsLoadingProduct] = useState(true);
  const [isLoadingListings, setIsLoadingListings] = useState(false);
  const [alternatives, setAlternatives] = useState<RecommendationItemDto[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [listingsError, setListingsError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    const fetchProduct = async () => {
      setIsLoadingProduct(true);
      setError(null);
      try {
        const [productData, skusData] = await Promise.all([
          catalogApi.getProduct(id),
          catalogApi.getProductSkus(id),
        ]);
        setProduct(productData);
        setSkus(skusData);
        if (skusData.length > 0) {
          setSelectedSku(skusData[0] ?? null);
        }
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : "Failed to load product");
      } finally {
        setIsLoadingProduct(false);
      }
    };
    fetchProduct();
  }, [id]);

  useEffect(() => {
    if (!selectedSku) {
      setListings([]);
      return;
    }
    const fetchListings = async () => {
      setIsLoadingListings(true);
      setListingsError(null);
      try {
        const listingsData = await marketplaceApi.getSkuListings(selectedSku.id);
        setListings(listingsData);
        if (listingsData.length === 0 && product) {
          recommendationsApi
            .getSimilar(product.id, 3)
            .then((res) => setAlternatives(res.items || []))
            .catch(() => setAlternatives([]));
        }
      } catch (err: unknown) {
        setListingsError(err instanceof Error ? err.message : "Failed to load offers");
      } finally {
        setIsLoadingListings(false);
      }
    };
    fetchListings();
  }, [selectedSku, product]);

  if (isLoadingProduct) {
    return (
      <div className="mx-auto w-full max-w-6xl space-y-3 p-4" aria-label="Loading product details">
        <Skeleton className="h-4 w-48" />
        <Skeleton className="h-6 w-72" />
        <div className="grid gap-4 lg:grid-cols-5">
          <Skeleton className="h-56 lg:col-span-3" />
          <Skeleton className="h-56 lg:col-span-2" />
        </div>
      </div>
    );
  }
  if (error) {
    return (
      <div className="mx-auto w-full max-w-6xl p-4">
        <Alert tone="error" title="Product could not be loaded">
          Error: {error}
        </Alert>
      </div>
    );
  }
  if (!product) {
    return (
      <div className="mx-auto w-full max-w-6xl p-4">
        <EmptyState
          icon={PackageSearch}
          title="Product not found"
          description="This product may have been removed. Try browsing the catalog."
        />
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-6xl p-4">
      <nav aria-label="Breadcrumb" className="text-[13px] text-muted-foreground">
        <Link to="/" className="hover:underline">
          Home
        </Link>
        {product.categoryId && (
          <>
            {" / "}
            <Link to={`/category/${product.categoryId}`} className="hover:underline">
              Category
            </Link>
          </>
        )}
        <span aria-current="page"> / {product.title}</span>
      </nav>

      {/* Asymmetric split: details take the room, offers ride in a narrow rail */}
      <div className="mt-3 grid items-start gap-4 lg:grid-cols-5">
        <div className="lg:col-span-3">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-xl font-semibold tracking-tight">{product.title}</h1>
          </div>
          {product.brand && (
            <p className="mt-1 text-[13px] text-muted-foreground">{product.brand}</p>
          )}
          <p className="mt-3 max-w-[80ch] text-sm leading-relaxed text-muted-foreground">
            {product.description || "No description available."}
          </p>

          {skus.length > 0 ? (
            <div className="mt-4">
              <h2 className="text-sm font-semibold">Variant</h2>
              <div className="mt-2 flex flex-wrap gap-1.5" role="group" aria-label="Choose a variant">
                {skus.map((sku) => {
                  const active = selectedSku?.id === sku.id;
                  return (
                    <button
                      key={sku.id}
                      type="button"
                      onClick={() => setSelectedSku(sku)}
                      aria-pressed={active}
                      className={cn(
                        "rounded-md border px-3 py-1.5 font-mono text-xs transition-colors duration-150",
                        active
                          ? "border-primary bg-secondary font-semibold"
                          : "border-border hover:bg-muted"
                      )}
                    >
                      {sku.skuCode}
                    </button>
                  );
                })}
              </div>
            </div>
          ) : (
            <div className="mt-4">
              <Alert tone="info">No active variants available for this product.</Alert>
            </div>
          )}
        </div>

        <Card className="lg:col-span-2">
          <CardHeader>
            <div className="flex items-center justify-between gap-2">
              <div>
                <CardTitle>Seller offers</CardTitle>
                <CardDescription>
                  {selectedSku ? "Prices for the selected variant" : "Choose a variant to see offers."}
                </CardDescription>
              </div>
              {listings.length > 0 && <Badge variant="outline">{listings.length}</Badge>}
            </div>
          </CardHeader>
          <CardContent>
            {!selectedSku ? (
              <p className="text-[13px] text-muted-foreground">Select a variant to see available offers.</p>
            ) : isLoadingListings ? (
              <div className="flex flex-col gap-2" aria-label="Loading offers">
                <Skeleton className="h-16" />
                <Skeleton className="h-16" />
              </div>
            ) : listingsError ? (
              <Alert tone="error" title="Offers could not be loaded">
                Error loading offers: {listingsError}
              </Alert>
            ) : listings.length === 0 ? (
              <div>
                <EmptyState
                  icon={PackageSearch}
                  title="Currently unavailable."
                  description="No merchants are actively selling this item."
                />
                {alternatives.length > 0 && (
                  <div className="mt-3">
                    <p className="text-[13px] font-medium">Similar items</p>
                    <div className="mt-1 divide-y divide-border rounded-md border border-border">
                      {alternatives.map((alt) => (
                        <Link
                          key={alt.productId}
                          to={`/product/${alt.productId}`}
                          className="flex items-center justify-between gap-2 px-3 py-2 text-[13px] transition-colors duration-150 hover:bg-muted"
                        >
                          <span className="font-medium">{alt.title}</span>
                          <span className="shrink-0 text-primary">Compare →</span>
                        </Link>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <ul className="flex flex-col gap-2">
                {listings.map((listing) => (
                  <li
                    key={listing.id}
                    className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2"
                  >
                    <div className="min-w-0">
                      <p className="tnum text-base font-semibold">
                        {listing.priceAmount.toFixed(2)} {listing.currency}
                      </p>
                      {listing.compareAtPrice && listing.compareAtPrice > listing.priceAmount && (
                        <p className="tnum text-xs text-muted-foreground line-through">
                          {listing.compareAtPrice.toFixed(2)} {listing.currency}
                        </p>
                      )}
                      <p className="mt-0.5 font-mono text-xs text-muted-foreground">
                        Merchant {listing.tenantId.slice(0, 8)}
                      </p>
                    </div>
                    {addedListingId === listing.id ? (
                      <Link to="/cart" className={cn(buttonVariants({ size: "sm" }))}>
                        <Check aria-hidden />
                        In cart
                      </Link>
                    ) : (
                      <Button
                        size="sm"
                        disabled={addingListingId === listing.id}
                        onClick={async () => {
                          setAddingListingId(listing.id);
                          try {
                            if (!isAuthenticated) {
                              await login({ email: "customer@example.com", password: "password123" });
                            }
                            await addItem(listing.id, 1);
                            setAddedListingId(listing.id);
                          } catch (err: unknown) {
                            alert(err instanceof Error ? err.message : "Failed to add item to cart");
                          } finally {
                            setAddingListingId(null);
                          }
                        }}
                      >
                        {addingListingId === listing.id ? "Adding…" : "Add to cart"}
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
};
