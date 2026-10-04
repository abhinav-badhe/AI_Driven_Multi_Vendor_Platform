import { describe, it, expect } from 'vitest';
import { ScryptPasswordHasher } from '../src/modules/identity/internal/password-hasher.js';

describe('Password Hasher (scrypt)', () => {
  const hasher = new ScryptPasswordHasher();

  it('produces a hash that is not the original password', async () => {
    const hash = await hasher.hash('myPassword123');
    expect(hash).not.toBe('myPassword123');
    expect(hash).toContain(':');
  });

  it('different hashes are produced for the same password (salt uniqueness)', async () => {
    const h1 = await hasher.hash('samePassword');
    const h2 = await hasher.hash('samePassword');
    expect(h1).not.toBe(h2);
  });

  it('verifies correct password against its hash', async () => {
    const hash = await hasher.hash('correctPassword!');
    const valid = await hasher.verify('correctPassword!', hash);
    expect(valid).toBe(true);
  });

  it('rejects wrong password', async () => {
    const hash = await hasher.hash('correctPassword!');
    const valid = await hasher.verify('wrongPassword', hash);
    expect(valid).toBe(false);
  });

  it('rejects malformed hash gracefully', async () => {
    const valid = await hasher.verify('password', 'not-a-valid-hash');
    expect(valid).toBe(false);
  });
});
