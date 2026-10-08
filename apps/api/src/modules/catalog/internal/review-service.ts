import { randomUUID } from 'node:crypto';
import type { DatabaseConnection } from '../../../infra/database/connection.js';
import type { Logger } from '../../../observability/logger.js';
import {
  ValidationError,
  NotFoundError,
  ForbiddenError,
  ConflictError,
} from '../../../errors/app-error.js';
import { RbacPolicy, type AuthorizedActor } from '../../identity/rbac/policy.js';
import type { OutboxService } from '../../events/index.js';
import { EventTypes, createDomainEvent } from '../../events/index.js';
import { ReviewRepository } from './review-repository.js';
import type {
  ProductReviewRow,
  ProductReviewDto,
  CreateReviewInput,
  UpdateReviewInput,
  ProductRatingSummary,
  ReviewEligibilityDto,
  ListReviewsFilter,
} from './review-models.js';

export class ReviewService {
  private readonly repo: ReviewRepository;

  constructor(
    private readonly db: DatabaseConnection,
    private readonly logger: Logger,
    private readonly outboxService?: OutboxService | undefined,
  ) {
    this.repo = new ReviewRepository(db);
  }

  async submitReview(
    actor: AuthorizedActor,
    productId: string,
    input: CreateReviewInput,
  ): Promise<ProductReviewDto> {
    RbacPolicy.requirePermission(actor, 'review:create-own');

    this.validateRating(input.rating);
    const comment = input.comment?.trim();
    if (!comment || comment.length < 3) {
      throw new ValidationError('Review comment must be at least 3 characters long');
    }
    if (comment.length > 2000) {
      throw new ValidationError('Review comment cannot exceed 2000 characters');
    }
    const title = input.title?.trim() || null;
    if (title && title.length > 200) {
      throw new ValidationError('Review title cannot exceed 200 characters');
    }

    // 1. Verify product exists
    const prodRes = await this.db.query<{ id: string; status: string }>(
      `SELECT id, status FROM products WHERE id = $1`,
      [productId],
    );
    if (prodRes.rows.length === 0) {
      throw new NotFoundError(`Product '${productId}' not found`);
    }

    // 2. Strict Verified Purchase Enforcement
    // Derive customer purchases from authoritative customer orders
    const purchase = await this.repo.findVerifiedPurchase(actor.tenantId, productId);
    if (!purchase) {
      throw new ForbiddenError(
        'Verified purchase required: You must purchase this product before writing a review.',
      );
    }

    // 3. One Review Per Customer Per Product
    const existing = await this.repo.findReviewByCustomerAndProduct(actor.userId, productId);
    if (existing) {
      throw new ConflictError(
        'You have already reviewed this product. You can update your existing review.',
      );
    }

    // 4. Look up user details for display attribution
    const userRes = await this.db.query<{ email: string }>(
      `SELECT email FROM users WHERE id = $1`,
      [actor.userId],
    );
    const email = userRes.rows[0]?.email ?? null;
    const reviewerName: string = (email ? email.split('@')[0] : 'Customer') ?? 'Customer';

    const reviewId = randomUUID();

    const created = await this.db.withTransaction(async (tx) => {
      const txRepo = new ReviewRepository(tx);
      const row = await txRepo.createReview(
        {
          id: reviewId,
          productId,
          customerId: actor.userId,
          tenantId: actor.tenantId,
          orderId: purchase.orderId,
          orderItemId: purchase.orderItemId,
          rating: Math.round(input.rating),
          title,
          comment,
          reviewerName,
          reviewerEmail: email,
          status: 'PENDING',
          verifiedPurchase: true,
          reviewedAt: new Date(),
        },
        tx,
      );

      // Publish outbox event
      if (this.outboxService) {
        const event = createDomainEvent({
          eventType: EventTypes.REVIEW_SUBMITTED,
          aggregateType: 'product_review',
          aggregateId: reviewId,
          tenantId: actor.tenantId,
          payload: {
            reviewId,
            productId,
            customerId: actor.userId,
            rating: row.rating,
            status: row.status,
          },
        });
        await this.outboxService.recordEvent(tx, event);
      }

      return row;
    });

    this.logger.info('Customer review submitted (PENDING moderation)', {
      reviewId: created.id,
      productId,
      customerId: actor.userId,
      rating: created.rating,
    });

    return this.toDto(created);
  }

