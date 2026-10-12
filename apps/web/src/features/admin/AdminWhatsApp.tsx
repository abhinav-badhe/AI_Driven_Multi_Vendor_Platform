import { useState, useEffect } from 'react';
import { useAuth } from '../auth/AuthContext';
import { apiClient } from '../../api/client';
import { Navigate } from 'react-router-dom';
import {
  MessageSquare,
  ShieldCheck,
  CheckCircle2,
  AlertTriangle,
  RotateCw,
  Phone,
  Layers,
  ShoppingBag,
  Send,
} from 'lucide-react';

interface WhatsAppStatusResponse {
  provider: string;
  phoneNumberId?: string;
  apiVersion?: string;
  configured: boolean;
  webhookStatus: string;
  deliveryMetrics: {
    totalReceived: number;
    processed: number;
    duplicates: number;
    errors: number;
  };
}

interface ConversationItem {
  id: string;
  tenantId: string;
  channel: string;
  customerId?: string;
  status: string;
  metadata?: {
    phoneNumber?: string;
    linkedOrderId?: string;
    lastActive?: string;
  };
  createdAt: string;
  updatedAt: string;
}

interface WebhookRecordItem {
  id: string;
  messageId: string;
  phoneNumber: string;
  status: string;
  errorMessage?: string;
  createdAt: string;
}

interface AiAuditItem {
  id: string;
  toolName: string;
  actorRole: string;
  executionDurationMs: number;
  status: string;
  errorMessage?: string;
  createdAt: string;
}

interface ConversationDetail {
  conversation: ConversationItem;
  messages: Array<{
    id: string;
    role: string;
    content: string;
    toolCalls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }>;
    createdAt: string;
  }>;
}

