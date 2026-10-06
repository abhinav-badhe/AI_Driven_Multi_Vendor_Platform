export interface EmailChannelProvider {
  sendEmail(
    to: string,
    subject: string,
    body: string,
    metadata?: Record<string, unknown>,
  ): Promise<{ providerMessageId: string }>;
}

export interface SmsChannelProvider {
  sendSms(
    to: string,
    body: string,
    metadata?: Record<string, unknown>,
  ): Promise<{ providerMessageId: string }>;
}

export interface PushChannelProvider {
  sendPush(
    deviceToken: string,
    title: string,
    body: string,
    metadata?: Record<string, unknown>,
  ): Promise<{ providerMessageId: string }>;
}

/**
 * Resend email provider (https://resend.com).
 * Used when RESEND_API_KEY is configured; otherwise the API keeps the
 * in-memory provider (dev/test). Plain-text body is sent with an HTML
 * fallback generated from line breaks.
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

export class InMemoryEmailProvider implements EmailChannelProvider {
  private readonly sentEmails: Array<{
    to: string;
    subject: string;
    body: string;
    metadata?: Record<string, unknown>;
  }> = [];
  private simulateFailure = false;

  setSimulateFailure(fail: boolean): void {
    this.simulateFailure = fail;
  }

  getSentEmails(): Array<{ to: string; subject: string; body: string }> {
    return [...this.sentEmails];
  }

  clear(): void {
    this.sentEmails.length = 0;
  }

  async sendEmail(
    to: string,
    subject: string,
    body: string,
    metadata?: Record<string, unknown>,
  ): Promise<{ providerMessageId: string }> {
    if (this.simulateFailure) {
      throw new Error('SMTP connection timed out (simulated provider failure)');
    }
    if (metadata !== undefined) {
      this.sentEmails.push({ to, subject, body, metadata });
    } else {
      this.sentEmails.push({ to, subject, body });
    }
    return { providerMessageId: `email-${Date.now()}-${Math.random().toString(36).substring(2, 7)}` };
  }
}

export class InMemorySmsProvider implements SmsChannelProvider {
  private readonly sentSms: Array<{
    to: string;
    body: string;
    metadata?: Record<string, unknown>;
  }> = [];
  private simulateFailure = false;

  setSimulateFailure(fail: boolean): void {
    this.simulateFailure = fail;
  }

  getSentSms(): Array<{ to: string; body: string }> {
    return [...this.sentSms];
  }

  clear(): void {
    this.sentSms.length = 0;
  }

  async sendSms(
    to: string,
    body: string,
    metadata?: Record<string, unknown>,
  ): Promise<{ providerMessageId: string }> {
    if (this.simulateFailure) {
      throw new Error('SMS Gateway 503 Service Unavailable (simulated provider failure)');
    }
    if (metadata !== undefined) {
      this.sentSms.push({ to, body, metadata });
    } else {
      this.sentSms.push({ to, body });
    }
    return { providerMessageId: `sms-${Date.now()}-${Math.random().toString(36).substring(2, 7)}` };
  }
}

export class InMemoryPushProvider implements PushChannelProvider {
  private readonly sentPushes: Array<{
    deviceToken: string;
    title: string;
    body: string;
    metadata?: Record<string, unknown>;
  }> = [];
  private simulateFailure = false;

  setSimulateFailure(fail: boolean): void {
    this.simulateFailure = fail;
  }

  getSentPushes(): Array<{ deviceToken: string; title: string; body: string }> {
    return [...this.sentPushes];
  }

  clear(): void {
    this.sentPushes.length = 0;
  }

  async sendPush(
    deviceToken: string,
    title: string,
    body: string,
    metadata?: Record<string, unknown>,
  ): Promise<{ providerMessageId: string }> {
    if (this.simulateFailure) {
      throw new Error('FCM/APNS push delivery failed (simulated provider failure)');
    }
    if (metadata !== undefined) {
      this.sentPushes.push({ deviceToken, title, body, metadata });
    } else {
      this.sentPushes.push({ deviceToken, title, body });
    }
    return { providerMessageId: `push-${Date.now()}-${Math.random().toString(36).substring(2, 7)}` };
  }
}
