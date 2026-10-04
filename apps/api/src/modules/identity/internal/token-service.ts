import { randomBytes, createHash } from 'node:crypto';
import { randomUUID } from 'node:crypto';

export interface AccessTokenPayload {
  userId: string;
  tenantId: string;
  role: string;
}

export interface AccessToken {
  token: string;
  expiresAt: Date;
}

export interface RefreshTokenData {
  id: string;
  rawToken: string;
  tokenHash: string;
  familyId: string;
  expiresAt: Date;
}

export interface TokenService {
  generateAccessToken(payload: AccessTokenPayload): AccessToken;
  verifyAccessToken(token: string): AccessTokenPayload | null;
  generateRefreshToken(familyId?: string): RefreshTokenData;
  hashToken(raw: string): string;
}

export class HmacTokenService implements TokenService {
  private readonly accessTokenSecret: string;
  private readonly accessTokenTtlSeconds: number;
  private readonly refreshTokenTtlSeconds: number;

  constructor(options: {
    accessTokenSecret: string;
    accessTokenTtlSeconds?: number;
    refreshTokenTtlSeconds?: number;
  }) {
    this.accessTokenSecret = options.accessTokenSecret;
    this.accessTokenTtlSeconds = options.accessTokenTtlSeconds ?? 900; // 15 min
    this.refreshTokenTtlSeconds = options.refreshTokenTtlSeconds ?? 60 * 60 * 24 * 7; // 7 days
  }

  generateAccessToken(payload: AccessTokenPayload): AccessToken {
    const expiresAt = new Date(Date.now() + this.accessTokenTtlSeconds * 1000);
    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'AT' })).toString('base64url');
    const claims = Buffer.from(
      JSON.stringify({
        sub: payload.userId,
        tid: payload.tenantId,
        rol: payload.role,
        exp: Math.floor(expiresAt.getTime() / 1000),
        iat: Math.floor(Date.now() / 1000),
        jti: randomUUID(),
      }),
    ).toString('base64url');

    const sig = createHash('sha256')
      .update(`${header}.${claims}.${this.accessTokenSecret}`)
      .digest('base64url');

    return {
      token: `${header}.${claims}.${sig}`,
      expiresAt,
    };
  }

  verifyAccessToken(token: string): AccessTokenPayload | null {
    try {
      const parts = token.split('.');
      if (parts.length !== 3) return null;
      const [header, claims, sig] = parts;
      if (!header || !claims || !sig) return null;

      const expectedSig = createHash('sha256')
        .update(`${header}.${claims}.${this.accessTokenSecret}`)
        .digest('base64url');

      if (sig !== expectedSig) return null;

      const body = JSON.parse(Buffer.from(claims, 'base64url').toString('utf-8')) as {
        sub: string;
        tid: string;
        rol: string;
        exp: number;
      };

      if (body.exp < Math.floor(Date.now() / 1000)) return null;

      return {
        userId: body.sub,
        tenantId: body.tid,
        role: body.rol,
      };
    } catch {
      return null;
    }
  }

  generateRefreshToken(familyId?: string): RefreshTokenData {
    const rawToken = randomBytes(32).toString('hex');
    const tokenHash = this.hashToken(rawToken);
    const expiresAt = new Date(Date.now() + this.refreshTokenTtlSeconds * 1000);

    return {
      id: randomUUID(),
      rawToken,
      tokenHash,
      familyId: familyId ?? randomUUID(),
      expiresAt,
    };
  }

  hashToken(raw: string): string {
    return createHash('sha256').update(raw).digest('hex');
  }
}
