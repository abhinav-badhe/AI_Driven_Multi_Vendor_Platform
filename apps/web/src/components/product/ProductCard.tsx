import { Link } from "react-router-dom";
import { Minus, Plus } from "lucide-react";
import { Card, CardContent } from "../ui/card";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Rating, discountPercent } from "./display";

// Shared product card — one consistent treatment everywhere a product is
// listed (home, search, category). Compact, left-aligned, border-only,
// 13–14px type. Pinned test strings preserved ("In Stock", seller offers).
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
  merchantName,
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
  return (
    <Card>
      <CardContent className="flex flex-col gap-2 p-4">
        {thumbnailUrl && (
          <Link
            to={`/product/${productId}`}
            className="block overflow-hidden rounded-md border border-border"
            aria-label={`View ${title}`}
          >
            <img
              src={thumbnailUrl}
              alt=""
              loading="lazy"
              className="aspect-square w-full object-cover"
            />
          </Link>
        )}
        <div className="flex items-center justify-between gap-2">
          <StockBadge inStock={inStock} />
          {offerCount !== undefined && (
            <span className="text-xs text-muted-foreground">
              {offerCount} {offerCount === 1 ? "seller offer" : "seller offers"}
            </span>
          )}
        </div>
        <div>
          {brand && <p className="text-xs text-muted-foreground">{brand}</p>}
          <Link
            to={`/product/${productId}`}
            className="text-sm font-medium leading-snug hover:underline"
          >
            {title}
          </Link>
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5">
            <Rating rating={rating} reviewCount={reviewCount} />
            {off != null && (
              <Badge variant="warning">{off}% off</Badge>
            )}
          </div>
          {categoryName && (
            <p className="mt-0.5 text-xs text-muted-foreground">In {categoryName}</p>
          )}
          {merchantName && (
            <p className="mt-0.5 text-xs text-muted-foreground">Sold by {merchantName}</p>
          )}
        </div>
        <div className="mt-auto flex items-center justify-between gap-2 border-t border-border pt-2.5">
          <div>
            <p className="tnum text-base font-semibold">{priceLabel}</p>
            {compareAtLabel && (
              <p className="tnum text-xs text-muted-foreground line-through">{compareAtLabel}</p>
            )}
          </div>
          {action}
        </div>
      </CardContent>
    </Card>
  );
}
