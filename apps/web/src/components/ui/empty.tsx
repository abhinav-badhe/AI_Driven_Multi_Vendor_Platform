import type { LucideIcon } from "lucide-react";
import { Button } from "./button";

// Empty states are an instruction + one action (STYLE.md §5).
export function EmptyState({
  icon: Icon,
  title,
  description,
  actionLabel,
  onAction,
}: {
  icon: LucideIcon;
  title: string;
  description: string;
  actionLabel?: string;
  onAction?: () => void;
}) {
  return (
    <div className="flex flex-col items-start gap-2 rounded-lg border border-border p-6">
      <Icon className="size-5 text-muted-foreground" aria-hidden />
      <p className="text-sm font-semibold">{title}</p>
      <p className="max-w-[60ch] text-[13px] text-muted-foreground">{description}</p>
      {actionLabel && onAction && (
        <Button size="sm" className="mt-1" onClick={onAction}>
          {actionLabel}
        </Button>
      )}
    </div>
  );
}

export function Skeleton({ className = "" }: { className?: string }) {
  return <div aria-hidden className={`animate-pulse rounded-md bg-muted ${className}`} />;
}

// Skeleton shaped like real content, not a generic spinner (STYLE.md §6).
export function TableSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <div className="rounded-lg border border-border" aria-label="Loading">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="flex gap-3 border-b border-border px-3 py-2.5 last:border-0">
          <Skeleton className="h-4 w-1/4" />
          <Skeleton className="h-4 w-1/3" />
          <Skeleton className="h-4 w-20" />
        </div>
      ))}
    </div>
  );
}
