import { apiClient } from '../../../api/client';

export interface OrderItemDto {
  id: string;
  sellerOrderId: string;
  customerOrderId: string;
  listingId: string;
  skuId: string;
  productId: string;
  merchantTenantId: string;
  productName: string;
  skuCode: string;
  variantInfo: Record<string, unknown>;
  quantity: number;
  unitPriceAmount: number;
  lineTotalAmount: number;
  currency: string;
  createdAt: string;
}

export interface SellerOrderDto {
  id: string;
  customerOrderId: string;
  sellerTenantId: string;
  status: string;
  currency: string;
  subtotalAmount: number;
  shippingAmount: number;
  taxAmount: number;
  totalAmount: number;
  createdAt: string;
  updatedAt: string;
  items?: OrderItemDto[];
}

export interface CustomerOrderDto {
  id: string;
  orderNumber: string;
  customerTenantId: string;
  status: 'PENDING' | 'CONFIRMED' | 'PROCESSING' | 'PARTIALLY_SHIPPED' | 'SHIPPED' | 'DELIVERED' | 'CANCELLED' | 'REFUNDED';
  paymentMethod?: 'COD' | 'UPI' | 'CARD' | null;
  currency: string;
  subtotalAmount: number;
  shippingAmount: number;
  taxAmount: number;
  totalAmount: number;
  createdAt: string;
  updatedAt: string;
  sellerOrders?: SellerOrderDto[];
}

export const ordersApi = {
  listOrders: async (): Promise<CustomerOrderDto[]> => {
    return apiClient<CustomerOrderDto[]>('/orders');
  },

  getOrder: async (id: string): Promise<CustomerOrderDto> => {
    return apiClient<CustomerOrderDto>(`/orders/${id}`);
  },
};
