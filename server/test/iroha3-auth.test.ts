import { createHash, generateKeyPairSync, verify } from 'node:crypto';
import { expect, test } from 'vitest';
import { makeAuth, signedHeaders } from '../src/adapters/iroha3-auth.ts';

// A key generated here: the real operator keys never enter a test.
const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const seed = privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32);
const NETWORK_HEX = '9A4A1989549BB95D86832F16EF5825D281729DA7FD81155D0800AB43E54532F9';
const auth = makeAuth(seed, '0x02000120aabb', `hash:${NETWORK_HEX}#35CD`);

test('signs the canonical request: network domain + network id + method/path/sorted query/body hash + ts/nonce', () => {
  const h = signedHeaders(auth, 'GET', '/v1/accounts/acct/transactions', new URLSearchParams({ offset: '0', limit: '5' }), '', 1700000000000, 'n0nce');
  expect(Object.keys(h).sort()).toEqual(['X-Iroha-Account', 'X-Iroha-Nonce', 'X-Iroha-Signature', 'X-Iroha-Timestamp-Ms']);
  expect(h['X-Iroha-Account']).toBe('0x02000120aabb');
  expect(h['X-Iroha-Timestamp-Ms']).toBe('1700000000000');
  expect(h['X-Iroha-Nonce']).toBe('n0nce');
  const message = Buffer.concat([
    Buffer.from('iroha.app.request.network.v1\0', 'utf8'),
    Buffer.from(NETWORK_HEX, 'hex'),
    Buffer.from(`GET\n/v1/accounts/acct/transactions\nlimit=5&offset=0\n${createHash('sha256').update('').digest('hex')}\n1700000000000\nn0nce`, 'utf8'),
  ]);
  expect(verify(null, message, publicKey, Buffer.from(h['X-Iroha-Signature']!, 'base64'))).toBe(true);
});

test('a different network id gives a different signature (signatures are bound to one network)', () => {
  const other = makeAuth(seed, '0x02000120aabb', `hash:${'00'.repeat(31)}01#0000`);
  const q = new URLSearchParams({ limit: '5' });
  expect(signedHeaders(other, 'GET', '/p', q, '', 1, 'n')['X-Iroha-Signature']).not.toBe(signedHeaders(auth, 'GET', '/p', q, '', 1, 'n')['X-Iroha-Signature']);
});

test('rejects a network id that is not a 32-byte hash literal', () => {
  expect(() => makeAuth(seed, '0x02', 'wonderland')).toThrow(/network id/i);
});
