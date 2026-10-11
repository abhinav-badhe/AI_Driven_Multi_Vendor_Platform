import type { EmailChannelProvider } from './channel-provider.js';

/**
 * Resend email provider (https://resend.com).
 * Uses native fetch to invoke the Resend API with HTML line-break formatting.
 */
export class ResendEmailProvider implements EmailChannelProvider {
  constructor(
    private readonly apiKey: string,
    private readonly from: string,
  ) {
    if (!apiKey) throw new Error('ResendEmailProvider requires an API key');
  }

  async sendEmail(
    to: string,
    subject: string,
    body: string,
    _metadata?: Record<string, unknown>,
  ): Promise<{ providerMessageId: string }> {
    const html = `<div style="font-family:sans-serif;font-size:14px;line-height:1.6;color:#111">${body
      .split('\n')
      .map((line) => (line.trim() === '' ? '<br/>' : `<p style="margin:0 0 8px">${line}</p>`))
      .join('')}</div>`;

    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ from: this.from, to: [to], subject, text: body, html }),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`Resend rejected email to ${to}: HTTP ${res.status} ${detail}`.trim());
    }

    const parsed = (await res.json().catch(() => ({}))) as { id?: string };
    return { providerMessageId: parsed.id ?? `resend-${Date.now()}` };
  }
}
