import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  InMemoryEmailProvider,
  InMemorySmsProvider,
  InMemoryPushProvider,
  ResendEmailProvider,
} from '../src/channels/index.js';

describe('Notification Channel Providers', () => {
  it('InMemoryEmailProvider records dispatched emails and supports simulation of failures', async () => {
    const provider = new InMemoryEmailProvider();
    const res = await provider.sendEmail('test@example.com', 'Test Subject', 'Test Body');

    expect(res.providerMessageId).toBeDefined();
    expect(provider.getSentEmails().length).toBe(1);

    provider.setSimulateFailure(true);
    await expect(provider.sendEmail('fail@example.com', 'Sub', 'Body')).rejects.toThrow(
      'SMTP connection timed out',
    );
  });

  it('InMemorySmsProvider and InMemoryPushProvider record messages', async () => {
    const sms = new InMemorySmsProvider();
    const push = new InMemoryPushProvider();

    const smsRes = await sms.sendSms('+1234567890', 'Hello SMS');
    expect(smsRes.providerMessageId).toBeDefined();
    expect(sms.getSentSms().length).toBe(1);

    const pushRes = await push.sendPush('token-xyz', 'Alert', 'Stock available');
    expect(pushRes.providerMessageId).toBeDefined();
    expect(push.getSentPush().length).toBe(1);
  });

  describe('ResendEmailProvider', () => {
    const originalFetch = globalThis.fetch;

    beforeEach(() => {
      globalThis.fetch = originalFetch;
    });

    it('successfully calls Resend API with Bearer token', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ id: 'resend_msg_123' }),
      });
      globalThis.fetch = mockFetch as unknown as typeof fetch;

      const resend = new ResendEmailProvider('re_123456789', 'noreply@ecommerce.example.com');
      const res = await resend.sendEmail('buyer@example.com', 'Your Order', 'Thank you!');

      expect(res.providerMessageId).toBe('resend_msg_123');
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.resend.com/emails',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            Authorization: 'Bearer re_123456789',
            'Content-Type': 'application/json',
          }),
        }),
      );
    });

    it('throws when Resend returns non-2xx status', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        text: async () => 'Invalid API Key',
      });
      globalThis.fetch = mockFetch as unknown as typeof fetch;

      const resend = new ResendEmailProvider('invalid_key', 'noreply@ecommerce.example.com');
      await expect(resend.sendEmail('buyer@example.com', 'Order', 'Body')).rejects.toThrow(
        'Resend rejected email to buyer@example.com: HTTP 401 Invalid API Key',
      );
    });
  });
});
