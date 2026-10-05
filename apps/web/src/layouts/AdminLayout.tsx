import { Link, Navigate } from "react-router-dom";
import { useAuth } from "../features/auth/AuthContext";
import { SidebarShell, adminNav } from "../components/layout/AppShell";
import { buttonVariants } from "../components/ui/button";
import { cn } from "../lib/utils";

export const AdminLayout = () => {
  const { isAuthenticated, user, isLoading } = useAuth();

  if (isLoading) {
    return <div className="p-4 text-sm text-muted-foreground">Loading…</div>;
  }

  if (!isAuthenticated || user?.role !== "ADMINISTRATOR") {
    return <Navigate to="/account" replace />;
  }

  return (
    <SidebarShell
      title="Admin"
      items={adminNav}
      topbarRight={
        <Link to="/" className={cn(buttonVariants({ size: "sm" }))}>
          View storefront
        </Link>
      }
    />
  );
};
