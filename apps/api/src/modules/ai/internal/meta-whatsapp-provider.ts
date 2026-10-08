import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Logger } from '../../../observability/logger.js';
import type { IWhatsAppProvider, WhatsAppSendResult } from './ai-types.js';

export interface MetaWhatsAppConfig {
  accessToken: string;
  phoneNumberId: string;
  appSecret: string;
  apiVersion?: string | undefined;
}

/**
 * Production Meta WhatsApp Business Platform Cloud API Provider.
 * Sends outbound WhatsApp messages via Meta Graph API and verifies inbound
 * webhook signatures using HMAC-SHA256 with the configured Meta App Secret.
 */
export class MetaWhatsAppCloudProvider implements IWhatsAppProvider {
  readonly providerName = 'meta';

  private readonly accessToken: string;
  private readonly phoneNumberId: string;
  private readonly appSecret: string;
  private readonly apiVersion: string;

  constructor(
    config: MetaWhatsAppConfig,
    private readonly logger: Logger,
  ) {
    if (!config.accessToken) {
      throw new Error('MetaWhatsAppCloudProvider requires accessToken');
    }
    if (!config.phoneNumberId) {
      throw new Error('MetaWhatsAppCloudProvider requires phoneNumberId');
    }
    if (!config.appSecret) {
      throw new Error('MetaWhatsAppCloudProvider requires appSecret');
    }

    this.accessToken = config.accessToken;
    this.phoneNumberId = config.phoneNumberId;
    this.appSecret = config.appSecret;
    this.apiVersion = config.apiVersion ?? 'v20.0';
  }

  /**
   * Verifies the x-hub-signature-256 header sent by Meta Webhook endpoints.
   * Header format: sha256=<hex_digest>
   */
  verifyWebhookSignature(rawPayload: string, signature: string, secret?: string): boolean {
    const key = secret || this.appSecret;
    if (!signature || !key || !rawPayload) {
      return false;
    }

    try {
      const cleanSig = signature.startsWith('sha256=') ? signature.slice(7) : signature;
      const expectedHex = createHmac('sha256', key).update(rawPayload).digest('hex');

      const expectedBuf = Buffer.from(expectedHex, 'hex');
      const sigBuf = Buffer.from(cleanSig, 'hex');

      if (expectedBuf.length !== sigBuf.length) {
        return false;
      }

      return timingSafeEqual(expectedBuf, sigBuf);
    } catch (err: unknown) {
      this.logger.warn('Failed to verify Meta WhatsApp webhook signature', {
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }

  /**
   * Sends an outbound text message to a WhatsApp user via Meta Cloud API.
   */
  async sendTextMessage(to: string, text: string): Promise<WhatsAppSendResult> {
    const cleanTo = to.replace(/[^0-9]/g, '');
    if (!cleanTo) {
      return { success: false, error: 'Recipient phone number is invalid' };
    }
    if (!text || text.trim().length === 0) {
      return { success: false, error: 'Message body cannot be empty' };
    }

    const url = `https://graph.facebook.com/${this.apiVersion}/${this.phoneNumberId}/messages`;
    const payload = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: cleanTo,
      type: 'text',
      text: {
        preview_url: false,
        body: text,
      },
    };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      const responseBody = (await response.json().catch(() => ({}))) as Record<string, unknown>;

      if (!response.ok) {
        const errorInfo = (responseBody['error'] as Record<string, unknown> | undefined) ?? {};
        const errorMsg = String(errorInfo['message'] ?? `HTTP ${response.status}`);
        this.logger.error('Meta WhatsApp Cloud API send failed', {
          recipient: cleanTo,
          statusCode: response.status,
          error: errorMsg,
        });
        return { success: false, error: errorMsg };
      }

      const messages = responseBody['messages'] as Array<{ id: string }> | undefined;
      const messageId = messages?.[0]?.id ?? `wamid.${Date.now()}`;

      this.logger.info('Meta WhatsApp message dispatched successfully', {
        recipient: cleanTo,
        messageId,
      });

      return { success: true, messageId };
    } catch (err: unknown) {
      const isAbort = err instanceof Error && err.name === 'AbortError';
      const msg = isAbort ? 'Request timed out after 10s' : err instanceof Error ? err.message : String(err);
      this.logger.error('Meta WhatsApp outbound request threw error', {
        recipient: cleanTo,
        error: msg,
      });
      return { success: false, error: msg };
    } finally {
      clearTimeout(timeout);
    }
  }
}
