import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { BrowserRouter } from 'react-router-dom';
import { AuthProvider } from '../src/features/auth/AuthContext.js';
import { AdminWhatsApp } from '../src/features/admin/AdminWhatsApp.js';

const ADMIN_ME = {
  userId: 'u-admin-1',
  email: 'admin@platform.com',
  tenantId: 'platform-tenant',
  role: 'ADMINISTRATOR',
};

const MOCK_STATUS = {
  provider: 'meta',
  phoneNumberId: 'phone-meta-12345',
  apiVersion: 'v21.0',
  configured: true,
  webhookStatus: 'Active & Verified',
  deliveryMetrics: {
    totalReceived: 42,
    processed: 40,
    duplicates: 2,
    errors: 0,
  },
};

const MOCK_CONVERSATIONS = [
  {
    id: 'conv-wa-test-1',
    tenantId: 'tenant-1',
    channel: 'WHATSAPP',
    customerId: 'cust-101',
    status: 'ACTIVE',
    metadata: {
      phoneNumber: '+15551234567',
      linkedOrderId: 'ord-test-999',
    },
    createdAt: '2026-10-07T10:00:00.000Z',
    updatedAt: '2026-10-07T10:05:00.000Z',
  },
];

const MOCK_WEBHOOKS = [
  {
    id: 'wh-1',
    messageId: 'wamid.HBgL1234',
    phoneNumber: '+15551234567',
    status: 'PROCESSED',
    createdAt: '2026-10-07T10:00:00.000Z',
  },
];

const MOCK_AUDIT = [
  {
    id: 'aud-1',
    toolName: 'search_products',
    actorRole: 'CUSTOMER',
    executionDurationMs: 14,
    status: 'SUCCESS',
    createdAt: '2026-10-07T10:00:01.000Z',
  },
];

function mockApi() {
  global.fetch = vi.fn().mockImplementation((url: string) => {
    const ok = (body: unknown) =>
      Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) } as Response);

    if (typeof url !== 'string') return Promise.reject(new Error('bad url'));
    if (url.includes('/auth/refresh')) return ok({ accessToken: 'test-admin-token' });
    if (url.includes('/auth/me')) return ok(ADMIN_ME);
    if (url.includes('/ai/whatsapp/status')) return ok(MOCK_STATUS);
    if (url.includes('/ai/whatsapp/conversations'))
      return ok({ conversations: MOCK_CONVERSATIONS });
    if (url.includes('/ai/whatsapp/webhooks')) return ok({ webhooks: MOCK_WEBHOOKS });
    if (url.includes('/ai/audit')) return ok({ records: MOCK_AUDIT });

    return ok({});
  });
}

describe('AdminWhatsApp Channel Frontend Integration', () => {
  beforeEach(() => {
    mockApi();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('renders WhatsApp channel dashboard with live provider status and delivery metrics', async () => {
    render(
      <BrowserRouter>
        <AuthProvider>
          <AdminWhatsApp />
        </AuthProvider>
      </BrowserRouter>,
    );

    await waitFor(() => {
      expect(screen.getByText(/WhatsApp Commerce & AI Channel/i)).toBeDefined();
    });

    // Check KPI cards after fetch resolves
    await waitFor(() => {
      expect(screen.getByText(/Meta Cloud API/i)).toBeDefined();
    });
    expect(screen.getByText(/phone-meta-12345/i)).toBeDefined();
    expect(screen.getByText(/Active & Verified/i)).toBeDefined();
    expect(screen.getByText(/95% Success/i)).toBeDefined();
    expect(screen.getByText(/2 Duplicates/i)).toBeDefined();

    // Check tabs
    expect(screen.getByText(/Integration Overview/i)).toBeDefined();
    expect(screen.getByText(/Conversations \(1\)/i)).toBeDefined();
    expect(screen.getByText(/Webhook Log \(1\)/i)).toBeDefined();
    expect(screen.getByText(/Tool Audit Logs \(1\)/i)).toBeDefined();
  });
});
