import { describe, it, expect } from 'vitest';
import { JsonLogger } from '../src/observability/logger.js';
import { createRedactor } from '../src/observability/redact.js';

describe('Observability & Redaction', () => {
  it('redacts sensitive keys recursively', () => {
    const redactor = createRedactor(['apiKey', 'customSecret']);
    const sensitivePayload = {
      user: 'alice',
      password: 'super-secret-password',
      auth: {
        token: 'jwt-token-value',
        nested: {
          apiKey: 'secret-key-12345',
        },
      },
      safeField: 42,
    };

    const redacted = redactor(sensitivePayload) as Record<string, unknown>;
    expect(redacted['user']).toBe('alice');
    expect(redacted['password']).toBe('[REDACTED]');
    expect((redacted['auth'] as Record<string, unknown>)['token']).toBe('[REDACTED]');
    expect(
      ((redacted['auth'] as Record<string, unknown>)['nested'] as Record<string, unknown>)[
        'apiKey'
      ],
    ).toBe('[REDACTED]');
    expect(redacted['safeField']).toBe(42);
  });

  it('outputs structured JSON logs with metadata and service name', () => {
    const lines: string[] = [];
    const logger = new JsonLogger({
      serviceName: 'test-service',
      level: 'info',
      pretty: false,
      sink: (line) => lines.push(line),
    });

    logger.info('Test log event', { userId: '123', password: 'secretpassword' });

    expect(lines.length).toBe(1);
    const parsed = JSON.parse(lines[0]!);
    expect(parsed.level).toBe('info');
    expect(parsed.service).toBe('test-service');
    expect(parsed.message).toBe('Test log event');
    expect(parsed.userId).toBe('123');
    expect(parsed.password).toBe('[REDACTED]');
    expect(parsed.timestamp).toBeDefined();
  });
});
