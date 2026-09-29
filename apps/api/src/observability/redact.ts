const DEFAULT_REDACT_KEYS = [
  'password',
  'token',
  'secret',
  'authorization',
  'creditcard',
  'apikey',
  'cookie',
  'session',
];

export function createRedactor(customKeys: string[] = []): (data: unknown) => unknown {
  const keysToRedact = new Set([...DEFAULT_REDACT_KEYS, ...customKeys].map((k) => k.toLowerCase()));

  function redactValue(val: unknown, depth = 0): unknown {
    if (depth > 6) return '[MAX_DEPTH_EXCEEDED]';
    if (val === null || val === undefined) return val;
    if (typeof val !== 'object') return val;

    if (Array.isArray(val)) {
      return val.map((item) => redactValue(item, depth + 1));
    }

    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(val as Record<string, unknown>)) {
      if (keysToRedact.has(key.toLowerCase())) {
        result[key] = '[REDACTED]';
      } else {
        result[key] = redactValue(value, depth + 1);
      }
    }
    return result;
  }

  return (data: unknown) => redactValue(data, 0);
}
