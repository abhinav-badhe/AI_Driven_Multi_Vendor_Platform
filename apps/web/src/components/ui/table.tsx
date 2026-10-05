import * as React from "react";
import { cn } from "../../lib/utils";

// Dense product table: compact rows, left-aligned, 13px body (STYLE.md §4.6, §6).
export function Table({ className, ...props }: React.TableHTMLAttributes<HTMLTableElement>) {
  return (
    <div className="overflow-x-auto rounded-lg border border-border">
      <table className={cn("w-full text-left text-[13px]", className)} {...props} />
    </div>
  );
}

export function THead(props: React.HTMLAttributes<HTMLTableSectionElement>) {
  return <thead className="bg-muted" {...props} />;
}

export function TH({ className, ...props }: React.ThHTMLAttributes<HTMLTableCellElement>) {
  return (
    <th
      className={cn("px-3 py-2 text-xs font-medium text-muted-foreground", className)}
      {...props}
    />
  );
}

export function TD({ className, ...props }: React.TdHTMLAttributes<HTMLTableCellElement>) {
  return <td className={cn("border-t border-border px-3 py-2 align-middle", className)} {...props} />;
}