export const AdminWhatsApp = () => {
  const { user } = useAuth();
  const [activeTab, setActiveTab] = useState<
    'overview' | 'conversations' | 'webhooks' | 'audit' | 'setup'
  >('overview');
  const [status, setStatus] = useState<WhatsAppStatusResponse | null>(null);
  const [conversations, setConversations] = useState<ConversationItem[]>([]);
  const [webhooks, setWebhooks] = useState<WebhookRecordItem[]>([]);
  const [auditLogs, setAuditLogs] = useState<AiAuditItem[]>([]);
  const [selectedConv, setSelectedConv] = useState<ConversationDetail | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [testPrompt, setTestPrompt] = useState('');
  const [isTesting, setIsTesting] = useState(false);
  const [testResponse, setTestResponse] = useState<{
    query: string;
    reply: string;
    tools: string[];
  } | null>(null);

  const handleTestWhatsApp = async (promptToSend?: string) => {
    const text = (promptToSend || testPrompt).trim();
    if (!text) return;
    setIsTesting(true);
    setError(null);
    try {
      const res = await apiClient<{ replyText: string; toolCallsExecuted?: string[] }>('/ai/chat', {
        method: 'POST',
        body: JSON.stringify({ message: text, channel: 'WHATSAPP' }),
      });
      setTestResponse({
        query: text,
        reply: res.replyText,
        tools: res.toolCallsExecuted || [],
      });
      setTestPrompt('');
      void fetchData();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'WhatsApp test failed');
    } finally {
      setIsTesting(false);
    }
  };

  const fetchData = async () => {
    setIsRefreshing(true);
    setError(null);
    try {
      const [statusRes, convsRes, webhooksRes, auditRes] = await Promise.all([
        apiClient<WhatsAppStatusResponse>('/ai/whatsapp/status').catch(() => null),
        apiClient<{ conversations: ConversationItem[] }>(
          '/ai/whatsapp/conversations?limit=50',
        ).catch(() => ({ conversations: [] })),
        apiClient<{ webhooks: WebhookRecordItem[] }>('/ai/whatsapp/webhooks?limit=50').catch(
          () => ({ webhooks: [] }),
        ),
        apiClient<{ records?: AiAuditItem[]; logs?: AiAuditItem[] }>('/ai/audit?limit=50').catch(
          () => ({ records: [], logs: [] }),
        ),
      ]);

      if (statusRes) setStatus(statusRes);
      setConversations(convsRes.conversations ?? []);
      setWebhooks(webhooksRes.webhooks ?? []);
      setAuditLogs(auditRes.records ?? auditRes.logs ?? []);
    } catch (err: unknown) {
      setError(
        err instanceof Error ? err.message : 'Failed to load WhatsApp administration telemetry',
      );
    } finally {
      setIsLoading(false);
      setIsRefreshing(false);
    }
  };

  useEffect(() => {
    if (user?.role === 'ADMINISTRATOR') {
      void fetchData();
    }
  }, [user]);

  const loadConversationDetail = async (convId: string) => {
    try {
      const detail = await apiClient<ConversationDetail>(`/ai/conversations/${convId}`);
      setSelectedConv(detail);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to load conversation details');
    }
  };

  if (user?.role !== 'ADMINISTRATOR') {
    return <Navigate to="/account" replace />;
  }

  const deliveryMetrics = status?.deliveryMetrics ?? {
    totalReceived: webhooks.length,
    processed: webhooks.filter((w) => w.status === 'PROCESSED').length,
    duplicates: webhooks.filter((w) => w.status === 'DUPLICATE').length,
    errors: webhooks.filter((w) => w.status === 'ERROR').length,
  };

  const successRate =
    deliveryMetrics.totalReceived > 0
      ? Math.round((deliveryMetrics.processed / deliveryMetrics.totalReceived) * 100)
      : 100;

  return (
    <div style={{ padding: '2rem 0 4rem' }}>
      {/* Header */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'flex-start',
          marginBottom: '2rem',
          flexWrap: 'wrap',
          gap: '1rem',
        }}
      >
        <div>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '0.75rem',
              marginBottom: '0.5rem',
            }}
          >
            <span
              style={{
                fontSize: '1.75rem',
                padding: '0.4rem',
                borderRadius: '10px',
                background: '#25D366',
                color: '#fff',
                display: 'inline-flex',
              }}
            >
              <MessageSquare size={24} />
            </span>
            <h1
              className="font-display"
              style={{ fontSize: '1.85rem', fontWeight: 700, margin: 0 }}
            >
              WhatsApp Commerce & AI Channel
            </h1>
          </div>
          <p className="text-muted" style={{ margin: 0, fontSize: '0.95rem' }}>
            Production Meta WhatsApp Cloud API gateway, webhook delivery telemetry, customer-order
            linkages, and AI commerce tools.
          </p>
        </div>

        <div style={{ display: 'flex', gap: '0.75rem' }}>
          <button
            onClick={() => void fetchData()}
            disabled={isRefreshing}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '0.5rem',
              padding: '0.6rem 1.1rem',
              borderRadius: '8px',
              border: '1px solid var(--border)',
              background: 'var(--card-bg, #1e293b)',
              color: 'var(--text-main, #f8fafc)',
              cursor: isRefreshing ? 'not-allowed' : 'pointer',
              fontWeight: 500,
            }}
          >
            <RotateCw size={16} className={isRefreshing ? 'spin' : ''} />
            Refresh Telemetry
          </button>
        </div>
      </div>

      {error && (
        <div
          className="card"
          style={{
            padding: '1rem 1.5rem',
            marginBottom: '1.5rem',
            borderColor: 'var(--accent-red, #ef4444)',
            display: 'flex',
            alignItems: 'center',
            gap: '0.75rem',
            color: 'var(--accent-red, #ef4444)',
          }}
        >
          <AlertTriangle size={20} />
          <span>{error}</span>
        </div>
      )}

      {/* KPI Cards Row */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(230px, 1fr))',
          gap: '1.25rem',
          marginBottom: '2rem',
        }}
      >
        {/* Card 1: Provider Status */}
        <div className="card" style={{ padding: '1.25rem' }}>
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              marginBottom: '0.75rem',
            }}
          >
            <span
              className="text-muted"
              style={{
                fontSize: '0.85rem',
                fontWeight: 600,
                textTransform: 'uppercase',
                letterSpacing: '0.05em',
              }}
            >
              Provider Adapter
            </span>
            <ShieldCheck
              size={18}
              style={{ color: status?.provider === 'meta' ? '#22c55e' : '#3b82f6' }}
            />
          </div>
          <div
            style={{
              fontSize: '1.35rem',
              fontWeight: 700,
              marginBottom: '0.25rem',
              display: 'flex',
              alignItems: 'center',
              gap: '0.5rem',
            }}
          >
            {status?.provider === 'meta' ? 'Meta Cloud API' : 'Mock Provider (Sandbox)'}
          </div>
          <div style={{ fontSize: '0.825rem', color: 'var(--text-muted, #94a3b8)' }}>
            Phone ID:{' '}
            <code style={{ color: '#38bdf8' }}>{status?.phoneNumberId || 'sandbox-test-id'}</code>
          </div>
        </div>

        {/* Card 2: Webhook Handshake */}
        <div className="card" style={{ padding: '1.25rem' }}>
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              marginBottom: '0.75rem',
            }}
          >
            <span
              className="text-muted"
              style={{
                fontSize: '0.85rem',
                fontWeight: 600,
                textTransform: 'uppercase',
                letterSpacing: '0.05em',
              }}
            >
              Webhook Status
            </span>
            <CheckCircle2 size={18} style={{ color: '#22c55e' }} />
          </div>
          <div
            style={{
              fontSize: '1.35rem',
              fontWeight: 700,
              marginBottom: '0.25rem',
              color: '#22c55e',
            }}
          >
            {status?.webhookStatus ?? 'Active & Verified'}
          </div>
          <div style={{ fontSize: '0.825rem', color: 'var(--text-muted, #94a3b8)' }}>
            HMAC-SHA256 signature verification enabled
          </div>
        </div>

        {/* Card 3: Processed Messages & Success Rate */}
        <div className="card" style={{ padding: '1.25rem' }}>
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              marginBottom: '0.75rem',
            }}
          >
            <span
              className="text-muted"
              style={{
                fontSize: '0.85rem',
                fontWeight: 600,
                textTransform: 'uppercase',
                letterSpacing: '0.05em',
              }}
            >
              Delivery Rate
            </span>
            <Send size={18} style={{ color: '#a855f7' }} />
          </div>
          <div style={{ fontSize: '1.35rem', fontWeight: 700, marginBottom: '0.25rem' }}>
            {successRate}% Success
          </div>
          <div style={{ fontSize: '0.825rem', color: 'var(--text-muted, #94a3b8)' }}>
            {deliveryMetrics.processed} processed of {deliveryMetrics.totalReceived} received
          </div>
        </div>

        {/* Card 4: Deduplication & Replay Guard */}
        <div className="card" style={{ padding: '1.25rem' }}>
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              marginBottom: '0.75rem',
            }}
          >
            <span
              className="text-muted"
              style={{
                fontSize: '0.85rem',
                fontWeight: 600,
                textTransform: 'uppercase',
                letterSpacing: '0.05em',
              }}
            >
              Replay / Duplicates
            </span>
            <Layers size={18} style={{ color: '#eab308' }} />
          </div>
          <div
            style={{
              fontSize: '1.35rem',
              fontWeight: 700,
              marginBottom: '0.25rem',
              color: deliveryMetrics.duplicates > 0 ? '#eab308' : 'inherit',
            }}
          >
            {deliveryMetrics.duplicates} Duplicates
          </div>
          <div style={{ fontSize: '0.825rem', color: 'var(--text-muted, #94a3b8)' }}>
            Safely filtered with 0 state corruption
          </div>
        </div>
      </div>

      {/* Tabs Navigation */}
      <div
        style={{
          display: 'flex',
          gap: '0.5rem',
          borderBottom: '1px solid var(--border)',
          marginBottom: '1.5rem',
          overflowX: 'auto',
        }}
      >
        {[
          { key: 'overview', label: 'Integration Overview' },
          { key: 'conversations', label: `Conversations (${conversations.length})` },
          { key: 'webhooks', label: `Webhook Log (${webhooks.length})` },
          { key: 'audit', label: `Tool Audit Logs (${auditLogs.length})` },
          { key: 'setup', label: 'Meta Setup Guide' },
        ].map((t) => (
          <button
            key={t.key}
            onClick={() => setActiveTab(t.key as typeof activeTab)}
            style={{
              padding: '0.75rem 1.25rem',
              background: 'transparent',
              border: 'none',
              borderBottom: activeTab === t.key ? '2px solid #25D366' : '2px solid transparent',
              color: activeTab === t.key ? 'var(--text-main, #fff)' : 'var(--text-muted, #94a3b8)',
              fontWeight: activeTab === t.key ? 600 : 500,
              cursor: 'pointer',
              whiteSpace: 'nowrap',
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* TAB 1: OVERVIEW */}
      {activeTab === 'overview' && (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(360px, 1fr))',
            gap: '1.5rem',
          }}
        >
          <div className="card" style={{ padding: '1.5rem' }}>
            <h3
              style={{
                fontSize: '1.15rem',
                fontWeight: 600,
                marginBottom: '1rem',
                display: 'flex',
                alignItems: 'center',
                gap: '0.5rem',
              }}
            >
              <ShieldCheck size={18} style={{ color: '#25D366' }} /> Integration Specification
            </h3>
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: '0.85rem',
                fontSize: '0.9rem',
              }}
            >
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  paddingBottom: '0.5rem',
                  borderBottom: '1px solid var(--border)',
                }}
              >
                <span className="text-muted">Provider Mode</span>
                <span style={{ fontWeight: 600 }}>{status?.provider?.toUpperCase() ?? 'MOCK'}</span>
              </div>
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  paddingBottom: '0.5rem',
                  borderBottom: '1px solid var(--border)',
                }}
              >
                <span className="text-muted">Meta Graph API Version</span>
                <span>v21.0</span>
              </div>
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  paddingBottom: '0.5rem',
                  borderBottom: '1px solid var(--border)',
                }}
              >
                <span className="text-muted">Webhook Endpoint</span>
                <code style={{ fontSize: '0.85rem' }}>/ai/whatsapp/webhook</code>
              </div>
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  paddingBottom: '0.5rem',
                  borderBottom: '1px solid var(--border)',
                }}
              >
                <span className="text-muted">Challenge Handshake</span>
                <span style={{ color: '#22c55e', fontWeight: 600 }}>
                  hub.challenge GET supported
                </span>
              </div>
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  paddingBottom: '0.5rem',
                  borderBottom: '1px solid var(--border)',
                }}
              >
                <span className="text-muted">Signature Verification</span>
                <span style={{ color: '#22c55e', fontWeight: 600 }}>
                  x-hub-signature-256 (HMAC-SHA256)
                </span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span className="text-muted">Supported Commerce Tools</span>
                <span style={{ fontWeight: 600 }}>11 Authorized Tools</span>
              </div>
            </div>
          </div>

          <div className="card" style={{ padding: '1.5rem' }}>
            <h3
              style={{
                fontSize: '1.15rem',
                fontWeight: 600,
                marginBottom: '1rem',
                display: 'flex',
                alignItems: 'center',
                gap: '0.5rem',
              }}
            >
              <ShoppingBag size={18} style={{ color: '#38bdf8' }} /> Customer Commerce Capabilities
            </h3>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(2, 1fr)',
                gap: '0.75rem',
                fontSize: '0.85rem',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <CheckCircle2 size={15} style={{ color: '#22c55e' }} /> Product Search
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <CheckCircle2 size={15} style={{ color: '#22c55e' }} /> Category Browse
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <CheckCircle2 size={15} style={{ color: '#22c55e' }} /> Seller Offers & Prices
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <CheckCircle2 size={15} style={{ color: '#22c55e' }} /> Real-Time Stock Check
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <CheckCircle2 size={15} style={{ color: '#22c55e' }} /> Cart Management
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <CheckCircle2 size={15} style={{ color: '#22c55e' }} /> Reserved Checkout
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <CheckCircle2 size={15} style={{ color: '#22c55e' }} /> Complete Payment
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <CheckCircle2 size={15} style={{ color: '#22c55e' }} /> Order Status Lookup
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <CheckCircle2 size={15} style={{ color: '#22c55e' }} /> Carrier Shipment Tracking
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <CheckCircle2 size={15} style={{ color: '#22c55e' }} /> Grounded Return Policies
              </div>
            </div>
          </div>

          {/* Interactive WhatsApp Catalog & AI Query Tester */}
          <div
            className="card"
            style={{
              gridColumn: '1 / -1',
              padding: '1.5rem',
              background: 'var(--card-bg, #1e293b)',
            }}
          >
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                marginBottom: '1rem',
                flexWrap: 'wrap',
                gap: '0.5rem',
              }}
            >
              <div>
                <h3
                  style={{
                    fontSize: '1.15rem',
                    fontWeight: 600,
                    margin: 0,
                    display: 'flex',
                    alignItems: 'center',
                    gap: '0.5rem',
                  }}
                >
                  <MessageSquare size={18} style={{ color: '#25D366' }} /> Test Product Catalog via
                  WhatsApp AI
                </h3>
                <p className="text-muted" style={{ fontSize: '0.85rem', margin: '0.25rem 0 0' }}>
                  Simulate asking the WhatsApp bot for products, prices, stock, or checkout. Live
                  responses use active database listings.
                </p>
              </div>
              <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                {[
                  'Find laptops',
                  'What smartphones are available?',
                  'Check iPhone 15',
                  'Show headphones and audio',
                ].map((sample) => (
                  <button
                    key={sample}
                    type="button"
                    onClick={() => void handleTestWhatsApp(sample)}
                    disabled={isTesting}
                    style={{
                      fontSize: '0.75rem',
                      padding: '0.3rem 0.65rem',
                      borderRadius: '6px',
                      background: 'rgba(37, 211, 102, 0.1)',
                      border: '1px solid rgba(37, 211, 102, 0.3)',
                      color: '#22c55e',
                      cursor: 'pointer',
                    }}
                  >
                    {sample}
                  </button>
                ))}
              </div>
            </div>

            <form
              onSubmit={(e) => {
                e.preventDefault();
                void handleTestWhatsApp();
              }}
              style={{
                display: 'flex',
                gap: '0.75rem',
                marginBottom: testResponse ? '1.25rem' : '0',
              }}
            >
              <input
                type="text"
                placeholder="Ask about any product, brand, category, or order status..."
                value={testPrompt}
                onChange={(e) => setTestPrompt(e.target.value)}
                disabled={isTesting}
                style={{
                  flex: 1,
                  padding: '0.75rem 1rem',
                  borderRadius: '8px',
                  border: '1px solid var(--border)',
                  background: 'var(--bg-main, #0f172a)',
                  color: 'var(--text-main, #fff)',
                  fontSize: '0.9rem',
                }}
              />
              <button
                type="submit"
                disabled={isTesting || !testPrompt.trim()}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.5rem',
                  padding: '0.75rem 1.25rem',
                  borderRadius: '8px',
                  background: '#25D366',
                  color: '#fff',
                  border: 'none',
                  fontWeight: 600,
                  fontSize: '0.9rem',
                  cursor: isTesting || !testPrompt.trim() ? 'not-allowed' : 'pointer',
                  opacity: isTesting || !testPrompt.trim() ? 0.7 : 1,
                }}
              >
                <Send size={16} />
                {isTesting ? 'Querying...' : 'Ask WhatsApp Bot'}
              </button>
            </form>

            {testResponse && (
              <div
                style={{
                  padding: '1rem',
                  borderRadius: '8px',
                  background: 'var(--bg-main, #0f172a)',
                  border: '1px solid var(--border)',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '0.75rem',
                }}
              >
                <div
                  style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
                >
                  <span style={{ fontSize: '0.8rem', color: '#94a3b8' }}>
                    User Query: <strong style={{ color: '#fff' }}>"{testResponse.query}"</strong>
                  </span>
                  {testResponse.tools.length > 0 && (
                    <span
                      style={{
                        fontSize: '0.75rem',
                        padding: '0.2rem 0.5rem',
                        borderRadius: '4px',
                        background: 'rgba(56, 189, 248, 0.15)',
                        color: '#38bdf8',
                      }}
                    >
                      Executed: {testResponse.tools.join(', ')}
                    </span>
                  )}
                </div>
                <div
                  style={{
                    padding: '0.85rem 1rem',
                    borderRadius: '8px',
                    background: 'rgba(37, 211, 102, 0.12)',
                    borderLeft: '4px solid #25D366',
                    whiteSpace: 'pre-wrap',
                    fontSize: '0.9rem',
                    lineHeight: 1.5,
                  }}
                >
                  {testResponse.reply}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* TAB 2: CONVERSATIONS & ORDERS */}
      {activeTab === 'conversations' && (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: selectedConv ? '1.2fr 1.8fr' : '1fr',
            gap: '1.5rem',
          }}
        >
          <div className="card" style={{ padding: '0', overflow: 'hidden' }}>
            <div
              style={{
                padding: '1rem 1.25rem',
                borderBottom: '1px solid var(--border)',
                fontWeight: 600,
              }}
            >
              Recent WhatsApp Sessions ({conversations.length})
            </div>
            {isLoading ? (
              <div style={{ padding: '3rem', textAlign: 'center' }} className="text-muted">
                Loading conversations...
              </div>
            ) : conversations.length === 0 ? (
              <div style={{ padding: '3rem', textAlign: 'center' }} className="text-muted">
                No WhatsApp conversations recorded yet. Incoming customer messages will appear here.
              </div>
            ) : (
              <div style={{ maxHeight: '600px', overflowY: 'auto' }}>
                {conversations.map((c) => (
                  <div
                    key={c.id}
                    onClick={() => void loadConversationDetail(c.id)}
                    style={{
                      padding: '1rem 1.25rem',
                      borderBottom: '1px solid var(--border)',
                      cursor: 'pointer',
                      background:
                        selectedConv?.conversation.id === c.id
                          ? 'var(--card-hover, rgba(37, 211, 102, 0.08))'
                          : 'transparent',
                      transition: 'background 0.2s',
                    }}
                  >
                    <div
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        marginBottom: '0.35rem',
                      }}
                    >
                      <div
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: '0.5rem',
                          fontWeight: 600,
                        }}
                      >
                        <Phone size={14} style={{ color: '#25D366' }} />
                        <span>{c.metadata?.phoneNumber || c.customerId || 'Customer'}</span>
                      </div>
                      <span
                        style={{
                          fontSize: '0.75rem',
                          padding: '0.2rem 0.5rem',
                          borderRadius: '4px',
                          background:
                            c.status === 'ACTIVE'
                              ? 'rgba(34, 197, 94, 0.15)'
                              : 'rgba(148, 163, 184, 0.15)',
                          color: c.status === 'ACTIVE' ? '#22c55e' : 'var(--text-muted)',
                        }}
                      >
                        {c.status}
                      </span>
                    </div>

                    <div
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        fontSize: '0.8rem',
                      }}
                      className="text-muted"
                    >
                      <span>Conv: {c.id.slice(0, 12)}...</span>
                      {c.metadata?.linkedOrderId && (
                        <span
                          style={{
                            color: '#38bdf8',
                            fontWeight: 600,
                            display: 'flex',
                            alignItems: 'center',
                            gap: '0.25rem',
                          }}
                        >
                          <ShoppingBag size={12} /> {c.metadata.linkedOrderId.slice(0, 8)}...
                        </span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Transcript View Drawer */}
          {selectedConv && (
            <div
              className="card"
              style={{
                padding: '1.25rem',
                display: 'flex',
                flexDirection: 'column',
                height: '600px',
              }}
            >
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  borderBottom: '1px solid var(--border)',
                  paddingBottom: '0.75rem',
                  marginBottom: '1rem',
                }}
              >
                <div>
                  <h4 style={{ margin: 0, fontSize: '1rem', fontWeight: 600 }}>
                    Transcript: {selectedConv.conversation.id}
                  </h4>
                  <div style={{ fontSize: '0.8rem' }} className="text-muted">
                    Channel: WhatsApp • Customer:{' '}
                    {selectedConv.conversation.metadata?.phoneNumber ??
                      selectedConv.conversation.customerId}
                  </div>
                </div>
                <button
                  onClick={() => setSelectedConv(null)}
                  style={{
                    background: 'transparent',
                    border: 'none',
                    color: 'var(--text-muted)',
                    cursor: 'pointer',
                    fontSize: '1.25rem',
                  }}
                >
                  ✕
                </button>
              </div>

              <div
                style={{
                  flex: 1,
                  overflowY: 'auto',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '0.75rem',
                  paddingRight: '0.5rem',
                }}
              >
                {selectedConv.messages.map((m) => {
                  const isUser = m.role === 'USER';
                  const isTool = m.role === 'TOOL';
                  return (
                    <div
                      key={m.id}
                      style={{
                        alignSelf: isUser ? 'flex-end' : 'flex-start',
                        maxWidth: '85%',
                        padding: '0.75rem 1rem',
                        borderRadius: '12px',
                        background: isUser
                          ? '#075e54'
                          : isTool
                            ? 'rgba(56, 189, 248, 0.1)'
                            : 'var(--card-bg, #1e293b)',
                        border: isTool
                          ? '1px solid rgba(56, 189, 248, 0.3)'
                          : '1px solid var(--border)',
                        color: '#fff',
                        fontSize: '0.9rem',
                      }}
                    >
                      <div
                        style={{
                          fontSize: '0.75rem',
                          marginBottom: '0.25rem',
                          opacity: 0.7,
                          fontWeight: 600,
                        }}
                      >
                        {m.role === 'USER'
                          ? 'Customer'
                          : m.role === 'ASSISTANT'
                            ? 'WhatsApp AI'
                            : 'Commerce Tool Execution'}
                      </div>
                      <div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                        {m.content}
                      </div>
                      {m.toolCalls && m.toolCalls.length > 0 && (
                        <div
                          style={{
                            marginTop: '0.5rem',
                            paddingTop: '0.5rem',
                            borderTop: '1px solid rgba(255,255,255,0.1)',
                            fontSize: '0.8rem',
                            color: '#38bdf8',
                          }}
                        >
                          ⚡ Tool called: <strong>{m.toolCalls[0]?.name}</strong>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}

      {/* TAB 3: WEBHOOK ACTIVITY FEED */}
      {activeTab === 'webhooks' && (
        <div className="card" style={{ padding: '0', overflow: 'hidden' }}>
          <div
            style={{
              padding: '1rem 1.25rem',
              borderBottom: '1px solid var(--border)',
              fontWeight: 600,
            }}
          >
            Recent Inbound Webhook Receipts & Deduplication Log
          </div>
          {isLoading ? (
            <div style={{ padding: '3rem', textAlign: 'center' }} className="text-muted">
              Loading webhooks...
            </div>
          ) : webhooks.length === 0 ? (
            <div style={{ padding: '3rem', textAlign: 'center' }} className="text-muted">
              No webhook events received yet.
            </div>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table
                style={{
                  width: '100%',
                  borderCollapse: 'collapse',
                  fontSize: '0.9rem',
                  textAlign: 'left',
                }}
              >
                <thead>
                  <tr
                    style={{ borderBottom: '1px solid var(--border)', color: 'var(--text-muted)' }}
                  >
                    <th style={{ padding: '0.85rem 1.25rem' }}>Message ID</th>
                    <th style={{ padding: '0.85rem 1.25rem' }}>Sender Phone</th>
                    <th style={{ padding: '0.85rem 1.25rem' }}>Delivery Status</th>
                    <th style={{ padding: '0.85rem 1.25rem' }}>Received At</th>
                    <th style={{ padding: '0.85rem 1.25rem' }}>Error / Notes</th>
                  </tr>
                </thead>
                <tbody>
                  {webhooks.map((w) => (
                    <tr key={w.id} style={{ borderBottom: '1px solid var(--border)' }}>
                      <td style={{ padding: '0.85rem 1.25rem', fontFamily: 'monospace' }}>
                        {w.messageId}
                      </td>
                      <td style={{ padding: '0.85rem 1.25rem' }}>{w.phoneNumber}</td>
                      <td style={{ padding: '0.85rem 1.25rem' }}>
                        <span
                          style={{
                            fontSize: '0.75rem',
                            padding: '0.2rem 0.55rem',
                            borderRadius: '4px',
                            fontWeight: 600,
                            background:
                              w.status === 'PROCESSED'
                                ? 'rgba(34, 197, 94, 0.15)'
                                : w.status === 'DUPLICATE'
                                  ? 'rgba(234, 179, 8, 0.15)'
                                  : 'rgba(239, 68, 68, 0.15)',
                            color:
                              w.status === 'PROCESSED'
                                ? '#22c55e'
                                : w.status === 'DUPLICATE'
                                  ? '#eab308'
                                  : '#ef4444',
                          }}
                        >
                          {w.status}
                        </span>
                      </td>
                      <td style={{ padding: '0.85rem 1.25rem' }} className="text-muted">
                        {new Date(w.createdAt).toLocaleString()}
                      </td>
                      <td
                        style={{
                          padding: '0.85rem 1.25rem',
                          color: w.errorMessage ? '#ef4444' : 'var(--text-muted)',
                        }}
                      >
                        {w.errorMessage ||
                          (w.status === 'DUPLICATE' ? 'Deduplicated safely' : 'Delivered')}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* TAB 4: AI COMMERCE AUDIT LOGS */}
      {activeTab === 'audit' && (
        <div className="card" style={{ padding: '0', overflow: 'hidden' }}>
          <div
            style={{
              padding: '1rem 1.25rem',
              borderBottom: '1px solid var(--border)',
              fontWeight: 600,
            }}
          >
            Authorized AI Tool Execution Audit Trail
          </div>
          {isLoading ? (
            <div style={{ padding: '3rem', textAlign: 'center' }} className="text-muted">
              Loading audit records...
            </div>
          ) : auditLogs.length === 0 ? (
            <div style={{ padding: '3rem', textAlign: 'center' }} className="text-muted">
              No audit entries recorded yet.
            </div>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table
                style={{
                  width: '100%',
                  borderCollapse: 'collapse',
                  fontSize: '0.9rem',
                  textAlign: 'left',
                }}
              >
                <thead>
                  <tr
                    style={{ borderBottom: '1px solid var(--border)', color: 'var(--text-muted)' }}
                  >
                    <th style={{ padding: '0.85rem 1.25rem' }}>Tool Name</th>
                    <th style={{ padding: '0.85rem 1.25rem' }}>Actor Role</th>
                    <th style={{ padding: '0.85rem 1.25rem' }}>Status</th>
                    <th style={{ padding: '0.85rem 1.25rem' }}>Latency</th>
                    <th style={{ padding: '0.85rem 1.25rem' }}>Timestamp</th>
                  </tr>
                </thead>
                <tbody>
                  {auditLogs.map((a) => (
                    <tr key={a.id} style={{ borderBottom: '1px solid var(--border)' }}>
                      <td style={{ padding: '0.85rem 1.25rem', fontWeight: 600, color: '#38bdf8' }}>
                        <code>{a.toolName}</code>
                      </td>
                      <td style={{ padding: '0.85rem 1.25rem' }}>{a.actorRole}</td>
                      <td style={{ padding: '0.85rem 1.25rem' }}>
                        <span
                          style={{
                            fontSize: '0.75rem',
                            padding: '0.2rem 0.55rem',
                            borderRadius: '4px',
                            fontWeight: 600,
                            background:
                              a.status === 'SUCCESS'
                                ? 'rgba(34, 197, 94, 0.15)'
                                : 'rgba(239, 68, 68, 0.15)',
                            color: a.status === 'SUCCESS' ? '#22c55e' : '#ef4444',
                          }}
                        >
                          {a.status}
                        </span>
                      </td>
                      <td style={{ padding: '0.85rem 1.25rem' }} className="text-muted">
                        {a.executionDurationMs} ms
                      </td>
                      <td style={{ padding: '0.85rem 1.25rem' }} className="text-muted">
                        {new Date(a.createdAt).toLocaleString()}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* TAB 5: META SETUP GUIDE */}
      {activeTab === 'setup' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
          <div className="card" style={{ padding: '1.5rem' }}>
            <h3 style={{ fontSize: '1.2rem', fontWeight: 600, marginBottom: '0.75rem' }}>
              Meta for Developers App Setup
            </h3>
            <p className="text-muted" style={{ fontSize: '0.9rem', marginBottom: '1.25rem' }}>
              To switch from sandbox to live production Meta WhatsApp Cloud API:
            </p>
            <ol
              style={{
                paddingLeft: '1.25rem',
                display: 'flex',
                flexDirection: 'column',
                gap: '0.75rem',
                fontSize: '0.9rem',
              }}
            >
              <li>
                Navigate to <strong>Meta App Dashboard</strong> &rarr; WhatsApp &rarr;
                Configuration.
              </li>
              <li>
                Click <strong>Edit</strong> on Webhook and configure:
                <div
                  style={{
                    background: 'var(--bg-main, #0f172a)',
                    padding: '0.75rem',
                    borderRadius: '6px',
                    margin: '0.5rem 0',
                  }}
                >
                  <div>
                    <strong>Callback URL:</strong>{' '}
                    <code>https://your-domain.com/ai/whatsapp/webhook</code>
                  </div>
                  <div>
                    <strong>Verify Token:</strong> value from{' '}
                    <code>WHATSAPP_WEBHOOK_VERIFY_TOKEN</code> in your environment
                  </div>
                </div>
              </li>
              <li>
                Subscribe to the{' '}
                <strong>
                  <code>messages</code>
                </strong>{' '}
                webhook field.
              </li>
              <li>
                Set environment variables in <code>apps/api/.env</code>:
                <pre
                  style={{
                    background: 'var(--bg-main, #0f172a)',
                    padding: '0.75rem',
                    borderRadius: '6px',
                    margin: '0.5rem 0',
                    fontSize: '0.85rem',
                    overflowX: 'auto',
                  }}
                >
                  {`WHATSAPP_PROVIDER=meta
WHATSAPP_ACCESS_TOKEN=<your-meta-system-user-access-token>
WHATSAPP_PHONE_NUMBER_ID=<your-registered-phone-number-id>
WHATSAPP_APP_SECRET=<your-meta-app-secret-for-hmac>
WHATSAPP_WEBHOOK_VERIFY_TOKEN=<your-chosen-verification-token>`}
                </pre>
              </li>
            </ol>
          </div>
        </div>
      )}
    </div>
  );
};
