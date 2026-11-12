import { createHash, timingSafeEqual } from 'node:crypto';
import { IDENTITY_NAME } from '../policy/schema.js';

export interface IdentitySpec {
  name: string;
  token_sha256?: string;
  token_env?: string;
}

export interface Authenticator {
  authenticate(authorization: string | undefined): string | undefined;
}

const SHA256_HEX = /^[0-9a-f]{64}$/;
// HTTP auth schemes are case-insensitive (RFC 9110, section 11.1).
const BEARER = /^bearer (.+)$/i;

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function digestOf(spec: IdentitySpec, env: NodeJS.ProcessEnv): Buffer {
  const hasDigest = spec.token_sha256 !== undefined;
  const hasEnv = spec.token_env !== undefined;
  if (hasDigest === hasEnv) {
    throw new Error(`Identity "${spec.name}" needs exactly one of token_sha256 or token_env`);
  }
  if (spec.token_env !== undefined) {
    const token = env[spec.token_env];
    if (!token) {
      throw new Error(`Identity "${spec.name}": environment variable ${spec.token_env} is not set`);
    }
    return Buffer.from(sha256Hex(token), 'hex');
  }
  const hex = spec.token_sha256!.toLowerCase();
  // timingSafeEqual needs equal-length buffers, so a malformed digest must fail here.
  if (!SHA256_HEX.test(hex)) {
    throw new Error(`Identity "${spec.name}": token_sha256 must be 64 hex characters`);
  }
  return Buffer.from(hex, 'hex');
}

export function staticTokenAuthenticator(
  identities: IdentitySpec[],
  env: NodeJS.ProcessEnv = process.env,
): Authenticator {
  const entries = identities.map((spec) => {
    if (!IDENTITY_NAME.test(spec.name)) {
      throw new Error(`Invalid identity name "${spec.name}": must match ${IDENTITY_NAME}`);
    }
    return { name: spec.name, digest: digestOf(spec, env) };
  });

  const owners = new Map<string, string>();
  for (const { name, digest } of entries) {
    const other = owners.get(digest.toString('hex'));
    if (other !== undefined) throw new Error(`Identities "${other}" and "${name}" share a token`);
    owners.set(digest.toString('hex'), name);
  }

  return {
    authenticate(authorization) {
      const token = authorization === undefined ? undefined : BEARER.exec(authorization)?.[1];
      if (token === undefined) return undefined;
      const presented = Buffer.from(sha256Hex(token), 'hex');
      let match: string | undefined;
      // Check every identity so response time does not reveal which one (if any) matched.
      for (const { name, digest } of entries) {
        if (timingSafeEqual(presented, digest) && match === undefined) match = name;
      }
      return match;
    },
  };
}
