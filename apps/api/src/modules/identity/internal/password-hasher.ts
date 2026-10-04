import {
  scrypt,
  randomBytes,
  timingSafeEqual,
  type ScryptOptions,
  type BinaryLike,
} from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt) as (
  password: BinaryLike,
  salt: BinaryLike,
  keylen: number,
  options?: ScryptOptions,
) => Promise<Buffer>;

export interface PasswordHasher {
  hash(password: string): Promise<string>;
  verify(password: string, hash: string): Promise<boolean>;
}

export const DEFAULT_SCRYPT_PARAMS = {
  cost: 16384, // N: CPU/memory cost parameter (2^14)
  blockSize: 8, // r: Block size parameter
  parallelization: 1, // p: Parallelization parameter
  maxmem: 64 * 1024 * 1024, // 64 MB memory limit
};

export class ScryptPasswordHasher implements PasswordHasher {
  private readonly keyLength = 64; // 512-bit key length

  async hash(password: string): Promise<string> {
    const salt = randomBytes(16).toString('hex');
    const derivedKey = (await scryptAsync(password, salt, this.keyLength, {
      N: DEFAULT_SCRYPT_PARAMS.cost,
      r: DEFAULT_SCRYPT_PARAMS.blockSize,
      p: DEFAULT_SCRYPT_PARAMS.parallelization,
      maxmem: DEFAULT_SCRYPT_PARAMS.maxmem,
    })) as Buffer;
    return `${salt}:${derivedKey.toString('hex')}`;
  }

  async verify(password: string, storedHash: string): Promise<boolean> {
    const parts = storedHash.split(':');
    if (parts.length !== 2) {
      return false;
    }
    const [salt, key] = parts;
    if (!salt || !key) {
      return false;
    }

    try {
      const keyBuffer = Buffer.from(key, 'hex');
      const derivedKey = (await scryptAsync(password, salt, this.keyLength, {
        N: DEFAULT_SCRYPT_PARAMS.cost,
        r: DEFAULT_SCRYPT_PARAMS.blockSize,
        p: DEFAULT_SCRYPT_PARAMS.parallelization,
        maxmem: DEFAULT_SCRYPT_PARAMS.maxmem,
      })) as Buffer;
      if (keyBuffer.length !== derivedKey.length) {
        return false;
      }
      return timingSafeEqual(keyBuffer, derivedKey);
    } catch {
      return false;
    }
  }
}
