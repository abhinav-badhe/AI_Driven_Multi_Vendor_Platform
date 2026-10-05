import { TrendingDown, TrendingUp, Minus } from "lucide-react";
import { Card, CardContent } from "./card";

// KPI card: label (small, muted) → value (large, one weight heavier) →
// delta (small, semantic color only). No gradient/shadow treatment.
export function KpiCard({
  label,
  value,
  delta,
  direction,
  hint,
}: {
  label: string;
  value: string;
  delta?: string;
  direction?: "up" | "down" | "flat";
  hint?: string;
}) {
  const Icon = direction === "up" ? TrendingUp : direction === "down" ? TrendingDown : Minus;
  const tone =
    direction === "up"
      ? "text-success"
      : direction === "down"
        ? "text-destructive"
        : "text-muted-foreground";
  return (
    <Card>
      <CardContent className="p-4">
        <p className="text-xs text-muted-foreground">{label}</p>
        <p className="tnum mt-1 text-xl font-semibold tracking-tight">{value}</p>
        {(delta || hint) && (
          <p className="mt-1 flex items-center gap-1 text-xs text-muted-foreground">
            {direction && <Icon className={`size-3.5 ${tone}`} aria-hidden />}
            {delta && <span className={tone}>{delta}</span>}
            {hint && <span>{hint}</span>}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