  async updateReview(
    actor: AuthorizedActor,
    reviewId: string,
    input: UpdateReviewInput,
  ): Promise<ProductReviewDto> {
    RbacPolicy.requirePermission(actor, 'review:update-own');

    const existing = await this.repo.findReviewById(reviewId);
    if (!existing) {
      throw new NotFoundError(`Review '${reviewId}' not found`);
    }

    // Customer can only update their own review; Admin can edit any
    if (actor.role !== 'ADMINISTRATOR' && existing.customer_id !== actor.userId) {
      throw new ForbiddenError('You can only edit your own reviews');
    }

    const updates: Partial<ProductReviewRow> = {};

    if (input.rating !== undefined) {
      this.validateRating(input.rating);
      updates.rating = Math.round(input.rating);
    }

    if (input.comment !== undefined) {
      const comment = input.comment.trim();
      if (!comment || comment.length < 3) {
        throw new ValidationError('Review comment must be at least 3 characters long');
      }
      if (comment.length > 2000) {
        throw new ValidationError('Review comment cannot exceed 2000 characters');
      }
      updates.comment = comment;
    }

    if (input.title !== undefined) {
      const title = input.title?.trim() || null;
      if (title && title.length > 200) {
        throw new ValidationError('Review title cannot exceed 200 characters');
      }
      updates.title = title;
    }

    // Customer updates require re-moderation unless admin is editing
    if (actor.role !== 'ADMINISTRATOR') {
      updates.status = 'PENDING';
      updates.moderated_at = null;
      updates.moderated_by = null;
    }

    const updated = await this.db.withTransaction(async (tx) => {
      const txRepo = new ReviewRepository(tx);
      const row = await txRepo.updateReview(reviewId, updates, tx);
      if (!row) {
        throw new NotFoundError(`Review '${reviewId}' not found`);
      }

      // Recalculate rating summary for product
      const summary = await txRepo.calculateRatingSummary(existing.product_id, tx);
      await txRepo.updateProductRatingMetrics(
        existing.product_id,
        summary.averageRating,
        summary.totalReviews,
        tx,
      );

      if (this.outboxService) {
        const event = createDomainEvent({
          eventType: EventTypes.REVIEW_UPDATED,
          aggregateType: 'product_review',
          aggregateId: reviewId,
          tenantId: row.tenant_id ?? actor.tenantId,
          payload: {
            reviewId,
            productId: row.product_id,
            customerId: row.customer_id,
            rating: row.rating,
            status: row.status,
          },
        });
        await this.outboxService.recordEvent(tx, event);
      }

      return row;
    });

    return this.toDto(updated);
  }

  async deleteReview(actor: AuthorizedActor, reviewId: string): Promise<void> {
    const existing = await this.repo.findReviewById(reviewId);
    if (!existing) {
      throw new NotFoundError(`Review '${reviewId}' not found`);
    }

    // Authorization: Admin can delete any; Customer can only delete own review
    if (actor.role === 'ADMINISTRATOR') {
      RbacPolicy.requirePermission(actor, 'review:moderate-any');
    } else if (actor.role === 'CUSTOMER') {
      RbacPolicy.requirePermission(actor, 'review:delete-own');
      if (existing.customer_id !== actor.userId) {
        throw new ForbiddenError('You can only delete your own reviews');
      }
    } else {
      throw new ForbiddenError('You are not authorized to delete reviews');
    }

    await this.db.withTransaction(async (tx) => {
      const txRepo = new ReviewRepository(tx);
      await txRepo.deleteReview(reviewId, tx);

      // Recalculate rating summary for product
      const summary = await txRepo.calculateRatingSummary(existing.product_id, tx);
      await txRepo.updateProductRatingMetrics(
        existing.product_id,
        summary.averageRating,
        summary.totalReviews,
        tx,
      );

      if (this.outboxService) {
        const event = createDomainEvent({
          eventType: EventTypes.REVIEW_DELETED,
          aggregateType: 'product_review',
          aggregateId: reviewId,
          tenantId: existing.tenant_id ?? actor.tenantId,
          payload: {
            reviewId,
            productId: existing.product_id,
          },
        });
        await this.outboxService.recordEvent(tx, event);
      }
    });

    this.logger.info('Deleted product review', { reviewId, productId: existing.product_id });
  }

