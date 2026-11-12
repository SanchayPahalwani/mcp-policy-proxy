import { describe, expect, it } from 'vitest';
import { sha256Hex, staticTokenAuthenticator } from '../../src/proxy/auth.js';

describe('staticTokenAuthenticator', () => {
  const auth = staticTokenAuthenticator(
    [
      { name: 'writer', token_sha256: sha256Hex('t1') },
      { name: 'reader', token_env: 'TOK' },
    ],
    { TOK: 't2' },
  );

  it('maps a bearer token to its identity', () => {
    expect(auth.authenticate('Bearer t1')).toBe('writer');
  });

  it.each(['bearer t1', 'BEARER t1', 'BeArEr t1'])(
    'accepts the scheme in any case: %j',
    (header) => {
      expect(auth.authenticate(header)).toBe('writer');
    },
  );

  it('reads a token from the environment', () => {
    expect(auth.authenticate('Bearer t2')).toBe('reader');
  });

  it.each([undefined, 't1', 'Basic t1', 'Bearer wrong', 'Bearer '])('rejects %j', (header) => {
    expect(auth.authenticate(header)).toBeUndefined();
  });

  it('throws for an unset or empty token_env', () => {
    expect(() => staticTokenAuthenticator([{ name: 'a', token_env: 'MISSING' }], {})).toThrow(
      /MISSING/,
    );
    expect(() =>
      staticTokenAuthenticator([{ name: 'a', token_env: 'EMPTY' }], { EMPTY: '' }),
    ).toThrow(/EMPTY/);
  });

  it('throws for two identities sharing a token', () => {
    expect(() =>
      staticTokenAuthenticator(
        [
          { name: 'a', token_sha256: sha256Hex('same') },
          { name: 'b', token_env: 'TOK' },
        ],
        { TOK: 'same' },
      ),
    ).toThrow(/share a token/);
  });

  it('throws for a bad identity name', () => {
    expect(() =>
      staticTokenAuthenticator([{ name: 'Bad Name', token_sha256: sha256Hex('t') }]),
    ).toThrow(/Invalid identity name "Bad Name"/);
  });

  it('throws for a token_sha256 that is not 64 hex characters', () => {
    for (const digest of ['x'.repeat(64), sha256Hex('t').slice(1), `${sha256Hex('t')}0`]) {
      expect(() => staticTokenAuthenticator([{ name: 'a', token_sha256: digest }])).toThrow(
        /64 hex characters/,
      );
    }
  });

  it('throws when an identity has both or neither token fields', () => {
    expect(() =>
      staticTokenAuthenticator([{ name: 'a', token_sha256: sha256Hex('t'), token_env: 'TOK' }], {
        TOK: 't',
      }),
    ).toThrow(/exactly one/);
    expect(() => staticTokenAuthenticator([{ name: 'a' }])).toThrow(/exactly one/);
  });
});
