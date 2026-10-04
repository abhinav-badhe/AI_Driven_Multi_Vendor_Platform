import { apiClient } from '../../../api/client';

export interface ReturnItemInput {
  orderItemId: string;
  skuId: string;
  quantity: number;
  reason?: string;
}

export interface CreateReturnRequestInput {
  customerOrderId: string;
  sellerOrderId: string;
  reason: string;
  items: ReturnItemInput[];
  idempotencyKey?: string;
}

export interface ReturnDto {
  id: string;
  customerOrderId: string;
  sellerOrderId: string;
  status: 'REQUESTED' | 'APPROVED' | 'RECEIVED' | 'INSPECTED' | 'REFUNDED' | 'REJECTED';
  reason: string;
  items: Array<{
    id: string;
    orderItemId: string;
    skuId: string;
    quantity: number;
    reason?: string;
  }>;
  createdAt: string;
}

export const returnsApi = {
  createReturn: async (input: CreateReturnRequestInput): Promise<ReturnDto> => {
    return apiClient<ReturnDto>('/fulfillment/returns', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },

  listReturns: async (query?: { customerOrderId?: string; sellerOrderId?: string }): Promise<ReturnDto[]> => {
    const params = new URLSearchParams();
    if (query?.customerOrderId) params.append('customerOrderId', query.customerOrderId);
    if (query?.sellerOrderId) params.append('sellerOrderId', query.sellerOrderId);
    const queryString = params.toString();
    return apiClient<ReturnDto[]>(`/fulfillment/returns${queryString ? `?${queryString}` : ''}`);
  },
};
