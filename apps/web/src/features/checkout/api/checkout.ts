import { apiClient } from '../../../api/client';

export interface CheckoutItemDto {
  id: string;
  checkoutSessionId: string;
  listingId: string;
  skuId: string;
  merchantTenantId: string;
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

export const checkoutApi = {
  createSession: async (): Promise<CheckoutSessionDto> => {
    return apiClient<CheckoutSessionDto>('/checkout/sessions', {
      method: 'POST',
      body: JSON.stringify({ idempotencyKey: `chk_${Date.now()}` }),
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

  submitPaymentAttempt: async (intentId: string, paymentMethod = 'pm_card_visa'): Promise<{ status: string }> => {
    return apiClient<{ status: string }>(`/payments/intents/${intentId}/attempts`, {
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
};
