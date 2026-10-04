import { useState, useRef, useEffect } from 'react';
import { aiApi } from './api/ai';
import { useAuth } from '../auth/AuthContext';

interface ChatMessage {
  id: string;
  sender: 'user' | 'assistant';
  text: string;
  tools?: string[];
  sources?: string[];
  timestamp: string;
}

export const AiAssistant = () => {
  const { isAuthenticated } = useAuth();
  const [isOpen, setIsOpen] = useState(false);
  const [input, setInput] = useState('');
  const [conversationId, setConversationId] = useState<string | undefined>(undefined);
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: 'welcome',
      sender: 'assistant',
      text: 'Hello! I am your AI Shopping & Support Assistant. I can help you find products, check live inventory, track your orders, or explain our store policies. How may I assist you today?',
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    },
  ]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const messagesEndRef = useRef<HTMLDivElement>(null);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    if (isOpen) {
      scrollToBottom();
    }
  }, [messages, isOpen]);

  const handleSend = async (messageText?: string) => {
    const textToSend = (messageText ?? input).trim();
    if (!textToSend || isLoading) return;

    if (!isAuthenticated) {
      setError('Please log in with any account to converse with the AI Assistant.');
      return;
    }

    const userMessage: ChatMessage = {
      id: `usr-${Date.now()}`,
      sender: 'user',
      text: textToSend,
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    };

    setMessages((prev) => [...prev, userMessage]);
    setInput('');
    setError(null);
    setIsLoading(true);

    try {
      const response = await aiApi.sendMessage({
        message: textToSend,
        conversationId,
        channel: 'WEB',
      });

      if (response.conversationId) {
        setConversationId(response.conversationId);
      }

      const assistantMessage: ChatMessage = {
        id: `ast-${Date.now()}`,
        sender: 'assistant',
        text: response.replyText,
        tools: response.toolCallsExecuted,
        sources: response.sourcesRetrieved,
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      };

      setMessages((prev) => [...prev, assistantMessage]);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to reach AI service.');
    } finally {
      setIsLoading(false);
    }
  };

  const promptSuggestions = [
    'What headphones are in stock?',
    'Where is my order?',
    'What is your return policy?',
    'Are there any wireless earbuds under ₹5000?',
  ];

  return (
    <>
      {/* Floating Toggle Button */}
      <button
        type="button"
        id="ai-assistant-toggle"
        onClick={() => setIsOpen((prev) => !prev)}
        style={{
          position: 'fixed',
          bottom: '24px',
          right: '24px',
          zIndex: 9999,
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          padding: '12px 20px',
          borderRadius: '999px',
          background: 'linear-gradient(135deg, var(--brand) 0%, #3b82f6 100%)',
          color: '#ffffff',
          fontWeight: 600,
          border: 'none',
          boxShadow: '0 8px 24px rgba(37, 99, 235, 0.4)',
          cursor: 'pointer',
          transition: 'all 0.2s cubic-bezier(0.4, 0, 0.2, 1)',
        }}
      >
        <span style={{ fontSize: '1.25rem' }}>✨</span>
        <span>{isOpen ? 'Close' : 'Assistant'}</span>
      </button>

      {/* Slide-out Drawer / Chat Window */}
      {isOpen && (
        <div
          role="dialog"
          aria-label="AI Shopping Assistant"
          style={{
            position: 'fixed',
            bottom: '88px',
            right: '24px',
            width: '400px',
            maxWidth: 'calc(100vw - 32px)',
            height: '560px',
            maxHeight: 'calc(100vh - 120px)',
            background: 'var(--bg-card)',
            border: '1px solid var(--border)',
            borderRadius: '16px',
            boxShadow: '0 20px 40px rgba(0, 0, 0, 0.25)',
            display: 'flex',
            flexDirection: 'column',
            zIndex: 9998,
            overflow: 'hidden',
          }}
        >
          {/* Header */}
          <div
            style={{
              padding: '1rem',
              background: 'linear-gradient(135deg, rgba(37, 99, 235, 0.1) 0%, rgba(59, 130, 246, 0.05) 100%)',
              borderBottom: '1px solid var(--border)',
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
            }}
          >
            <div>
              <div style={{ fontWeight: 700, fontSize: '1.05rem', display: 'flex', alignItems: 'center', gap: '6px' }}>
                <span>✨ AI Commerce Assistant</span>
              </div>
              <div style={{ fontSize: '0.75rem', color: 'var(--primary-muted)' }}>
                Authorized Tools • Live Inventory • Order Tracking
              </div>
            </div>
            <button
              type="button"
              onClick={() => setIsOpen(false)}
              style={{
                background: 'transparent',
                border: 'none',
                fontSize: '1.2rem',
                cursor: 'pointer',
                color: 'var(--primary-muted)',
              }}
              aria-label="Close"
            >
              ✕
            </button>
          </div>

          {/* Messages Area */}
          <div
            style={{
              flex: 1,
              overflowY: 'auto',
              padding: '1rem',
              display: 'flex',
              flexDirection: 'column',
              gap: '0.85rem',
            }}
          >
            {messages.map((msg) => (
              <div
                key={msg.id}
                style={{
                  alignSelf: msg.sender === 'user' ? 'flex-end' : 'flex-start',
                  maxWidth: '85%',
                }}
              >
                <div
                  style={{
                    padding: '0.75rem 1rem',
                    borderRadius: msg.sender === 'user' ? '14px 14px 2px 14px' : '14px 14px 14px 2px',
                    background: msg.sender === 'user' ? 'var(--brand)' : 'var(--bg-main)',
                    color: msg.sender === 'user' ? '#ffffff' : 'var(--text-main)',
                    border: msg.sender === 'user' ? 'none' : '1px solid var(--border)',
                    fontSize: '0.9rem',
                    lineHeight: 1.45,
                    whiteSpace: 'pre-wrap',
                  }}
                >
                  {msg.text}
                </div>

                {/* Tool execution badge */}
                {msg.tools && msg.tools.length > 0 && (
                  <div style={{ marginTop: '4px', display: 'flex', flexWrap: 'wrap', gap: '4px' }}>
                    {msg.tools.map((tool) => (
                      <span
                        key={tool}
                        style={{
                          fontSize: '0.7rem',
                          padding: '2px 6px',
                          borderRadius: '4px',
                          background: 'rgba(34, 197, 94, 0.12)',
                          color: 'var(--accent-green)',
                          fontWeight: 500,
                        }}
                      >
                        ⚡ Used Tool: {tool}
                      </span>
                    ))}
                  </div>
                )}

                {/* Sources badge */}
                {msg.sources && msg.sources.length > 0 && (
                  <div style={{ marginTop: '4px', display: 'flex', flexWrap: 'wrap', gap: '4px' }}>
                    {msg.sources.map((src) => (
                      <span
                        key={src}
                        style={{
                          fontSize: '0.7rem',
                          padding: '2px 6px',
                          borderRadius: '4px',
                          background: 'rgba(59, 130, 246, 0.12)',
                          color: 'var(--brand)',
                          fontWeight: 500,
                        }}
                      >
                        📄 Policy: {src}
                      </span>
                    ))}
                  </div>
                )}

                <div
                  style={{
                    fontSize: '0.65rem',
                    color: 'var(--primary-muted)',
                    marginTop: '2px',
                    textAlign: msg.sender === 'user' ? 'right' : 'left',
                  }}
                >
                  {msg.timestamp}
                </div>
              </div>
            ))}

            {isLoading && (
              <div style={{ alignSelf: 'flex-start', padding: '0.5rem 1rem', color: 'var(--primary-muted)', fontSize: '0.85rem' }}>
                <span className="animate-pulse">Thinking & querying backend capabilities...</span>
              </div>
            )}

            <div ref={messagesEndRef} />
          </div>

          {/* Quick Prompt Suggestions */}
          <div
            style={{
              padding: '0.5rem 1rem',
              background: 'var(--bg-main)',
              borderTop: '1px solid var(--border)',
              display: 'flex',
              gap: '6px',
              overflowX: 'auto',
              whiteSpace: 'nowrap',
            }}
          >
            {promptSuggestions.map((prompt) => (
              <button
                key={prompt}
                type="button"
                onClick={() => handleSend(prompt)}
                disabled={isLoading}
                style={{
                  fontSize: '0.75rem',
                  padding: '4px 10px',
                  borderRadius: '999px',
                  border: '1px solid var(--border)',
                  background: 'var(--bg-card)',
                  color: 'var(--primary-muted)',
                  cursor: 'pointer',
                  flexShrink: 0,
                }}
              >
                {prompt}
              </button>
            ))}
          </div>

          {/* Error Banner */}
          {error && (
            <div
              style={{
                padding: '0.5rem 1rem',
                background: 'rgba(239, 68, 68, 0.1)',
                color: 'var(--accent-red)',
                fontSize: '0.8rem',
                borderTop: '1px solid rgba(239, 68, 68, 0.2)',
              }}
            >
              {error}
            </div>
          )}

          {/* Input Bar */}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              handleSend();
            }}
            style={{
              padding: '0.75rem 1rem',
              borderTop: '1px solid var(--border)',
              display: 'flex',
              gap: '8px',
              background: 'var(--bg-card)',
            }}
          >
            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder={isAuthenticated ? "Ask about products, orders, stock..." : "Please log in to chat..."}
              disabled={isLoading || !isAuthenticated}
              style={{
                flex: 1,
                padding: '0.6rem 0.85rem',
                borderRadius: '8px',
                border: '1px solid var(--border)',
                background: 'var(--bg-main)',
                color: 'var(--text-main)',
                fontSize: '0.9rem',
                outline: 'none',
              }}
            />
            <button
              type="submit"
              disabled={isLoading || !input.trim() || !isAuthenticated}
              className="btn btn-primary"
              style={{ padding: '0.6rem 1rem', fontSize: '0.9rem' }}
            >
              Send
            </button>
          </form>
        </div>
      )}
    </>
  );
};