  async approveReview(
    actor: AuthorizedActor,
    reviewId: string,
    moderationNote?: string | null | undefined,
  ): Promise<ProductReviewDto> {
    const existing = await this.repo.findReviewById(reviewId);
    if (!existing) {
      throw new NotFoundError(`Review '${reviewId}' not found`);
    }

    // Merchant vs Admin authorization
    if (actor.role === 'MERCHANT') {
      RbacPolicy.requirePermission(actor, 'review:moderate-own');
      const isOwner = await this.repo.isMerchantAuthorizedForProduct(actor.tenantId, existing.product_id);
      if (!isOwner) {
        throw new ForbiddenError('Merchants may only moderate reviews for products they list and sell');
      }
    } else if (actor.role === 'ADMINISTRATOR') {
      RbacPolicy.requirePermission(actor, 'review:moderate-any');
    } else {
      throw new ForbiddenError('Unauthorized to moderate reviews');
    }

    const updated = await this.db.withTransaction(async (tx) => {
      const txRepo = new ReviewRepository(tx);
      const row = await txRepo.updateReview(
        reviewId,
        {
          status: 'APPROVED',
          moderated_by: actor.userId,
          moderated_at: new Date(),
          moderation_note: moderationNote?.trim() || null,
        },
        tx,
      );
      if (!row) {
        throw new NotFoundError(`Review '${reviewId}' not found`);
      }

      // Recalculate product rating summary using only APPROVED reviews
      const summary = await txRepo.calculateRatingSummary(existing.product_id, tx);
      await txRepo.updateProductRatingMetrics(
        existing.product_id,
        summary.averageRating,
        summary.totalReviews,
        tx,
      );

      if (this.outboxService) {
        const event = createDomainEvent({
          eventType: EventTypes.REVIEW_APPROVED,
          aggregateType: 'product_review',
          aggregateId: reviewId,
          tenantId: row.tenant_id ?? actor.tenantId,
          payload: {
            reviewId,
            productId: row.product_id,
            rating: row.rating,
            moderatedBy: actor.userId,
          },
        });
        await this.outboxService.recordEvent(tx, event);
      }

      return row;
    });

    this.logger.info('Review APPROVED', { reviewId, productId: updated.product_id });
    return this.toDto(updated);
  }

  async rejectReview(
    actor: AuthorizedActor,
    reviewId: string,
    moderationNote?: string | null | undefined,
  ): Promise<ProductReviewDto> {
    const existing = await this.repo.findReviewById(reviewId);
    if (!existing) {
      throw new NotFoundError(`Review '${reviewId}' not found`);
    }

    // Merchant vs Admin authorization
    if (actor.role === 'MERCHANT') {
      RbacPolicy.requirePermission(actor, 'review:moderate-own');
      const isOwner = await this.repo.isMerchantAuthorizedForProduct(actor.tenantId, existing.product_id);
      if (!isOwner) {
        throw new ForbiddenError('Merchants may only moderate reviews for products they list and sell');
      }
    } else if (actor.role === 'ADMINISTRATOR') {
      RbacPolicy.requirePermission(actor, 'review:moderate-any');
    } else {
      throw new ForbiddenError('Unauthorized to moderate reviews');
    }

    const updated = await this.db.withTransaction(async (tx) => {
      const txRepo = new ReviewRepository(tx);
      const row = await txRepo.updateReview(
        reviewId,
        {
          status: 'REJECTED',
          moderated_by: actor.userId,
          moderated_at: new Date(),
          moderation_note: moderationNote?.trim() || null,
        },
        tx,
      );
      if (!row) {
        throw new NotFoundError(`Review '${reviewId}' not found`);
      }

      // Recalculate product rating summary to exclude rejected review
      const summary = await txRepo.calculateRatingSummary(existing.product_id, tx);
      await txRepo.updateProductRatingMetrics(
        existing.product_id,
        summary.averageRating,
        summary.totalReviews,
        tx,
      );

      if (this.outboxService) {
        const event = createDomainEvent({
          eventType: EventTypes.REVIEW_REJECTED,
          aggregateType: 'product_review',
          aggregateId: reviewId,
          tenantId: row.tenant_id ?? actor.tenantId,
          payload: {
            reviewId,
            productId: row.product_id,
            moderatedBy: actor.userId,
            reason: moderationNote,
          },
        });
        await this.outboxService.recordEvent(tx, event);
      }

      return row;
    });

    this.logger.info('Review REJECTED', { reviewId, productId: updated.product_id });
    return this.toDto(updated);
  }

