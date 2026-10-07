import { Link } from "react-router-dom";
import { Minus, Plus } from "lucide-react";
import { Card, CardContent } from "../ui/card";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Rating, discountPercent } from "./display";
import { prefetch } from "../../api/client";

// Shared product card — one consistent treatment everywhere a product is
// listed (home, search). Dense and sleek: 4:3 image with overlaid discount,
// 13px type, single metadata line. Pinned test strings preserved
// ("In Stock", seller offers).
export function StockBadge({ inStock }: { inStock: boolean }) {
  return (
    <Badge variant={inStock ? "success" : "outline"}>
      {inStock ? "In Stock" : "Out of Stock"}
    </Badge>
  );
}

export function QtyControl({
  quantity,
  onDecrease,
  onIncrease,
  disabled,
  small,
}: {
  quantity: number;
  onDecrease: () => void;
  onIncrease: () => void;
  disabled?: boolean;
  small?: boolean;
}) {
  return (
    <div className="inline-flex items-center rounded-md border border-border">
      <Button
        variant="ghost"
        size="icon"
        className={small ? "h-6 w-6" : "h-7 w-7"}
        aria-label="Decrease quantity"
        disabled={disabled}
        onClick={onDecrease}
      >
        <Minus />
      </Button>
      <span className="tnum min-w-6 text-center text-[13px] font-semibold">{quantity}</span>
      <Button
        variant="ghost"
        size="icon"
        className={small ? "h-6 w-6" : "h-7 w-7"}
        aria-label="Increase quantity"
        disabled={disabled}
        onClick={onIncrease}
      >
        <Plus />
      </Button>
    </div>
  );
}

export function ProductCard({
  productId,
  title,
  brand,
  categoryName,
  priceLabel,
  compareAtLabel,
  compareAtPrice,
  price,
  offerCount,
  inStock,
  thumbnailUrl,
  rating,
  reviewCount,
  action,
}: {
  productId: string;
  title: string;
  brand?: string | null | undefined;
  categoryName?: string | null | undefined;
  merchantName?: string | null | undefined;
  priceLabel: string;
  compareAtLabel?: string | null | undefined;
  compareAtPrice?: number | null | undefined;
  price?: number | null | undefined;
  offerCount?: number;
  inStock: boolean;
  thumbnailUrl?: string | null | undefined;
  rating?: number | null | undefined;
  reviewCount?: number | undefined;
  action: React.ReactNode;
}) {
  const off = price != null ? discountPercent(price, compareAtPrice) : null;
  // Hover/keyboard intent warms the product page's critical data so the
  // navigation lands on an already-cached view.
  const warmDetail = () => {
    prefetch(`/products/${productId}`);
    prefetch(`/products/${productId}/skus`);
  };
  return (
    <Card className="overflow-hidden" onMouseEnter={warmDetail} onFocus={warmDetail}>
      <CardContent className="flex flex-col gap-1.5 p-3">
        {thumbnailUrl && (
          <Link
            to={`/product/${productId}`}
            className="relative block overflow-hidden rounded-md border border-border bg-muted"
            aria-label={`View ${title}`}
          >
            <img
              src={thumbnailUrl}
              alt=""
              loading="lazy"
              className="aspect-[4/3] w-full object-cover transition-transform duration-150 hover:scale-[1.03]"
            />
            {off != null && (
              <Badge variant="warning" className="absolute left-1.5 top-1.5 shadow-sm">
                {off}% off
              </Badge>
            )}
          </Link>
        )}
        <div className="flex items-center justify-between gap-2">
          <StockBadge inStock={inStock} />
          {offerCount !== undefined && (
            <span className="tnum text-xs text-muted-foreground">
              {offerCount} {offerCount === 1 ? "seller offer" : "seller offers"}
            </span>
          )}
        </div>
        <div className="min-w-0">
          <Link
            to={`/product/${productId}`}
            className="line-clamp-2 min-h-8 text-[13px] font-medium leading-snug hover:underline"
          >
            {title}
          </Link>
          <p className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
            {brand && <span className="truncate">{brand}</span>}
            {categoryName && <span className="truncate">In {categoryName}</span>}
            <Rating rating={rating} reviewCount={reviewCount} />
          </p>
        </div>
        <div className="mt-auto flex items-end justify-between gap-2 border-t border-border pt-2">
          <div className="min-w-0">
            <p className="tnum truncate text-[15px] font-semibold">{priceLabel}</p>
            {compareAtLabel && (
              <p className="tnum truncate text-xs text-muted-foreground line-through">{compareAtLabel}</p>
            )}
          </div>
          <div className="shrink-0">{action}</div>
        </div>
      </CardContent>
    </Card>
  );
}
