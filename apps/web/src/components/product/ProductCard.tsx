import { Link } from "react-router-dom";
import { Minus, Plus } from "lucide-react";
import { Card, CardContent } from "../ui/card";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";

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
  offerCount,
  inStock,
  action,
}: {
  productId: string;
  title: string;
  brand?: string | null | undefined;
  categoryName?: string | null | undefined;
  merchantName?: string | null | undefined;
  priceLabel: string;
  offerCount?: number;
  inStock: boolean;
  action: React.ReactNode;
}) {
  return (
    <Card>
      <CardContent className="flex flex-col gap-2 p-4">
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
          {categoryName && (
            <p className="mt-0.5 text-xs text-muted-foreground">In {categoryName}</p>
          )}
          {merchantName && (
            <p className="mt-0.5 text-xs text-muted-foreground">Sold by {merchantName}</p>
          )}
        </div>
        <div className="mt-auto flex items-center justify-between gap-2 border-t border-border pt-2.5">
          <p className="tnum text-base font-semibold">{priceLabel}</p>
          {action}
        </div>
      </CardContent>
    </Card>
  );
}
