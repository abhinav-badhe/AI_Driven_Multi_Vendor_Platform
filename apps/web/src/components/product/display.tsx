import { Star, StarHalf } from 'lucide-react';

// Display content carried inside search/catalog `attributes` JSONB
// (thumbnailUrl, images, rating, reviewCount, tags). Centralized here so
// every surface reads the same fields with the same fallbacks.
export interface ProductDisplay {
  thumbnailUrl?: string | null;
  images: string[];
  rating?: number | null;
  reviewCount: number;
  tags: string[];
}

export function getDisplay(attributes: Record<string, unknown> | null | undefined): ProductDisplay {
  const a = attributes ?? {};
  const pick = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
  const rawImages = a.images;
  const images = Array.isArray(rawImages)
    ? rawImages.filter((v): v is string => typeof v === 'string')
    : [];
  const rawTags = a.tags;
  const tags = Array.isArray(rawTags)
    ? rawTags.filter((v): v is string => typeof v === 'string')
    : [];
  const rating = typeof a.rating === 'number' ? a.rating : null;
  const reviewCount = typeof a.reviewCount === 'number' ? a.reviewCount : 0;
  const thumbnailUrl = pick(a.thumbnailUrl) ?? images[0] ?? null;
  return {
    thumbnailUrl,
    images: images.length > 0 ? images : thumbnailUrl ? [thumbnailUrl] : [],
    rating,
    reviewCount,
    tags,
  };
}

export function discountPercent(price: number, compareAt?: number | null): number | null {
  if (!compareAt || compareAt <= price) return null;
  return Math.round((1 - price / compareAt) * 100);
}

// Compact rating row: star + value + count. Null-safe (renders nothing).
export function Rating({
  rating,
  reviewCount,
}: {
  rating?: number | null | undefined;
  reviewCount?: number | undefined;
}) {
  if (rating == null) return null;
  return (
    <span
      className="flex items-center gap-1 text-xs text-muted-foreground"
      aria-label={`Rated ${rating} out of 5`}
    >
      {rating >= 4.5 ? (
        <Star className="size-3.5 fill-warning text-warning" aria-hidden />
      ) : rating >= 2.5 ? (
        <StarHalf className="size-3.5 text-warning" aria-hidden />
      ) : (
        <Star className="size-3.5 text-warning" aria-hidden />
      )}
      <span className="tnum font-medium text-foreground">{rating.toFixed(1)}</span>
      {reviewCount !== undefined && reviewCount > 0 && <span>({reviewCount})</span>}
    </span>
  );
}