  async getReviewById(actor: AuthorizedActor | null, reviewId: string): Promise<ProductReviewDto> {
    const review = await this.repo.findReviewById(reviewId);
    if (!review) {
      throw new NotFoundError(`Review '${reviewId}' not found`);
    }

    // If approved, public can see
    if (review.status === 'APPROVED') {
      return this.toDto(review);
    }

    // If pending or rejected, only author or admin/merchant can see
    if (actor && (actor.role === 'ADMINISTRATOR' || review.customer_id === actor.userId)) {
      return this.toDto(review);
    }

    if (actor && actor.role === 'MERCHANT') {
      const isOwner = await this.repo.isMerchantAuthorizedForProduct(actor.tenantId, review.product_id);
      if (isOwner) {
        return this.toDto(review);
      }
    }

    throw new NotFoundError(`Review '${reviewId}' not found`);
  }

  async listProductReviews(
    productId: string,
    actor?: AuthorizedActor | null | undefined,
  ): Promise<ProductReviewDto[]> {
    const prodRes = await this.db.query<{ id: string }>(
      `SELECT id FROM products WHERE id = $1`,
      [productId],
    );
    if (prodRes.rows.length === 0) {
      throw new NotFoundError(`Product '${productId}' not found`);
    }

    const rows = await this.repo.listApprovedReviewsByProductId(
      productId,
      actor?.userId ?? null,
    );
    return rows.map((r) => this.toDto(r));
  }

  async getProductRatingSummary(productId: string): Promise<ProductRatingSummary> {
    return this.repo.calculateRatingSummary(productId);
  }

  async getReviewEligibility(
    actor: AuthorizedActor,
    productId: string,
  ): Promise<ReviewEligibilityDto> {
    const purchase = await this.repo.findVerifiedPurchase(actor.tenantId, productId);
    const hasPurchased = Boolean(purchase);

    const existing = await this.repo.findReviewByCustomerAndProduct(actor.userId, productId);
    const alreadyReviewed = Boolean(existing);

    return {
      hasPurchased,
      alreadyReviewed,
      isEligible: hasPurchased && !alreadyReviewed,
      existingReviewId: existing?.id,
    };
  }

  async listCustomerReviews(actor: AuthorizedActor): Promise<ProductReviewDto[]> {
    RbacPolicy.requirePermission(actor, 'review:read-own');
    const rows = await this.repo.listReviewsByCustomer(actor.userId);
    return rows.map((r) => this.toDto(r));
  }

  async listModerationReviews(
    actor: AuthorizedActor,
    filter?: ListReviewsFilter | undefined,
  ): Promise<ProductReviewDto[]> {
    if (actor.role === 'ADMINISTRATOR') {
      RbacPolicy.requirePermission(actor, 'review:moderate-any');
      const rows = await this.repo.listReviews(filter);
      return rows.map((r) => this.toDto(r));
    }

    if (actor.role === 'MERCHANT') {
      RbacPolicy.requirePermission(actor, 'review:moderate-own');
      const rows = await this.repo.listReviews(filter, actor.tenantId);
      return rows.map((r) => this.toDto(r));
    }

    throw new ForbiddenError('Unauthorized to access moderation reviews');
  }

  private validateRating(rating: unknown): void {
    if (typeof rating !== 'number' || !Number.isInteger(rating) || rating < 1 || rating > 5) {
      throw new ValidationError('Rating must be an integer between 1 and 5');
    }
  }

  private toDto(row: ProductReviewRow): ProductReviewDto {
    return {
      id: row.id,
      productId: row.product_id,
      customerId: row.customer_id,
      orderId: row.order_id,
      orderItemId: row.order_item_id,
      rating: row.rating,
      title: row.title,
      comment: row.comment,
      reviewerName: row.reviewer_name,
      status: row.status,
      verifiedPurchase: Boolean(row.verified_purchase),
      moderatedAt: row.moderated_at ? row.moderated_at.toISOString() : null,
      moderationNote: row.moderation_note,
      reviewedAt: row.reviewed_at ? row.reviewed_at.toISOString() : null,
      createdAt: row.created_at ? row.created_at.toISOString() : new Date().toISOString(),
      updatedAt: row.updated_at ? row.updated_at.toISOString() : new Date().toISOString(),
    };
  }
}
