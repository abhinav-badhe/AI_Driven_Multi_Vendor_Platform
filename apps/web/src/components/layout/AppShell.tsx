import { useState } from "react";
import { Link, NavLink, Outlet } from "react-router-dom";
import {
  LayoutDashboard,
  Package,
  Boxes,
  ShoppingCart,
  Truck,
  RotateCcw,
  Wallet,
  BarChart3,
  Settings,
  Store,
  Users,
  BookOpen,
  Layers,
  CreditCard,
  ArrowLeftRight,
  Activity,
  ShieldCheck,
  Menu,
  X,
  type LucideIcon,
} from "lucide-react";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";

export interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  end?: boolean;
}

export const merchantNav: NavItem[] = [
  { to: "/merchant", label: "Dashboard", icon: LayoutDashboard, end: true },
  { to: "/merchant/listings", label: "Listings", icon: Package },
  { to: "/merchant/inventory", label: "Inventory", icon: Boxes },
  { to: "/merchant/orders", label: "Orders", icon: ShoppingCart },
  { to: "/merchant/fulfillment", label: "Fulfillment", icon: Truck },
  { to: "/merchant/returns", label: "Returns", icon: RotateCcw },
  { to: "/merchant/finance", label: "Finance", icon: Wallet },
  { to: "/merchant/analytics", label: "Analytics", icon: BarChart3 },
  { to: "/merchant/onboarding", label: "Store setup", icon: Store },
  { to: "/merchant/settings", label: "Settings", icon: Settings },
];

export const adminNav: NavItem[] = [
  { to: "/admin", label: "Dashboard", icon: LayoutDashboard, end: true },
  { to: "/admin/users", label: "Users", icon: Users },
  { to: "/admin/merchants", label: "Merchants", icon: Store },
  { to: "/admin/catalog", label: "Catalog", icon: BookOpen },
  { to: "/admin/listings", label: "Listings", icon: Layers },
  { to: "/admin/inventory", label: "Inventory", icon: Boxes },
  { to: "/admin/orders", label: "Orders", icon: ShoppingCart },
  { to: "/admin/payments", label: "Payments", icon: CreditCard },
  { to: "/admin/settlements", label: "Settlements", icon: ArrowLeftRight },
  { to: "/admin/events", label: "Events", icon: Activity },
  { to: "/admin/security", label: "Security", icon: ShieldCheck },
  { to: "/admin/analytics", label: "Telemetry", icon: BarChart3 },
];

// Compact fixed sidebar (icon + label), drawer on mobile (STYLE.md §6).
export function SidebarShell({
  title,
  items,
  topbarRight,
  children,
}: {
  title: string;
  items: NavItem[];
  topbarRight?: React.ReactNode;
  children?: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);

  const nav = (
    <nav aria-label="Primary" className="flex flex-col gap-0.5 p-2">
      {items.map((item) => (
        <NavLink
          key={item.to}
          to={item.to}
          end={item.end === true}
          onClick={() => setOpen(false)}
          className={({ isActive }) =>
            cn(
              "flex items-center gap-2 rounded-md px-2.5 py-1.5 text-[13px] font-medium",
              isActive
                ? "bg-secondary text-foreground"
                : "text-muted-foreground hover:bg-muted hover:text-foreground"
            )
          }
        >
          <item.icon className="size-4 shrink-0" aria-hidden />
          {item.label}
        </NavLink>
      ))}
    </nav>
  );

  return (
    <div className="flex min-h-screen bg-background text-foreground">
      {/* Desktop sidebar */}
      <aside className="hidden w-52 shrink-0 border-r border-border md:flex md:flex-col">
        <div className="flex h-12 items-center border-b border-border px-3">
          <Link to="/" className="text-sm font-semibold tracking-tight">
            {title}
          </Link>
        </div>
        <div className="flex-1 overflow-y-auto">{nav}</div>
      </aside>

      {/* Mobile drawer */}
      {open && (
        <div className="fixed inset-0 z-40 md:hidden">
          <div
            className="absolute inset-0 bg-black/40"
            onClick={() => setOpen(false)}
            aria-hidden
          />
          <aside className="absolute left-0 top-0 flex h-full w-60 flex-col bg-background shadow-md">
            <div className="flex h-12 items-center justify-between border-b border-border px-3">
              <span className="text-sm font-semibold">{title}</span>
              <Button variant="ghost" size="icon" onClick={() => setOpen(false)} aria-label="Close menu">
                <X />
              </Button>
            </div>
            <div className="flex-1 overflow-y-auto">{nav}</div>
          </aside>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        {/* Compact utilitarian topbar */}
        <header className="flex h-12 items-center gap-2 border-b border-border px-3 md:px-4">
          <Button
            variant="ghost"
            size="icon"
            className="md:hidden"
            onClick={() => setOpen(true)}
            aria-label="Open menu"
          >
            <Menu />
          </Button>
          <div className="min-w-0 flex-1" />
          {topbarRight}
        </header>
        <main className="min-w-0 flex-1">
          <Outlet />
          {children}
        </main>
      </div>
    </div>
  );
}
