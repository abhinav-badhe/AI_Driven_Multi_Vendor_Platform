import { apiClient } from '../../../api/client';

export interface CheckoutItemDto {
  id: string;
  checkoutSessionId: string;
  listingId: string;
  skuId: string;
  merchantTenantId: string;
  productId?: string | null;
  productTitle?: string | null;
  productBrand?: string | null;
  productThumbnailUrl?: string | null;
  quantity: number;
  unitPriceAmount: number;
  lineTotalAmount: number;
  currency: string;
  inventoryReservationId?: string | null;
  createdAt: string;
}

export interface CheckoutSessionDto {
  id: string;
  cartId: string;
  customerTenantId: string;
  status: 'OPEN' | 'RESERVED' | 'READY' | 'COMPLETED' | 'CANCELLED' | 'EXPIRED' | 'FAILED';
  currency: string;
  subtotalAmount: number;
  discountAmount: number;
  shippingAmount: number;
  taxAmount: number;
  totalAmount: number;
  couponCode?: string | null;
  appliedPromotions?: unknown[];
  shippingAddress?: {
    id?: string;
    label?: string;
    recipientName: string;
    phone: string;
    addressLine1: string;
    addressLine2?: string | null;
    landmark?: string | null;
    city: string;
    state: string;
    postalCode: string;
    country: string;
    latitude?: number | null;
    longitude?: number | null;
    googlePlaceId?: string | null;
    formattedAddress?: string | null;
  } | null;
  expiresAt: string;
  reservedAt?: string | null;
  items: CheckoutItemDto[];
  createdAt: string;
}

export interface PaymentIntentDto {
  id: string;
  customerTenantId: string;
  checkoutSessionId: string;
  orderId: string | null;
  amount: number;
  currency: string;
  status: string;
  provider: string;
  clientSecret: string;
}

export interface OrderConfirmationDto {
  id: string;
  orderNumber: string;
  customerTenantId: string;
  status: string;
  totalAmount: number;
  currency: string;
  sellerOrders?: Array<{
    id: string;
    sellerTenantId: string;
    status: string;
    totalAmount: number;
    items?: Array<{
      id: string;
      productName: string;
      skuCode: string;
      quantity: number;
      unitPriceAmount: number;
      lineTotalAmount: number;
    }>;
  }>;
  createdAt: string;
}

export interface PaymentAttemptDto {
  id: string;
  paymentIntentId: string;
  provider: string;
  providerTransactionId: string;
  amount: number;
  currency: string;
  status: 'SUCCEEDED' | 'FAILED' | 'PROCESSING' | 'REQUIRES_ACTION';
  failureCode?: string | null;
  failureMessage?: string | null;
  providerResponse?: Record<string, unknown>;
}

export const checkoutApi = {
  createSession: async (options?: { addressId?: string | undefined; shippingAddress?: unknown }): Promise<CheckoutSessionDto> => {
    return apiClient<CheckoutSessionDto>('/checkout/sessions', {
      method: 'POST',
      body: JSON.stringify({
        idempotencyKey: `chk_${Date.now()}`,
        addressId: options?.addressId,
        shippingAddress: options?.shippingAddress,
      }),
    });
  },

  setShippingAddress: async (
    sessionId: string,
    payload: { addressId?: string; shippingAddress?: unknown },
  ): Promise<CheckoutSessionDto> => {
    return apiClient<CheckoutSessionDto>(`/checkout/sessions/${sessionId}/address`, {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },

  reserveInventory: async (sessionId: string): Promise<CheckoutSessionDto> => {
    return apiClient<CheckoutSessionDto>(`/checkout/sessions/${sessionId}/reserve`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
  },

  createPaymentIntent: async (sessionId: string): Promise<PaymentIntentDto> => {
    return apiClient<PaymentIntentDto>('/payments/intents', {
      method: 'POST',
      body: JSON.stringify({
        checkoutSessionId: sessionId,
        idempotencyKey: `pi_${sessionId}_${Date.now()}`,
      }),
    });
  },

  submitPaymentAttempt: async (intentId: string, paymentMethod = 'pm_card_visa'): Promise<PaymentAttemptDto> => {
    return apiClient<PaymentAttemptDto>(`/payments/intents/${intentId}/attempts`, {
      method: 'POST',
      body: JSON.stringify({
        paymentMethod,
        idempotencyKey: `att_${intentId}_${Date.now()}`,
      }),
    });
  },

  finalizeOrder: async (checkoutSessionId: string, paymentIntentId: string): Promise<OrderConfirmationDto> => {
    return apiClient<OrderConfirmationDto>('/orders', {
      method: 'POST',
      body: JSON.stringify({
        checkoutSessionId,
        paymentIntentId,
        idempotencyKey: `ord_${checkoutSessionId}`,
      }),
    });
  },

  applyCoupon: async (
    sessionId: string,
    couponCode: string,
  ): Promise<{
    discountAmount: number;
    totalAmount: number;
    couponCode: string;
    appliedPromotions: unknown[];
  }> => {
    return apiClient(`/checkout/sessions/${sessionId}/coupon`, {
      method: 'POST',
      body: JSON.stringify({ couponCode }),
    });
  },

  removeCoupon: async (
    sessionId: string,
  ): Promise<{
    discountAmount: number;
    totalAmount: number;
    couponCode: null;
    appliedPromotions: [];
  }> => {
    return apiClient(`/checkout/sessions/${sessionId}/coupon`, {
      method: 'DELETE',
    });
  },

  getPaymentConfig: async (): Promise<{
    provider: 'razorpay' | 'stripe' | 'mock';
    razorpayKeyId?: string | null;
    stripePublishableKey?: string | null;
    currency: string;
  }> => {
    return apiClient('/payments/config');
  },
};
