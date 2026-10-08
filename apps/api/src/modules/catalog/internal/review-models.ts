export type ReviewStatus = 'PENDING' | 'APPROVED' | 'REJECTED';

export interface ProductReviewRow {
  id: string;
  product_id: string;
  customer_id: string | null;
  tenant_id: string | null;
  order_id: string | null;
  order_item_id: string | null;
  rating: number;
  title: string | null;
  comment: string | null;
  reviewer_name: string | null;
  reviewer_email: string | null;
  status: ReviewStatus;
  verified_purchase: boolean;
  moderated_by: string | null;
  moderated_at: Date | null;
  moderation_note: string | null;
  reviewed_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface ProductReviewDto {
  id: string;
  productId: string;
  customerId: string | null;
  orderId: string | null;
  orderItemId: string | null;
  rating: number;
  title: string | null;
  comment: string | null;
  reviewerName: string | null;
  status: ReviewStatus;
  verifiedPurchase: boolean;
  moderatedAt: string | null;
  moderationNote: string | null;
  reviewedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateReviewInput {
  rating: number;
  title?: string | null | undefined;
  comment: string;
}

export interface UpdateReviewInput {
  rating?: number | undefined;
  title?: string | null | undefined;
  comment?: string | undefined;
}

export interface ProductRatingSummary {
  productId: string;
  averageRating: number;
  totalReviews: number;
  distribution: {
    1: number;
    2: number;
    3: number;
    4: number;
    5: number;
  };
}

export interface ReviewEligibilityDto {
  isEligible: boolean;
  hasPurchased: boolean;
  alreadyReviewed: boolean;
  existingReviewId?: string | undefined;
}

export interface ListReviewsFilter {
  productId?: string | undefined;
  status?: ReviewStatus | undefined;
  customerId?: string | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
}
