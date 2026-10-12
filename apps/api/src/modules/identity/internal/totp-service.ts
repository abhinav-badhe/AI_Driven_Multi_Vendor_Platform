import { randomBytes, createHmac, createHash, timingSafeEqual } from 'node:crypto';

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buffer: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = '';

  for (let i = 0; i < buffer.length; i++) {
    value = (value << 8) | buffer[i]!;
    bits += 8;

    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }

  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }

  return output;
}

export function base32Decode(base32: string): Buffer {
  const clean = base32.toUpperCase().replace(/=+$/, '').replace(/\s+/g, '');
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];

  for (let i = 0; i < clean.length; i++) {
    const idx = BASE32_ALPHABET.indexOf(clean[i]!);
    if (idx === -1) {
      throw new Error(`Invalid Base32 character: ${clean[i]}`);
    }

    value = (value << 5) | idx;
    bits += 5;

    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }

  return Buffer.from(bytes);
}

export interface TotpOptions {
  stepSeconds?: number;
  digits?: number;
}

/**
 * Generate a 6-digit TOTP code for a given timestamp and secret.
 */
export function generateTotpCode(
  secretBase32: string,
  timestampMs = Date.now(),
  options?: TotpOptions,
): string {
  const step = options?.stepSeconds ?? 30;
  const digits = options?.digits ?? 6;
  const counter = Math.floor(timestampMs / 1000 / step);

  const key = base32Decode(secretBase32);

  // 8-byte big-endian counter buffer
  const counterBuf = Buffer.alloc(8);
  counterBuf.writeBigUInt64BE(BigInt(counter), 0);

  const hmac = createHmac('sha1', key).update(counterBuf).digest();

  // Dynamic truncation (RFC 4226)
  const offset = hmac[hmac.length - 1]! & 0x0f;
  const binary =
    ((hmac[offset]! & 0x7f) << 24) |
    ((hmac[offset + 1]! & 0xff) << 16) |
    ((hmac[offset + 2]! & 0xff) << 8) |
    (hmac[offset + 3]! & 0xff);

  const mod = 10 ** digits;
  const otp = (binary % mod).toString().padStart(digits, '0');
  return otp;
}

/**
 * Verify a 6-digit TOTP code with clock-drift tolerance (±1 step / 30 seconds).
 */
export function verifyTotpCode(
  secretBase32: string,
  userCode: string,
  timestampMs = Date.now(),
  options?: TotpOptions & { window?: number },
): boolean {
  if (!userCode || typeof userCode !== 'string') return false;
  const normalizedUserCode = userCode.trim().replace(/\s+/g, '');
  if (normalizedUserCode.length !== (options?.digits ?? 6)) return false;

  const window = options?.window ?? 1; // ±1 window = ±30s
  const step = (options?.stepSeconds ?? 30) * 1000;

  for (let offset = -window; offset <= window; offset++) {
    const candidateTime = timestampMs + offset * step;
    try {
      const expectedCode = generateTotpCode(secretBase32, candidateTime, options);
      if (
        expectedCode.length === normalizedUserCode.length &&
        timingSafeEqual(Buffer.from(expectedCode), Buffer.from(normalizedUserCode))
      ) {
        return true;
      }
    } catch {
      return false;
    }
  }

  return false;
}

/**
 * Generate a new random 20-byte Base32 secret for TOTP.
 */
export function generateTotpSecret(): string {
  const bytes = randomBytes(20);
  return base32Encode(bytes);
}

/**
 * Construct standard otpauth:// URL for authenticator apps.
 */
export function buildOtpAuthUri(
  secret: string,
  accountName: string,
  issuer = 'Commerce Platform',
): string {
  const encIssuer = encodeURIComponent(issuer);
  const encAccount = encodeURIComponent(accountName);
  return `otpauth://totp/${encIssuer}:${encAccount}?secret=${secret}&issuer=${encIssuer}&algorithm=SHA1&digits=6&period=30`;
}

/**
 * Generate 10 single-use alphanumeric backup recovery codes.
 * Returns { plaintextCodes, hashedCodes }.
 */
export function generateRecoveryCodes(count = 10): {
  plaintextCodes: string[];
  hashedCodes: string[];
} {
  const plaintextCodes: string[] = [];
  const hashedCodes: string[] = [];

  for (let i = 0; i < count; i++) {
    const raw = randomBytes(4).toString('hex').toUpperCase(); // 8 hex chars e.g. A1B2C3D4
    const formatted = `${raw.slice(0, 4)}-${raw.slice(4)}`; // e.g. A1B2-C3D4
    plaintextCodes.push(formatted);
    hashedCodes.push(hashRecoveryCode(formatted));
  }

  return { plaintextCodes, hashedCodes };
}

export function hashRecoveryCode(code: string): string {
  const normalized = code
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
  return createHash('sha256').update(normalized).digest('hex');
}
