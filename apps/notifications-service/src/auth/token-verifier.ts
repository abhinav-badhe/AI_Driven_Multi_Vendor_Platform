import { createHash } from 'node:crypto';

export interface AuthActor {
  userId: string;
  tenantId: string;
  role: 'ADMINISTRATOR' | 'MERCHANT' | 'CUSTOMER';
}

export type VerifiedActor = AuthActor;

export interface ITokenVerifier {
  verifyToken(token: string): Promise<AuthActor | null> | AuthActor | null;
}

/**
 * Verifies standard HMAC-SHA256 access tokens issued by the monolith Identity service
 * without making database queries to users or tenant_memberships tables.
 */
export class HmacTokenVerifier implements ITokenVerifier {
  constructor(private readonly secret: string) {
    if (!secret || secret.length < 16) {
      throw new Error('HmacTokenVerifier requires a secret of at least 16 characters');
    }
  }

  verifyToken(token: string): AuthActor | null {
    try {
      const parts = token.split('.');
      if (parts.length !== 3) return null;
      const [header, claims, sig] = parts;
      if (!header || !claims || !sig) return null;

      const expectedSig = createHash('sha256')
        .update(`${header}.${claims}.${this.secret}`)
        .digest('base64url');

      if (sig !== expectedSig) return null;

      const body = JSON.parse(Buffer.from(claims, 'base64url').toString('utf-8')) as {
        sub: string;
        tid: string;
        rol: string;
        exp: number;
      };

      if (body.exp < Math.floor(Date.now() / 1000)) return null;

      const role = body.rol as 'ADMINISTRATOR' | 'MERCHANT' | 'CUSTOMER';
      if (!['ADMINISTRATOR', 'MERCHANT', 'CUSTOMER'].includes(role)) {
        return null;
      }

      return {
        userId: body.sub,
        tenantId: body.tid,
        role,
      };
    } catch {
      return null;
    }
  }
}
