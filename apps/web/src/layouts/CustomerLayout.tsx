import { useState, type FormEvent } from "react";
import { Link, Outlet, useNavigate } from "react-router-dom";
import { Heart, Search, ShoppingCart, User } from "lucide-react";
import { useCart } from "../features/cart/CartContext";
import { useAuth } from "../features/auth/AuthContext";
import { AiAssistant } from "../features/ai/AiAssistant";
import { Button, buttonVariants } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Badge } from "../components/ui/badge";
import { cn } from "../lib/utils";

// Compact storefront topbar: utilitarian, left-aligned, no hero nav.
export const CustomerLayout = () => {
  const { itemCount } = useCart();
  const { isAuthenticated, user, logout, login } = useAuth();
  const [navSearch, setNavSearch] = useState("");
  const navigate = useNavigate();

  const handleNavSearch = (e: FormEvent) => {
    e.preventDefault();
    if (navSearch.trim()) {
      navigate(`/search?q=${encodeURIComponent(navSearch.trim())}`);
    } else {
      navigate("/search");
    }
  };

  return (
    <div className="flex min-h-screen flex-col bg-background text-foreground">
      <header className="sticky top-0 z-30 border-b border-border bg-background">
        <div className="mx-auto flex h-12 w-full max-w-6xl items-center gap-3 px-3 md:px-4">
          <Link to="/" className="shrink-0 text-sm font-semibold tracking-tight">
            Commerce
          </Link>

          <form onSubmit={handleNavSearch} className="relative min-w-0 max-w-md flex-1" role="search">
            <Search
              className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
              aria-hidden
            />
            <Input
              type="search"
              aria-label="Search products"
              placeholder="Search products, brands, categories"
              value={navSearch}
              onChange={(e) => setNavSearch(e.target.value)}
              className="pl-8"
            />
          </form>

          <div className="ml-auto flex shrink-0 items-center gap-1.5">
            {isAuthenticated && (
              <>
                <Link to="/orders" className={cn(buttonVariants({ variant: "ghost", size: "sm" }))}>
                  Orders
                </Link>
                <Link to="/returns" className={cn(buttonVariants({ variant: "ghost", size: "sm" }))}>
                  Returns
                </Link>
              </>
            )}
            {user?.role === "MERCHANT" && (
              <Link to="/merchant" className={cn(buttonVariants({ variant: "ghost", size: "sm" }))}>
                Seller hub
              </Link>
            )}
            {user?.role === "ADMINISTRATOR" && (
              <Link to="/admin" className={cn(buttonVariants({ variant: "ghost", size: "sm" }))}>
                Admin
              </Link>
            )}
            <Link to="/wishlist" className={cn(buttonVariants({ variant: "ghost", size: "sm" }))}>
              <Heart aria-hidden />
              Wishlist
            </Link>
            <Link to="/cart" className={cn(buttonVariants({ variant: "outline", size: "sm" }))}>
              <ShoppingCart aria-hidden />
              Cart
              {itemCount > 0 && <Badge variant="default">{itemCount}</Badge>}
            </Link>
            {isAuthenticated ? (
              <>
                <Link
                  to="/account"
                  className={cn(buttonVariants({ variant: "ghost", size: "sm" }), "max-w-40")}
                >
                  <User aria-hidden />
                  <span className="truncate">{user?.email}</span>
                </Link>
                {user?.role === "MERCHANT" && (
                  <Link to="/merchant" className={cn(buttonVariants({ variant: "outline", size: "sm" }))}>
                    Merchant Portal
                  </Link>
                )}
                {user?.role === "ADMINISTRATOR" && (
                  <Link to="/admin" className={cn(buttonVariants({ variant: "outline", size: "sm" }))}>
                    Admin Console
                  </Link>
                )}
                <Button variant="ghost" size="sm" onClick={() => logout()}>
                  Log out
                </Button>
              </>
            ) : (
              <>
                <div className="hidden items-center gap-1 md:flex">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-xs h-7 px-2 border border-dashed border-border"
                    onClick={async () => {
                      await login({ email: "customer@example.com", password: "password123" });
                    }}
                  >
                    Demo Customer
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-xs h-7 px-2 border border-dashed border-border"
                    onClick={async () => {
                      await login({ email: "merchant@example.com", password: "password123" });
                      navigate("/merchant");
                    }}
                  >
                    Demo Merchant
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-xs h-7 px-2 border border-dashed border-primary/40 text-primary font-medium"
                    onClick={async () => {
                      await login({ email: "leonsintegration@gmail.com", password: "Password@2163" });
                      navigate("/admin");
                    }}
                  >
                    Demo Admin
                  </Button>
                </div>
                <Link to="/account" className={cn(buttonVariants({ size: "sm" }))}>
                  Sign in
                </Link>
              </>
            )}
          </div>
        </div>
      </header>

      <main className="flex-1">
        <Outlet />
      </main>

      <AiAssistant />
    </div>
  );
};
