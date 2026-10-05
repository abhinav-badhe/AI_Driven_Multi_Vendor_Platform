import { useEffect, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { Check, MessageSquareText, PackageSearch, Star } from "lucide-react";
import { catalogApi, type Product, type ProductReview, type Sku } from "./api/catalog";
import { marketplaceApi, type Listing } from "../marketplace/api/marketplace";
import { recommendationsApi, type RecommendationItemDto } from "../recommendations/api/recommendations";
import { useCart } from "../cart/CartContext";
import { useAuth } from "../auth/AuthContext";
import { Button, buttonVariants } from "../../components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "../../components/ui/card";
import { Badge } from "../../components/ui/badge";
import { Alert } from "../../components/ui/alert";
import { EmptyState, Skeleton } from "../../components/ui/empty";
import { Rating } from "../../components/product/display";
import { cn } from "../../lib/utils";

function SpecRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-3 px-3 py-1.5 text-[13px]">
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <dd className="text-right">{value}</dd>
    </div>
  );
}

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

  const [reviews, setReviews] = useState<ProductReview[]>([]);
  const [isLoadingReviews, setIsLoadingReviews] = useState(false);
  const [selectedImage, setSelectedImage] = useState(0);

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
        setSelectedImage(0);
        setIsLoadingReviews(true);
        try {
          const revs = await catalogApi.getProductReviews(id).catch(() => [] as ProductReview[]);
          setReviews(Array.isArray(revs) ? revs : []);
        } finally {
          setIsLoadingReviews(false);
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

  const gallery = product.images && product.images.length > 0
    ? product.images
    : product.thumbnailUrl
      ? [product.thumbnailUrl]
      : [];
  const activeImage = gallery[Math.min(selectedImage, Math.max(0, gallery.length - 1))];
  const attrs = product.attributes ?? {};
  const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
  const dims = attrs.dimensions as { width?: number; height?: number; depth?: number } | undefined;
  const tags = Array.isArray(attrs.tags)
    ? (attrs.tags as unknown[]).filter((t): t is string => typeof t === "string")
    : [];

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
          {activeImage && (
            <div className="overflow-hidden rounded-lg border border-border">
              <img src={activeImage} alt={product.title} className="aspect-square w-full object-cover" />
            </div>
          )}
          {gallery.length > 1 && (
            <div className="mt-2 flex gap-1.5" role="group" aria-label="Product images">
              {gallery.map((src, i) => (
                <button
                  key={src + i}
                  type="button"
                  onClick={() => setSelectedImage(i)}
                  aria-label={`Show image ${i + 1}`}
                  aria-pressed={i === selectedImage}
                  className={cn(
                    "overflow-hidden rounded-md border",
                    i === selectedImage ? "border-primary" : "border-border hover:border-muted-foreground"
                  )}
                >
                  <img src={src} alt="" loading="lazy" className="size-14 object-cover" />
                </button>
              ))}
            </div>
          )}

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <h1 className="text-xl font-semibold tracking-tight">{product.title}</h1>
          </div>
          {product.brand && (
            <p className="mt-1 text-[13px] text-muted-foreground">{product.brand}</p>
          )}
          <div className="mt-1.5">
            <Rating rating={product.rating} reviewCount={product.reviewCount ?? reviews.length} />
          </div>
          <p className="mt-3 max-w-[80ch] text-sm leading-relaxed text-muted-foreground">
            {product.description || "No description available."}
          </p>

          {tags.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-1.5" aria-label="Tags">
              {tags.map((t) => (
                <Badge key={t} variant="outline">
                  {t}
                </Badge>
              ))}
            </div>
          )}

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
              {selectedSku?.barcode && (
                <p className="mt-1.5 font-mono text-xs text-muted-foreground">
                  Barcode {selectedSku.barcode}
                </p>
              )}
            </div>
          ) : (
            <div className="mt-4">
              <Alert tone="info">No active variants available for this product.</Alert>
            </div>
          )}

          {/* Specifications from catalog attributes */}
          <Card className="mt-4">
            <CardHeader>
              <CardTitle>Specifications</CardTitle>
            </CardHeader>
            <CardContent>
              <dl className="divide-y divide-border rounded-md border border-border">
                {str(attrs.warrantyInformation) && (
                  <SpecRow label="Warranty" value={str(attrs.warrantyInformation)} />
                )}
                {str(attrs.shippingInformation) && (
                  <SpecRow label="Shipping" value={str(attrs.shippingInformation)} />
                )}
                {str(attrs.returnPolicy) && (
                  <SpecRow label="Returns" value={str(attrs.returnPolicy)} />
                )}
                {str(attrs.availabilityStatus) && (
                  <SpecRow
                    label="Availability"
                    value={<Badge variant="success">{str(attrs.availabilityStatus)}</Badge>}
                  />
                )}
                {typeof attrs.weight === "number" && (
                  <SpecRow label="Weight" value={<span className="tnum">{attrs.weight} kg</span>} />
                )}
                {dims && (
                  <SpecRow
                    label="Dimensions"
                    value={
                      <span className="tnum">
                        {dims.width} × {dims.height} × {dims.depth} cm
                      </span>
                    }
                  />
                )}
                {typeof attrs.minimumOrderQuantity === "number" && (
                  <SpecRow label="Min. order" value={<span className="tnum">{attrs.minimumOrderQuantity}</span>} />
                )}
              </dl>
            </CardContent>
          </Card>

          {/* Customer reviews */}
          <section aria-label="Customer reviews" className="mt-4">
            <h2 className="flex items-center gap-1.5 text-sm font-semibold">
              <MessageSquareText className="size-4" aria-hidden />
              Reviews {reviews.length > 0 && <span className="text-muted-foreground">({reviews.length})</span>}
            </h2>
            {isLoadingReviews ? (
              <div className="mt-2 flex flex-col gap-2" aria-label="Loading reviews">
                <Skeleton className="h-20" />
                <Skeleton className="h-20" />
              </div>
            ) : reviews.length === 0 ? (
              <p className="mt-2 text-[13px] text-muted-foreground">No reviews yet.</p>
            ) : (
              <ul className="mt-2 flex flex-col gap-2">
                {reviews.map((r) => (
                  <li key={r.id} className="rounded-lg border border-border p-3">
                    <div className="flex items-center justify-between gap-2">
                      <span className="flex items-center gap-1 text-xs" aria-label={`${r.rating} out of 5 stars`}>
                        {Array.from({ length: 5 }).map((_, i) => (
                          <Star
                            key={i}
                            className={cn(
                              "size-3.5",
                              i < r.rating ? "fill-warning text-warning" : "text-border"
                            )}
                            aria-hidden
                          />
                        ))}
                      </span>
                      {r.reviewedAt && (
                        <span className="text-xs text-muted-foreground">
                          {new Date(r.reviewedAt).toLocaleDateString()}
                        </span>
                      )}
                    </div>
                    {r.comment && <p className="mt-1 text-[13px]">{r.comment}</p>}
                    {r.reviewerName && (
                      <p className="mt-1 text-xs text-muted-foreground">— {r.reviewerName}</p>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>
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
                        {(listing.priceAmount / 100).toFixed(2)} {listing.currency}
                      </p>
                      {listing.compareAtPrice && listing.compareAtPrice > listing.priceAmount && (
                        <p className="tnum text-xs text-muted-foreground line-through">
                          {(listing.compareAtPrice / 100).toFixed(2)} {listing.currency}
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
