import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { AuthProvider } from '../features/auth/AuthContext';
import { CartProvider } from '../features/cart/CartContext';
import { CustomerLayout } from '../layouts/CustomerLayout';
import { MerchantLayout } from '../layouts/MerchantLayout';
import { AdminLayout } from '../layouts/AdminLayout';

import { AccountPage } from '../features/auth/AccountPage';
import { VerifyEmailPage } from '../features/auth/VerifyEmailPage';

import { Home } from '../features/home/Home';
import { CategoryPage } from '../features/catalog/Category';
import { ProductPage } from '../features/catalog/Product';
import { SearchPage } from '../features/search/SearchPage';
import { CartPage } from '../features/cart/CartPage';
import { CheckoutPage } from '../features/checkout/CheckoutPage';
import { CustomerOrders } from '../features/orders/CustomerOrders';
import { CustomerReturns } from '../features/orders/CustomerReturns';

import { MerchantDashboard } from '../features/merchant/MerchantDashboard';
import { MerchantListings } from '../features/merchant/MerchantListings';
import { MerchantInventory } from '../features/merchant/MerchantInventory';
import { MerchantOrders } from '../features/merchant/MerchantOrders';
import { MerchantOnboarding } from '../features/merchant/MerchantOnboarding';
import { MerchantFinance } from '../features/merchant/MerchantFinance';
import { MerchantFulfillment } from '../features/merchant/MerchantFulfillment';
import { MerchantReturns } from '../features/merchant/MerchantReturns';
import { MerchantSettings } from '../features/merchant/MerchantSettings';

import { AdminDashboard } from '../features/admin/AdminDashboard';
import { AdminMerchants } from '../features/admin/AdminMerchants';
import { AdminSettlements } from '../features/admin/AdminSettlements';
import { AdminUsers } from '../features/admin/AdminUsers';
import { AdminCatalog } from '../features/admin/AdminCatalog';
import { AdminListings } from '../features/admin/AdminListings';
import { AdminInventory } from '../features/admin/AdminInventory';
import { AdminOrders } from '../features/admin/AdminOrders';
import { AdminPayments } from '../features/admin/AdminPayments';
import { AdminEvents } from '../features/admin/AdminEvents';
import { AdminSecurity } from '../features/admin/AdminSecurity';
import { AnalyticsDashboard } from '../features/analytics/AnalyticsDashboard';
import { ShipmentTracker } from '../features/fulfillment/ShipmentTracker';

export const AppRoutes = () => {
  return (
    <AuthProvider>
      <CartProvider>
        <BrowserRouter>
          <Routes>
            {/* Customer & Marketplace Catalog Routes */}
            <Route path="/" element={<CustomerLayout />}>
              <Route index element={<Home />} />
              <Route path="search" element={<SearchPage />} />
              <Route path="category/:id" element={<CategoryPage />} />
              <Route path="product/:id" element={<ProductPage />} />
              <Route path="cart" element={<CartPage />} />
              <Route path="checkout" element={<CheckoutPage />} />
              <Route path="orders" element={<CustomerOrders />} />
              <Route path="orders/:id" element={<CustomerOrders />} />
              <Route path="returns" element={<CustomerReturns />} />
              <Route path="fulfillment/:id" element={<ShipmentTracker />} />
              <Route path="analytics" element={<AnalyticsDashboard />} />
              {/* /account renders the profile + tab panel when already logged in */}
              <Route path="account" element={<AccountPage />} />
              <Route path="verify-email" element={<VerifyEmailPage />} />
              {/* /login and /register redirect-aware aliases */}
              <Route path="login" element={<AccountPage redirectAfterLogin />} />
              <Route path="register" element={<AccountPage redirectAfterLogin />} />
            </Route>

            {/* Merchant Seller Hub Routes */}
            <Route path="/merchant" element={<MerchantLayout />}>
              <Route index element={<MerchantDashboard />} />
              <Route path="listings" element={<MerchantListings />} />
              <Route path="products" element={<MerchantListings />} />
              <Route path="inventory" element={<MerchantInventory />} />
              <Route path="orders" element={<MerchantOrders />} />
              <Route path="fulfillment" element={<MerchantFulfillment />} />
              <Route path="returns" element={<MerchantReturns />} />
              <Route path="finance" element={<MerchantFinance />} />
              <Route path="analytics" element={<AnalyticsDashboard />} />
              <Route path="onboarding" element={<MerchantOnboarding />} />
              <Route path="settings" element={<MerchantSettings />} />
            </Route>

            {/* Platform Admin Routes */}
            <Route path="/admin" element={<AdminLayout />}>
              <Route index element={<AdminDashboard />} />
              <Route path="users" element={<AdminUsers />} />
              <Route path="merchants" element={<AdminMerchants />} />
              <Route path="catalog" element={<AdminCatalog />} />
              <Route path="listings" element={<AdminListings />} />
              <Route path="inventory" element={<AdminInventory />} />
              <Route path="orders" element={<AdminOrders />} />
              <Route path="payments" element={<AdminPayments />} />
              <Route path="settlements" element={<AdminSettlements />} />
              <Route path="settlement" element={<AdminSettlements />} />
              <Route path="events" element={<AdminEvents />} />
              <Route path="security" element={<AdminSecurity />} />
              <Route path="analytics" element={<AnalyticsDashboard />} />
            </Route>
          </Routes>
        </BrowserRouter>
      </CartProvider>
    </AuthProvider>
  );
};
