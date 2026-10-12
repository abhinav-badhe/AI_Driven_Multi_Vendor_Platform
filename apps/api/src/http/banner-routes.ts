import type { FastifyInstance } from 'fastify';
import crypto from 'node:crypto';
import type { IdentityService } from '../modules/identity/index.js';
import type { DatabaseConnection } from '../infra/database/connection.js';
import { createAuthMiddleware, requireActor } from './auth-middleware.js';

export interface PromotionalBannerRow {
  id: string;
  title: string;
  subtitle: string | null;
  badge_text: string | null;
  image_url: string;
  target_url: string;
  display_order: number;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export function registerBannerRoutes(
  app: FastifyInstance,
  identityService: IdentityService,
  db: DatabaseConnection,
): void {
  const authenticate = createAuthMiddleware(identityService);

  // 1. GET /banners: Public active storefront banners
  app.get('/banners', async (_request, reply) => {
    const result = await db.query<PromotionalBannerRow>(
      `SELECT id, title, subtitle, badge_text, image_url, target_url, display_order, is_active, created_at, updated_at
       FROM promotional_banners
       WHERE is_active = TRUE
       ORDER BY display_order ASC, created_at DESC`,
    );
    return reply.status(200).send({ banners: result.rows });
  });

  // 2. GET /admin/banners: All banners for admin management
  app.get('/admin/banners', { preHandler: authenticate }, async (request, reply) => {
    const actor = requireActor(request);
    if (actor.role !== 'ADMINISTRATOR') {
      return reply
        .status(403)
        .send({ error: { code: 'FORBIDDEN', message: 'Administrator role required' } });
    }

    const result = await db.query<PromotionalBannerRow>(
      `SELECT id, title, subtitle, badge_text, image_url, target_url, display_order, is_active, created_at, updated_at
         FROM promotional_banners
         ORDER BY display_order ASC, created_at DESC`,
    );
    return reply.status(200).send({ banners: result.rows });
  });

  // 3. POST /admin/banners: Create a new promotional banner (supports JPG image URL or base64)
  app.post('/admin/banners', { preHandler: authenticate }, async (request, reply) => {
    const actor = requireActor(request);
    if (actor.role !== 'ADMINISTRATOR') {
      return reply
        .status(403)
        .send({ error: { code: 'FORBIDDEN', message: 'Administrator role required' } });
    }

    const body = (request.body ?? {}) as {
      title?: unknown;
      subtitle?: unknown;
      badgeText?: unknown;
      imageUrl?: unknown;
      targetUrl?: unknown;
      displayOrder?: unknown;
      isActive?: unknown;
    };

    if (!body.title || typeof body.title !== 'string') {
      return reply.status(400).send({ error: { message: 'title is required' } });
    }
    if (!body.imageUrl || typeof body.imageUrl !== 'string') {
      return reply.status(400).send({
        error: { message: 'imageUrl is required (must be a valid JPG/PNG URL or Base64)' },
      });
    }

    const id = `banner-${crypto.randomUUID().slice(0, 8)}`;
    const title = body.title.trim();
    const subtitle = typeof body.subtitle === 'string' ? body.subtitle.trim() : null;
    const badgeText = typeof body.badgeText === 'string' ? body.badgeText.trim() : null;
    const imageUrl = body.imageUrl.trim();
    const targetUrl =
      typeof body.targetUrl === 'string' && body.targetUrl.trim()
        ? body.targetUrl.trim()
        : '/search';
    const displayOrder = typeof body.displayOrder === 'number' ? body.displayOrder : 0;
    const isActive = body.isActive !== false;

    const result = await db.query<PromotionalBannerRow>(
      `INSERT INTO promotional_banners (id, title, subtitle, badge_text, image_url, target_url, display_order, is_active)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING id, title, subtitle, badge_text, image_url, target_url, display_order, is_active, created_at, updated_at`,
      [id, title, subtitle, badgeText, imageUrl, targetUrl, displayOrder, isActive],
    );

    return reply.status(201).send(result.rows[0]);
  });

  // 4. PATCH /admin/banners/:id: Toggle status or update banner
  app.patch('/admin/banners/:id', { preHandler: authenticate }, async (request, reply) => {
    const actor = requireActor(request);
    if (actor.role !== 'ADMINISTRATOR') {
      return reply
        .status(403)
        .send({ error: { code: 'FORBIDDEN', message: 'Administrator role required' } });
    }

    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as {
      title?: string;
      subtitle?: string;
      badgeText?: string;
      imageUrl?: string;
      targetUrl?: string;
      displayOrder?: number;
      isActive?: boolean;
    };

    const existing = await db.query<PromotionalBannerRow>(
      'SELECT * FROM promotional_banners WHERE id = $1',
      [id],
    );
    if (existing.rows.length === 0) {
      return reply.status(404).send({ error: { message: 'Banner not found' } });
    }

    const cur = existing.rows[0];
    if (!cur) {
      return reply.status(404).send({ error: { message: 'Banner not found' } });
    }
    const title = body.title !== undefined ? body.title : cur.title;
    const subtitle = body.subtitle !== undefined ? body.subtitle : cur.subtitle;
    const badgeText = body.badgeText !== undefined ? body.badgeText : cur.badge_text;
    const imageUrl = body.imageUrl !== undefined ? body.imageUrl : cur.image_url;
    const targetUrl = body.targetUrl !== undefined ? body.targetUrl : cur.target_url;
    const displayOrder = body.displayOrder !== undefined ? body.displayOrder : cur.display_order;
    const isActive = body.isActive !== undefined ? body.isActive : cur.is_active;

    const result = await db.query<PromotionalBannerRow>(
      `UPDATE promotional_banners
         SET title = $1, subtitle = $2, badge_text = $3, image_url = $4, target_url = $5, display_order = $6, is_active = $7, updated_at = NOW()
         WHERE id = $8
         RETURNING id, title, subtitle, badge_text, image_url, target_url, display_order, is_active, created_at, updated_at`,
      [title, subtitle, badgeText, imageUrl, targetUrl, displayOrder, isActive, id],
    );

    return reply.status(200).send(result.rows[0]);
  });

  // 5. DELETE /admin/banners/:id: Remove a banner
  app.delete('/admin/banners/:id', { preHandler: authenticate }, async (request, reply) => {
    const actor = requireActor(request);
    if (actor.role !== 'ADMINISTRATOR') {
      return reply
        .status(403)
        .send({ error: { code: 'FORBIDDEN', message: 'Administrator role required' } });
    }

    const { id } = request.params as { id: string };
    await db.query('DELETE FROM promotional_banners WHERE id = $1', [id]);
    return reply.status(200).send({ success: true, deletedId: id });
  });
}
