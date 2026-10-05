import { Link, Navigate } from "react-router-dom";
import { useAuth } from "../features/auth/AuthContext";
import { SidebarShell, merchantNav } from "../components/layout/AppShell";
import { buttonVariants } from "../components/ui/button";
import { cn } from "../lib/utils";

export const MerchantLayout = () => {
  const { isAuthenticated, user, isLoading } = useAuth();

  if (isLoading) {
    return <div className="p-4 text-sm text-muted-foreground">Loading…</div>;
  }

  if (!isAuthenticated || user?.role !== "MERCHANT") {
    return <Navigate to="/account" replace />;
  }

  return (
    <SidebarShell
      title="Seller hub"
      items={merchantNav}
      topbarRight={
        <Link to="/" className={cn(buttonVariants({ size: "sm" }))}>
          View storefront
        </Link>
      }
    />
  );
};
