import { useState, useRef, useEffect } from 'react';
import { FileText, MessageCircle, Send, Wrench, X } from 'lucide-react';
import { aiApi } from './api/ai';
import { useAuth } from '../auth/AuthContext';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Badge } from '../../components/ui/badge';
import { cn } from '../../lib/utils';

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
      text: 'Hello! I can help you find products, check stock, track orders, or explain store policies. What do you need?',
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
      setError('Sign in to chat with the assistant.');
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
      setError(err instanceof Error ? err.message : 'Could not reach the assistant service.');
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
      <Button
        id="ai-assistant-toggle"
        onClick={() => setIsOpen((prev) => !prev)}
        aria-expanded={isOpen}
        className="fixed bottom-4 right-4 z-40 rounded-full shadow-md"
      >
        <MessageCircle aria-hidden />
        {isOpen ? 'Close' : 'Assistant'}
      </Button>

      {isOpen && (
        <div
          role="dialog"
          aria-label="Shopping assistant"
          className="fixed bottom-16 right-4 z-40 flex h-[min(560px,calc(100vh-120px))] w-[min(400px,calc(100vw-2rem))] flex-col overflow-hidden rounded-lg border border-border bg-background shadow-md"
        >
          <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
            <div>
              <p className="text-sm font-semibold">Assistant</p>
              <p className="text-xs text-muted-foreground">Inventory · orders · policies</p>
            </div>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setIsOpen(false)}
              aria-label="Close assistant"
            >
              <X />
            </Button>
          </div>

          <div className="flex flex-1 flex-col gap-2 overflow-y-auto p-3">
            {messages.map((msg) => (
              <div
                key={msg.id}
                className={cn('max-w-[85%]', msg.sender === 'user' ? 'self-end' : 'self-start')}
              >
                <div
                  className={cn(
                    'whitespace-pre-wrap rounded-md px-2.5 py-2 text-[13px] leading-relaxed',
                    msg.sender === 'user'
                      ? 'bg-primary text-primary-foreground'
                      : 'border border-border bg-muted',
                  )}
                >
                  {msg.text}
                </div>

                {msg.tools && msg.tools.length > 0 && (
                  <div className="mt-1 flex flex-wrap gap-1">
                    {msg.tools.map((tool) => (
                      <Badge key={tool} variant="success">
                        <Wrench aria-hidden />
                        {tool}
                      </Badge>
                    ))}
                  </div>
                )}

                {msg.sources && msg.sources.length > 0 && (
                  <div className="mt-1 flex flex-wrap gap-1">
                    {msg.sources.map((src) => (
                      <Badge key={src} variant="outline">
                        <FileText aria-hidden />
                        {src}
                      </Badge>
                    ))}
                  </div>
                )}

                <p
                  className={cn(
                    'mt-0.5 text-xs text-muted-foreground',
                    msg.sender === 'user' ? 'text-right' : 'text-left',
                  )}
                >
                  {msg.timestamp}
                </p>
              </div>
            ))}

            {isLoading && (
              <p className="animate-pulse text-[13px] text-muted-foreground">
                Working on your request…
              </p>
            )}

            <div ref={messagesEndRef} />
          </div>

          <div className="flex gap-1 overflow-x-auto border-t border-border bg-muted px-3 py-1.5">
            {promptSuggestions.map((prompt) => (
              <Button
                key={prompt}
                type="button"
                variant="outline"
                size="sm"
                className="shrink-0 rounded-full"
                onClick={() => handleSend(prompt)}
                disabled={isLoading}
              >
                {prompt}
              </Button>
            ))}
          </div>

          {error && (
            <p
              role="alert"
              className="border-t border-destructive/30 bg-destructive/5 px-3 py-1.5 text-xs text-destructive"
            >
              {error}
            </p>
          )}

          <form
            onSubmit={(e) => {
              e.preventDefault();
              handleSend();
            }}
            className="flex gap-1.5 border-t border-border p-2.5"
          >
            <Input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder={
                isAuthenticated ? 'Ask about products, orders, stock…' : 'Sign in to chat…'
              }
              disabled={isLoading || !isAuthenticated}
              aria-label="Message the assistant"
            />
            <Button
              type="submit"
              size="sm"
              className="h-8"
              disabled={isLoading || !input.trim() || !isAuthenticated}
            >
              <Send aria-hidden />
              Send
            </Button>
          </form>
        </div>
      )}
    </>
  );
};
