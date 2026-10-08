import { useEffect, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { Check, Heart, MessageSquareText, PackageSearch, Star, ShieldCheck, Edit3, Trash2, AlertCircle, X, Bell } from "lucide-react";
import {
  catalogApi,
  type Product,
  type ProductReview,
  type ProductRatingSummary,
  type ReviewEligibility,
  type Sku,
} from "./api/catalog";
import { marketplaceApi, type Listing } from "../marketplace/api/marketplace";
import { recommendationsApi, type RecommendationItemDto } from "../recommendations/api/recommendations";
import { wishlistApi } from "../customer/api/wishlist";
import { backInStockApi } from "../customer/api/back-in-stock";
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
  const [ratingSummary, setRatingSummary] = useState<ProductRatingSummary | null>(null);
  const [reviewEligibility, setReviewEligibility] = useState<ReviewEligibility | null>(null);
  const [isLoadingReviews, setIsLoadingReviews] = useState(false);
  const [isWritingReview, setIsWritingReview] = useState(false);
  const [editingReviewId, setEditingReviewId] = useState<string | null>(null);
  const [reviewRating, setReviewRating] = useState<number>(5);
  const [reviewTitle, setReviewTitle] = useState<string>('');
  const [reviewComment, setReviewComment] = useState<string>('');
  const [isSubmittingReview, setIsSubmittingReview] = useState(false);
  const [reviewError, setReviewError] = useState<string | null>(null);
  const [reviewSuccess, setReviewSuccess] = useState<string | null>(null);
  const [selectedImage, setSelectedImage] = useState(0);

  const fetchReviewsAndSummary = async (productId: string) => {
    setIsLoadingReviews(true);
    try {
      const [revs, summary] = await Promise.all([
        catalogApi.getProductReviews(productId).catch(() => [] as ProductReview[]),
        catalogApi.getProductRatingSummary(productId).catch(() => null),
      ]);
      setReviews(Array.isArray(revs) ? revs : []);
      setRatingSummary(summary);
      if (isAuthenticated) {
        catalogApi.getReviewEligibility(productId)
          .then((el) => setReviewEligibility(el))
          .catch(() => setReviewEligibility(null));
      } else {
        setReviewEligibility(null);
      }
    } finally {
      setIsLoadingReviews(false);
    }
  };

  const [isWishlisted, setIsWishlisted] = useState(false);
  const [isUpdatingWishlist, setIsUpdatingWishlist] = useState(false);

  useEffect(() => {
    if (id && isAuthenticated) {
      wishlistApi
        .checkWishlist(id)
        .then((res) => setIsWishlisted(res.isWishlisted))
        .catch(() => setIsWishlisted(false));
    } else {
      setIsWishlisted(false);
    }
  }, [id, isAuthenticated]);

  const handleToggleWishlist = async () => {
    if (!id) return;
    if (!isAuthenticated) {
      await login({ email: "customer@example.com", password: "password123" });
      return;
    }
    setIsUpdatingWishlist(true);
    try {
      if (isWishlisted) {
        await wishlistApi.removeFromWishlist(id);
        setIsWishlisted(false);
      } else {
        await wishlistApi.addToWishlist(id, selectedSku?.id);
        setIsWishlisted(true);
      }
    } catch (err: unknown) {
      alert(err instanceof Error ? err.message : "Failed to update wishlist");
    } finally {
      setIsUpdatingWishlist(false);
    }
  };

  const [isSubscribedStock, setIsSubscribedStock] = useState(false);
  const [isLoadingStockSub, setIsLoadingStockSub] = useState(false);
  const [stockSubError, setStockSubError] = useState<string | null>(null);
  const [stockSubFeedback, setStockSubFeedback] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (id && isAuthenticated) {
      backInStockApi
        .checkSubscription(id)
        .then((res) => {
          if (!cancelled) {
            setIsSubscribedStock(res.isSubscribed && res.status === 'ACTIVE');
          }
        })
        .catch(() => {
          if (!cancelled) {
            setIsSubscribedStock(false);
          }
        });
    } else {
      setIsSubscribedStock(false);
    }
    return () => {
      cancelled = true;
    };
  }, [id, isAuthenticated]);

  const handleSubscribeStock = async () => {
    if (!id) return;
    if (!isAuthenticated) {
      await login({ email: "customer@example.com", password: "password123" });
      return;
    }
    setIsLoadingStockSub(true);
    setStockSubError(null);
    setStockSubFeedback(null);
    try {
      await backInStockApi.subscribe(id, selectedSku?.id);
      setIsSubscribedStock(true);
      setStockSubFeedback("You'll be notified when this product is back in stock.");
    } catch (err: unknown) {
      setStockSubError(err instanceof Error ? err.message : "Failed to subscribe for notifications");
    } finally {
      setIsLoadingStockSub(false);
    }
  };

  const handleCancelStockSubscription = async () => {
    if (!id) return;
    setIsLoadingStockSub(true);
    setStockSubError(null);
    try {
      await backInStockApi.cancelSubscription(id);
      setIsSubscribedStock(false);
      setStockSubFeedback(null);
    } catch (err: unknown) {
      setStockSubError(err instanceof Error ? err.message : "Failed to cancel notification subscription");
    } finally {
      setIsLoadingStockSub(false);
    }
  };

  useEffect(() => {
    let cancelled = false;
    if (!id) return;
    const fetchProduct = async () => {
      setIsLoadingProduct(true);
      setError(null);
      try {
        const [productData, skusData] = await Promise.all([
          catalogApi.getProduct(id),
          catalogApi.getProductSkus(id),
        ]);
        if (!cancelled) {
          setProduct(productData);
          setSkus(skusData);
          if (skusData.length > 0) {
            setSelectedSku(skusData[0] ?? null);
            setIsLoadingListings(true);
          }
          setSelectedImage(0);
          await fetchReviewsAndSummary(id);
        }
      } catch (err: unknown) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to load product");
        }
      } finally {
        if (!cancelled) {
          setIsLoadingProduct(false);
        }
      }
    };
    fetchProduct();
    return () => {
      cancelled = true;
    };
  }, [id, isAuthenticated]);

  const handleStartWrite = () => {
    setEditingReviewId(null);
    setReviewRating(5);
    setReviewTitle('');
    setReviewComment('');
    setReviewError(null);
    setReviewSuccess(null);
    setIsWritingReview(true);
  };

  const handleStartEdit = (review: ProductReview) => {
    setEditingReviewId(review.id);
    setReviewRating(review.rating);
    setReviewTitle(review.title ?? '');
    setReviewComment(review.comment ?? '');
    setReviewError(null);
    setReviewSuccess(null);
    setIsWritingReview(true);
  };

  const handleCancelReview = () => {
    setIsWritingReview(false);
    setEditingReviewId(null);
    setReviewError(null);
  };

  const handleSubmitReview = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!id) return;
    if (reviewComment.trim().length < 3) {
      setReviewError('Review comment must be at least 3 characters long');
      return;
    }
    setIsSubmittingReview(true);
    setReviewError(null);
    const titleClean = reviewTitle.trim();
    try {
      if (editingReviewId) {
        await catalogApi.updateReview(editingReviewId, {
          rating: reviewRating,
          ...(titleClean ? { title: titleClean } : {}),
          comment: reviewComment.trim(),
        });
        setReviewSuccess('Your review has been updated and submitted for moderation!');
      } else {
        await catalogApi.submitReview(id, {
          rating: reviewRating,
          ...(titleClean ? { title: titleClean } : {}),
          comment: reviewComment.trim(),
        });
        setReviewSuccess('Your review has been submitted for moderation! Thank you for your feedback.');
      }
      setIsWritingReview(false);
      setEditingReviewId(null);
      await fetchReviewsAndSummary(id);
    } catch (err: unknown) {
      setReviewError(err instanceof Error ? err.message : 'Failed to submit review');
    } finally {
      setIsSubmittingReview(false);
    }
  };

  const handleDeleteReview = async (reviewId: string) => {
    if (!id || !confirm('Are you sure you want to delete your review?')) return;
    try {
      await catalogApi.deleteReview(reviewId);
      await fetchReviewsAndSummary(id);
    } catch (err: unknown) {
      alert(err instanceof Error ? err.message : 'Failed to delete review');
    }
  };

  useEffect(() => {
    let cancelled = false;
    if (!selectedSku) {
      setListings([]);
      return;
    }
    const fetchListings = async () => {
      setIsLoadingListings(true);
      setListingsError(null);
      try {
        const listingsData = await marketplaceApi.getSkuListings(selectedSku.id);
        if (!cancelled) {
          setListings(listingsData);
          if (listingsData.length === 0 && product) {
            recommendationsApi
              .getSimilar(product.id, 3)
              .then((res) => {
                if (!cancelled) setAlternatives(res.items || []);
              })
              .catch(() => {
                if (!cancelled) setAlternatives([]);
              });
          }
        }
      } catch (err: unknown) {
        if (!cancelled) {
          setListingsError(err instanceof Error ? err.message : "Failed to load offers");
        }
      } finally {
        if (!cancelled) {
          setIsLoadingListings(false);
        }
      }
    };
    fetchListings();
    return () => {
      cancelled = true;
    };
  }, [selectedSku?.id, product?.id]);

  // Price-drop interest signal: authenticated customers record one view per
  // product (with the live floor price) so drops can trigger email alerts.
  const { user } = useAuth();
  useEffect(() => {
    if (!id || !product || user?.role !== "CUSTOMER" || listings.length === 0) return;
    const floor = listings.reduce((min, l) => Math.min(min, l.priceAmount), listings[0]!.priceAmount);
    catalogApi
      .recordView(id, {
        priceSeenMinor: floor,
        currency: listings[0]!.currency,
      })
      .catch(() => {});
  }, [id, product, user, listings]);

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

          <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
            <h1 className="text-xl font-semibold tracking-tight">{product.title}</h1>
            <Button
              variant={isWishlisted ? "secondary" : "outline"}
              size="sm"
              onClick={handleToggleWishlist}
              disabled={isUpdatingWishlist}
              className="gap-1.5"
              id="wishlist-toggle-button"
            >
              <Heart
                className={cn("size-4", isWishlisted && "fill-rose-500 text-rose-500")}
                aria-hidden
              />
              {isWishlisted ? "In Wishlist" : "Save to Wishlist"}
            </Button>
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

          {/* Customer reviews & Ratings Section */}
          <section aria-label="Customer reviews" className="mt-6 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 className="flex items-center gap-2 text-base font-semibold">
                <MessageSquareText className="size-5 text-primary" aria-hidden />
                Ratings & Reviews {ratingSummary ? `(${ratingSummary.totalReviews})` : reviews.length > 0 ? `(${reviews.length})` : ''}
              </h2>
              {!isAuthenticated ? (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={async () => {
                    await login({ email: "customer@example.com", password: "password123" });
                  }}
                >
                  Sign in to review
                </Button>
              ) : reviewEligibility?.isEligible && !isWritingReview ? (
                <Button size="sm" onClick={handleStartWrite} id="write-review-button">
                  Write a Review
                </Button>
              ) : null}
            </div>

            {/* Rating Summary & Star Breakdown */}
            {ratingSummary && ratingSummary.totalReviews > 0 ? (
              <Card className="border border-border/80 bg-muted/20">
                <CardContent className="p-4 sm:p-6">
                  <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-6">
                    <div className="space-y-1">
                      <div className="flex items-baseline gap-2">
                        <span className="text-4xl font-extrabold tracking-tight text-foreground" data-testid="average-rating">
                          {ratingSummary.averageRating.toFixed(1)}
                        </span>
                        <span className="text-sm font-medium text-muted-foreground">/ 5.0</span>
                      </div>
                      <div className="flex items-center gap-1">
                        {Array.from({ length: 5 }).map((_, i) => (
                          <Star
                            key={i}
                            className={cn(
                              "size-4",
                              i < Math.round(ratingSummary.averageRating)
                                ? "fill-amber-400 text-amber-400"
                                : "text-border"
                            )}
                            aria-hidden
                          />
                        ))}
                      </div>
                      <p className="text-xs text-muted-foreground" data-testid="total-reviews-count">
                        Based on {ratingSummary.totalReviews} verified {ratingSummary.totalReviews === 1 ? 'review' : 'reviews'}
                      </p>
                    </div>

                    {/* Star Distribution */}
                    <div className="w-full sm:w-64 space-y-1.5" data-testid="rating-distribution">
                      {([5, 4, 3, 2, 1] as const).map((star) => {
                        const count = ratingSummary.distribution[star] || 0;
                        const pct = ratingSummary.totalReviews > 0 ? Math.round((count / ratingSummary.totalReviews) * 100) : 0;
                        return (
                          <div key={star} className="flex items-center gap-2 text-xs">
                            <span className="w-10 text-muted-foreground font-medium shrink-0">{star} star</span>
                            <div className="flex-1 h-2 rounded-full bg-muted overflow-hidden border border-border/40">
                              <div
                                className="h-full bg-amber-400 rounded-full transition-all duration-300"
                                style={{ width: `${pct}%` }}
                                role="progressbar"
                                aria-valuenow={pct}
                                aria-valuemin={0}
                                aria-valuemax={100}
                              />
                            </div>
                            <span className="w-6 text-right tnum text-muted-foreground shrink-0">{count}</span>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </CardContent>
              </Card>
            ) : null}

            {/* Verified Purchase Requirement Notice */}
            {isAuthenticated && reviewEligibility && !reviewEligibility.hasPurchased && (
              <div
                className="flex items-start gap-2.5 rounded-lg border border-amber-500/30 bg-amber-50/50 dark:bg-amber-950/20 p-3.5 text-xs text-amber-900 dark:text-amber-200"
                data-testid="verified-purchase-restriction"
              >
                <ShieldCheck className="size-4 shrink-0 text-amber-600 dark:text-amber-400 mt-0.5" aria-hidden />
                <div>
                  <p className="font-semibold">Verified purchase required</p>
                  <p className="mt-0.5 text-amber-800/90 dark:text-amber-300/80">
                    You can only review products that you have purchased and received. Once your order is completed, you will be eligible to leave a review.
                  </p>
                </div>
              </div>
            )}

            {/* Already Reviewed Notice with Edit action */}
            {isAuthenticated && reviewEligibility?.alreadyReviewed && !isWritingReview && (
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-muted/40 p-3 text-xs">
                <div className="flex items-center gap-2">
                  <Check className="size-4 text-emerald-600" aria-hidden />
                  <span className="font-medium text-foreground">You have already submitted a review for this product.</span>
                </div>
                {reviewEligibility.existingReviewId && (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 text-xs"
                    onClick={() => {
                      const own = reviews.find((r) => r.id === reviewEligibility.existingReviewId);
                      if (own) handleStartEdit(own);
                      else handleStartWrite();
                    }}
                  >
                    <Edit3 className="size-3.5 mr-1" aria-hidden />
                    Edit Review
                  </Button>
                )}
              </div>
            )}

            {/* Success notification banner */}
            {reviewSuccess && (
              <div className="flex items-center justify-between rounded-lg border border-emerald-500/30 bg-emerald-50/60 dark:bg-emerald-950/20 p-3 text-xs text-emerald-900 dark:text-emerald-200">
                <div className="flex items-center gap-2">
                  <Check className="size-4 text-emerald-600" />
                  <span>{reviewSuccess}</span>
                </div>
                <button onClick={() => setReviewSuccess(null)} className="text-emerald-700 hover:text-emerald-900 p-1">
                  <X className="size-3.5" />
                </button>
              </div>
            )}

            {/* Write / Edit Review Form */}
            {isWritingReview && (
              <Card className="border border-primary/20 shadow-sm" data-testid="write-review-form">
                <CardHeader className="pb-3">
                  <div className="flex items-center justify-between">
                    <div>
                      <CardTitle className="text-sm font-semibold">
                        {editingReviewId ? 'Edit Your Review' : 'Write a Product Review'}
                      </CardTitle>
                      <CardDescription className="text-xs">
                        Share your honest experience to help other customers.
                      </CardDescription>
                    </div>
                    <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={handleCancelReview}>
                      <X className="size-4" />
                    </Button>
                  </div>
                </CardHeader>
                <CardContent>
                  <form onSubmit={handleSubmitReview} className="space-y-4">
                    {/* Star Rating Selection */}
                    <div>
                      <label className="block text-xs font-medium text-foreground mb-1.5">
                        Overall Rating <span className="text-destructive">*</span>
                      </label>
                      <div className="flex items-center gap-1.5" role="radiogroup" aria-label="Rating">
                        {[1, 2, 3, 4, 5].map((star) => (
                          <button
                            type="button"
                            key={star}
                            onClick={() => setReviewRating(star)}
                            className={cn(
                              "p-1.5 rounded hover:bg-muted transition-colors focus:outline-none focus:ring-2 focus:ring-primary",
                              reviewRating >= star ? "text-amber-400" : "text-border"
                            )}
                            aria-label={`${star} star${star > 1 ? 's' : ''}`}
                            data-testid={`rating-star-${star}`}
                          >
                            <Star
                              className={cn(
                                "size-6",
                                reviewRating >= star ? "fill-amber-400" : "fill-none"
                              )}
                            />
                          </button>
                        ))}
                        <span className="ml-2 text-xs font-semibold text-foreground">
                          {reviewRating === 5 ? '5 - Excellent' :
                           reviewRating === 4 ? '4 - Good' :
                           reviewRating === 3 ? '3 - Average' :
                           reviewRating === 2 ? '2 - Poor' : '1 - Terrible'}
                        </span>
                      </div>
                    </div>

                    {/* Review Title */}
                    <div>
                      <label htmlFor="review-title" className="block text-xs font-medium text-foreground mb-1">
                        Review Title (Optional)
                      </label>
                      <input
                        id="review-title"
                        type="text"
                        maxLength={200}
                        placeholder="e.g. Fantastic sound and battery life!"
                        value={reviewTitle}
                        onChange={(e) => setReviewTitle(e.target.value)}
                        className="w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        data-testid="review-title-input"
                      />
                    </div>

                    {/* Review Comment */}
                    <div>
                      <label htmlFor="review-comment" className="block text-xs font-medium text-foreground mb-1">
                        Review Details <span className="text-destructive">*</span>
                      </label>
                      <textarea
                        id="review-comment"
                        rows={4}
                        required
                        minLength={3}
                        maxLength={2000}
                        placeholder="What did you like or dislike? How does it perform?"
                        value={reviewComment}
                        onChange={(e) => setReviewComment(e.target.value)}
                        className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        data-testid="review-comment-input"
                      />
                      <p className="mt-1 text-[11px] text-muted-foreground text-right">
                        {reviewComment.length}/2000 characters (minimum 3)
                      </p>
                    </div>

                    {reviewError && (
                      <div className="flex items-center gap-2 rounded-md bg-destructive/10 p-2.5 text-xs text-destructive">
                        <AlertCircle className="size-4 shrink-0" />
                        <span>{reviewError}</span>
                      </div>
                    )}

                    <div className="flex items-center justify-end gap-2 pt-1">
                      <Button type="button" variant="outline" size="sm" onClick={handleCancelReview}>
                        Cancel
                      </Button>
                      <Button type="submit" size="sm" disabled={isSubmittingReview} data-testid="submit-review-button">
                        {isSubmittingReview ? "Submitting…" : editingReviewId ? "Save Changes" : "Submit Review"}
                      </Button>
                    </div>
                  </form>
                </CardContent>
              </Card>
            )}

            {/* Reviews List */}
            {isLoadingReviews ? (
              <div className="mt-2 flex flex-col gap-2" aria-label="Loading reviews">
                <Skeleton className="h-20" />
                <Skeleton className="h-20" />
              </div>
            ) : reviews.length === 0 ? (
              <div className="rounded-lg border border-dashed border-border p-6 text-center" data-testid="empty-reviews">
                <MessageSquareText className="mx-auto size-8 text-muted-foreground/60 mb-2" />
                <p className="text-sm font-medium text-foreground">No customer reviews yet</p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Be the first verified customer to share your thoughts about this product!
                </p>
              </div>
            ) : (
              <ul className="flex flex-col gap-3" data-testid="reviews-list">
                {reviews.map((r) => (
                  <li key={r.id} className="rounded-lg border border-border p-4 bg-card space-y-2">
                    <div className="flex items-center justify-between gap-2 flex-wrap">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="flex items-center gap-0.5 text-xs" aria-label={`${r.rating} out of 5 stars`}>
                          {Array.from({ length: 5 }).map((_, i) => (
                            <Star
                              key={i}
                              className={cn(
                                "size-3.5",
                                i < r.rating ? "fill-amber-400 text-amber-400" : "text-border"
                              )}
                              aria-hidden
                            />
                          ))}
                        </span>
                        {r.verifiedPurchase && (
                          <span className="inline-flex items-center gap-1 text-[11px] font-medium text-emerald-700 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-950/40 px-2 py-0.5 rounded-full border border-emerald-200 dark:border-emerald-800">
                            <ShieldCheck className="size-3" />
                            Verified Purchase
                          </span>
                        )}
                        {r.status && r.status !== 'APPROVED' && (
                          <Badge variant={r.status === 'PENDING' ? 'outline' : 'destructive'} className="text-[10px]">
                            {r.status === 'PENDING' ? 'Pending Moderation' : 'Rejected'}
                          </Badge>
                        )}
                      </div>
                      <div className="flex items-center gap-2">
                        {r.reviewedAt && (
                          <span className="text-xs text-muted-foreground">
                            {new Date(r.reviewedAt).toLocaleDateString()}
                          </span>
                        )}
                        {user?.userId && r.customerId === user.userId && (
                          <div className="flex items-center gap-1 ml-2">
                            <button
                              onClick={() => handleStartEdit(r)}
                              className="text-muted-foreground hover:text-foreground p-1 transition-colors"
                              title="Edit review"
                              aria-label="Edit review"
                            >
                              <Edit3 className="size-3.5" />
                            </button>
                            <button
                              onClick={() => handleDeleteReview(r.id)}
                              className="text-muted-foreground hover:text-destructive p-1 transition-colors"
                              title="Delete review"
                              aria-label="Delete review"
                            >
                              <Trash2 className="size-3.5" />
                            </button>
                          </div>
                        )}
                      </div>
                    </div>
                    {r.title && <h3 className="text-sm font-semibold text-foreground">{r.title}</h3>}
                    {r.comment && <p className="text-xs sm:text-[13px] text-foreground/90 leading-relaxed">{r.comment}</p>}
                    {r.reviewerName && (
                      <p className="text-xs text-muted-foreground">— {r.reviewerName}</p>
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
              <div className="space-y-4">
                <div className="rounded-lg border border-border p-4 bg-muted/20 space-y-3">
                  <div className="flex items-center gap-2">
                    <Badge variant="warning" className="text-xs font-semibold px-2.5 py-0.5">
                      Out of Stock
                    </Badge>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    This item is currently out of stock or unavailable from sellers.
                  </p>

                  <div className="pt-1">
                    {isSubscribedStock ? (
                      <div className="space-y-2">
                        <div
                          className="flex items-center gap-1.5 text-xs font-medium text-emerald-600 dark:text-emerald-400"
                          data-testid="stock-subscribed-message"
                        >
                          <Check className="size-4 shrink-0" />
                          <span>You'll be notified when this product is back in stock.</span>
                        </div>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={handleCancelStockSubscription}
                          disabled={isLoadingStockSub}
                          id="cancel-notification-button"
                          data-testid="cancel-notification-button"
                        >
                          {isLoadingStockSub ? "Cancelling…" : "Cancel notification"}
                        </Button>
                      </div>
                    ) : (
                      <div className="space-y-2">
                        <Button
                          variant="default"
                          size="sm"
                          onClick={handleSubscribeStock}
                          disabled={isLoadingStockSub}
                          id="notify-me-button"
                          data-testid="notify-me-button"
                          className="gap-1.5"
                        >
                          <Bell className="size-4" />
                          {isLoadingStockSub ? "Subscribing…" : "Notify me when available"}
                        </Button>
                      </div>
                    )}

                    {stockSubError && (
                      <div className="mt-2 flex items-center gap-1.5 text-xs text-destructive" data-testid="stock-sub-error">
                        <AlertCircle className="size-3.5 shrink-0" />
                        <span>{stockSubError}</span>
                      </div>
                    )}
                    {stockSubFeedback && !isSubscribedStock && (
                      <div className="mt-2 text-xs text-emerald-600 dark:text-emerald-400 font-medium">
                        {stockSubFeedback}
                      </div>
                    )}
                  </div>
                </div>

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
                            await addItem(listing.id, 1, {
                              skuId: listing.skuId,
                              merchantTenantId: listing.tenantId,
                              unitPriceAmount: listing.priceAmount,
                              currency: listing.currency,
                              productTitle: product?.title ?? null,
                              productThumbnailUrl: product?.thumbnailUrl ?? null,
                            });
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
