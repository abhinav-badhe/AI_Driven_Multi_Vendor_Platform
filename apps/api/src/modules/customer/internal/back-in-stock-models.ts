export type BackInStockSubscriptionStatus = 'ACTIVE' | 'NOTIFIED' | 'CANCELLED';

export interface BackInStockSubscriptionRow {
  id: string;
  customer_id: string;
  tenant_id: string;
  product_id: string;
  sku_id: string | null;
  status: BackInStockSubscriptionStatus;
  created_at: string;
  notified_at: string | null;
  updated_at: string;
}

export interface BackInStockSubscriptionWithDetailsRow extends BackInStockSubscriptionRow {
  product_title: string;
  product_slug: string;
  product_brand: string | null;
  product_thumbnail_url: string | null;
  product_status: string;
  sku_code: string | null;
  sku_attributes: Record<string, unknown> | null;
}

export interface BackInStockSubscriptionDto {
  id: string;
  customerId: string;
  tenantId: string;
  productId: string;
  skuId: string | null;
  status: BackInStockSubscriptionStatus;
  product?:
    | {
        id: string;
        title: string;
        slug: string;
        brand: string | null;
        thumbnailUrl: string | null;
        status: string;
      }
    | undefined;
  sku?:
    | {
        id: string;
        skuCode: string;
        attributes: Record<string, unknown>;
      }
    | null
    | undefined;
  availability?:
    | {
        isAvailable: boolean;
        availableQuantity: number;
        status: 'IN_STOCK' | 'OUT_OF_STOCK' | 'UNAVAILABLE';
      }
    | undefined;
  createdAt: string;
  notifiedAt: string | null;
  updatedAt: string;
}

export interface CreateBackInStockInput {
  productId: string;
  skuId?: string | null | undefined;
}

export interface BackInStockCheckResultDto {
  isSubscribed: boolean;
  subscriptionId: string | null;
  status: BackInStockSubscriptionStatus | null;
}
