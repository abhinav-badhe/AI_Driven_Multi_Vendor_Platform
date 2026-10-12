import type { FastifyInstance } from 'fastify';
import type { DatabaseConnection } from '../../src/infra/database/connection.js';

/**
 * Marks every test user as email-verified. HTTP-level suites register users
 * through /auth/register (which leaves accounts unverified by design) and
 * then sign in — call this after registration to simulate verified users.
 */
export async function markAllUsersVerified(db: DatabaseConnection): Promise<void> {
  await db.query(
    `UPDATE users SET email_verified_at = CURRENT_TIMESTAMP WHERE email_verified_at IS NULL`,
  );
}

export interface VerifiedUserInput {
  email: string;
  password: string;
  tenantName: string;
  role: 'MERCHANT' | 'CUSTOMER';
}

/**
 * Registers a user, marks the email verified (as if the user clicked the
 * verification link), and signs in. Returns the access token.
 */
export async function registerVerifiedUser(
  app: FastifyInstance,
  db: DatabaseConnection,
  input: VerifiedUserInput,
): Promise<string> {
  const reg = await app.inject({
    method: 'POST',
    url: '/auth/register',
    payload: {
      email: input.email,
      password: input.password,
      tenantName: input.tenantName,
      role: input.role,
    },
  });
  if (reg.statusCode !== 201) {
    throw new Error(
      `Test registration failed for ${input.email}: ${reg.statusCode} ${reg.payload}`,
    );
  }
  await db.query(`UPDATE users SET email_verified_at = CURRENT_TIMESTAMP WHERE email = $1`, [
    input.email.toLowerCase(),
  ]);
  const login = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email: input.email, password: input.password },
  });
  if (login.statusCode !== 200) {
    throw new Error(`Test login failed for ${input.email}: ${login.statusCode} ${login.payload}`);
  }
  return (login.json() as { accessToken: string }).accessToken as string;
}
