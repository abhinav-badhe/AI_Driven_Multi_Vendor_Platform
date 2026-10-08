import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { IdentityService } from '../modules/identity/index.js';
import type { ReviewService } from '../modules/catalog/index.js';
import { createAuthMiddleware, createOptionalAuthMiddleware, requireActor } from './auth-middleware.js';
import type {
  CreateReviewInput,
  UpdateReviewInput,
  ListReviewsFilter,
  ReviewStatus,
} from '../modules/catalog/index.js';

export function registerReviewRoutes(
  app: FastifyInstance,
  identityService: IdentityService,
  reviewService: ReviewService,
): void {
  const authenticate = createAuthMiddleware(identityService);
  const optionalAuth = createOptionalAuthMiddleware(identityService);

  const routePrefixes = ['', '/api/v1'];

  for (const prefix of routePrefixes) {
    // GET /products/:id/reviews: Public reviews for a canonical product
    app.get(
      `${prefix}/products/:id/reviews`,
      { preHandler: optionalAuth },
      async (request, reply) => {
        const { id } = request.params as { id: string };
        const actor = request.actor ?? null;
        const reviews = await reviewService.listProductReviews(id, actor);
        return reply.status(200).send(reviews);
      },
    );

    // GET /products/:id/rating-summary: Public rating summary with star breakdown
    app.get(
      `${prefix}/products/:id/rating-summary`,
      async (request, reply) => {
        const { id } = request.params as { id: string };
        const summary = await reviewService.getProductRatingSummary(id);
        return reply.status(200).send(summary);
      },
    );

    // GET /products/:id/review-eligibility: Check if current customer is eligible to review
    app.get(
      `${prefix}/products/:id/review-eligibility`,
      { preHandler: authenticate },
      async (request, reply) => {
        const actor = requireActor(request);
        const { id } = request.params as { id: string };
        const eligibility = await reviewService.getReviewEligibility(actor, id);
        return reply.status(200).send(eligibility);
      },
    );

    // POST /products/:id/reviews: Submit a review (Verified purchase enforced)
    app.post(
      `${prefix}/products/:id/reviews`,
      { preHandler: authenticate },
      async (request, reply) => {
        const actor = requireActor(request);
        const { id } = request.params as { id: string };
        const body = request.body as CreateReviewInput;
        const review = await reviewService.submitReview(actor, id, body);
        return reply.status(201).send(review);
      },
    );

    // GET /reviews/:id: Get review details
    app.get(
      `${prefix}/reviews/:id`,
      { preHandler: optionalAuth },
      async (request, reply) => {
        const actor = request.actor ?? null;
        const { id } = request.params as { id: string };
        const review = await reviewService.getReviewById(actor, id);
        return reply.status(200).send(review);
      },
    );

    // PATCH /reviews/:id: Customer edits their own review
    app.patch(
      `${prefix}/reviews/:id`,
      { preHandler: authenticate },
      async (request, reply) => {
        const actor = requireActor(request);
        const { id } = request.params as { id: string };
        const body = request.body as UpdateReviewInput;
        const updated = await reviewService.updateReview(actor, id, body);
        return reply.status(200).send(updated);
      },
    );

    // DELETE /reviews/:id: Customer deletes their own review (or Admin deletes)
    app.delete(
      `${prefix}/reviews/:id`,
      { preHandler: authenticate },
      async (request, reply) => {
        const actor = requireActor(request);
        const { id } = request.params as { id: string };
        await reviewService.deleteReview(actor, id);
        return reply.status(204).send();
      },
    );

    // GET /customer/reviews: List reviews submitted by current customer
    app.get(
      `${prefix}/customer/reviews`,
      { preHandler: authenticate },
      async (request, reply) => {
        const actor = requireActor(request);
        const reviews = await reviewService.listCustomerReviews(actor);
        return reply.status(200).send(reviews);
      },
    );

    // --- Admin Moderation Endpoints ---

    // GET /admin/reviews: List all reviews for moderation (Admin only)
    app.get(
      `${prefix}/admin/reviews`,
      { preHandler: authenticate },
      async (request, reply) => {
        const actor = requireActor(request);
        const query = request.query as {
          productId?: string;
          status?: ReviewStatus;
          customerId?: string;
          limit?: string;
          offset?: string;
        };
        const filter: ListReviewsFilter = {
          productId: query.productId,
          status: query.status,
          customerId: query.customerId,
          limit: query.limit ? Number(query.limit) : undefined,
          offset: query.offset ? Number(query.offset) : undefined,
        };
        const reviews = await reviewService.listModerationReviews(actor, filter);
        return reply.status(200).send(reviews);
      },
    );

    // POST /admin/reviews/:id/approve & PATCH /admin/reviews/:id/approve
    const handleAdminApprove = async (request: FastifyRequest, reply: FastifyReply) => {
      const actor = requireActor(request);
      const { id } = request.params as { id: string };
      const body = (request.body as { note?: string } | undefined) ?? {};
      const approved = await reviewService.approveReview(actor, id, body.note);
      return reply.status(200).send(approved);
    };

    app.post(`${prefix}/admin/reviews/:id/approve`, { preHandler: authenticate }, handleAdminApprove);
    app.patch(`${prefix}/admin/reviews/:id/approve`, { preHandler: authenticate }, handleAdminApprove);

    // POST /admin/reviews/:id/reject & PATCH /admin/reviews/:id/reject
    const handleAdminReject = async (request: FastifyRequest, reply: FastifyReply) => {
      const actor = requireActor(request);
      const { id } = request.params as { id: string };
      const body = (request.body as { note?: string } | undefined) ?? {};
      const rejected = await reviewService.rejectReview(actor, id, body.note);
      return reply.status(200).send(rejected);
    };

    app.post(`${prefix}/admin/reviews/:id/reject`, { preHandler: authenticate }, handleAdminReject);
    app.patch(`${prefix}/admin/reviews/:id/reject`, { preHandler: authenticate }, handleAdminReject);

    // --- Merchant Moderation Endpoints ---

    // GET /merchant/reviews: List reviews for products listed by merchant
    app.get(
      `${prefix}/merchant/reviews`,
      { preHandler: authenticate },
      async (request, reply) => {
        const actor = requireActor(request);
        const query = request.query as {
          productId?: string;
          status?: ReviewStatus;
          limit?: string;
          offset?: string;
        };
        const filter: ListReviewsFilter = {
          productId: query.productId,
          status: query.status,
          limit: query.limit ? Number(query.limit) : undefined,
          offset: query.offset ? Number(query.offset) : undefined,
        };
        const reviews = await reviewService.listModerationReviews(actor, filter);
        return reply.status(200).send(reviews);
      },
    );

    // POST /merchant/reviews/:id/approve & PATCH /merchant/reviews/:id/approve
    const handleMerchantApprove = async (request: FastifyRequest, reply: FastifyReply) => {
      const actor = requireActor(request);
      const { id } = request.params as { id: string };
      const body = (request.body as { note?: string } | undefined) ?? {};
      const approved = await reviewService.approveReview(actor, id, body.note);
      return reply.status(200).send(approved);
    };

    app.post(`${prefix}/merchant/reviews/:id/approve`, { preHandler: authenticate }, handleMerchantApprove);
    app.patch(`${prefix}/merchant/reviews/:id/approve`, { preHandler: authenticate }, handleMerchantApprove);

    // POST /merchant/reviews/:id/reject & PATCH /merchant/reviews/:id/reject
    const handleMerchantReject = async (request: FastifyRequest, reply: FastifyReply) => {
      const actor = requireActor(request);
      const { id } = request.params as { id: string };
      const body = (request.body as { note?: string } | undefined) ?? {};
      const rejected = await reviewService.rejectReview(actor, id, body.note);
      return reply.status(200).send(rejected);
    };

    app.post(`${prefix}/merchant/reviews/:id/reject`, { preHandler: authenticate }, handleMerchantReject);
    app.patch(`${prefix}/merchant/reviews/:id/reject`, { preHandler: authenticate }, handleMerchantReject);
  }
}
