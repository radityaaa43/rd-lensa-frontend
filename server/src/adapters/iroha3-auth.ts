import { execFile } from 'node:child_process';
import { createHash, createPrivateKey, randomBytes, sign, type KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Torii app-API request signing (Iroha 3 @ 071e281e): the node only lets a signed account read caller-scoped data.
//   message = "iroha.app.request.network.v1\0" + 32 network-id bytes + "METHOD\npath\nsorted_query\nsha256hex(body)" + "\n<ts_ms>\n<nonce>"
//   (crates/iroha_torii/src/app_auth.rs:1-48; reference signer javascript/iroha_js/src/canonicalRequest.js:75,110)
// The key is the party's node-operator account (CanReadAllLedgerData), the same one lens() reads with. It stays in memory
// as a KeyObject and is never logged.
export interface Auth { account: string; key: KeyObject; network: Buffer }

const DOMAIN = Buffer.from('iroha.app.request.network.v1\0', 'utf8');
const PKCS8_ED25519 = Buffer.from('302e020100300506032b657004220420', 'hex'); // DER prefix; the 32-byte seed follows

// networkLiteral: "hash:<64 hex>#<crc>" as written in genesis.expected_hash.
export function makeAuth(seed: Buffer, accountHex: string, networkLiteral: string): Auth {
  const m = /^hash:([0-9A-Fa-f]{64})/.exec(networkLiteral.trim());
  if (!m) throw new Error('Iroha network id bukan hash 32 byte');
  return { account: accountHex, key: createPrivateKey({ key: Buffer.concat([PKCS8_ED25519, seed]), format: 'der', type: 'pkcs8' }), network: Buffer.from(m[1]!, 'hex') };
}

export function signedHeaders(auth: Auth, method: string, path: string, query: URLSearchParams, body = '', now = Date.now(), nonce = randomBytes(16).toString('hex')): Record<string, string> {
  const sorted = new URLSearchParams([...query].sort(([k1, v1], [k2, v2]) => (k1 < k2 ? -1 : k1 > k2 ? 1 : v1 < v2 ? -1 : v1 > v2 ? 1 : 0)));
  const message = Buffer.concat([
    DOMAIN, auth.network,
    Buffer.from(`${method.toUpperCase()}\n${path}\n${sorted.toString()}\n${createHash('sha256').update(body).digest('hex')}\n${now}\n${nonce}`, 'utf8'),
  ]);
  return {
    'X-Iroha-Account': auth.account,
    'X-Iroha-Signature': sign(null, message, auth.key).toString('base64'),
    'X-Iroha-Timestamp-Ms': String(now),
    'X-Iroha-Nonce': nonce,
  };
}

const tomlValue = (toml: string, key: string) => new RegExp(`^${key}\\s*=\\s*"([^"]+)"`, 'm').exec(toml)?.[1];

// Reads <dir>/<config>.toml (the party's own account key, 32 bytes hex) for the decoder's party map.
export function partyKey(dir: string, config: string): string {
  const pub = tomlValue(readFileSync(join(dir, `${config}.toml`), 'utf8'), 'public_key');
  if (!pub || !/^ed0120[0-9A-Fa-f]{64}$/.test(pub)) throw new Error(`Kunci publik ${config}.toml tidak dikenali`);
  return pub.slice(6).toLowerCase();
}

// Reads <dir>/op-<config>.toml and resolves the operator account's canonical hex once (the CLI is the only converter).
export async function loadAuth(dir: string, config: string): Promise<Auth> {
  const toml = readFileSync(join(dir, `op-${config}.toml`), 'utf8');
  const priv = tomlValue(toml, 'private_key');
  const pub = tomlValue(toml, 'public_key');
  if (!priv || !pub) throw new Error(`op-${config}.toml tanpa kunci operator`);
  const out = await new Promise<string>((resolve, reject) => {
    execFile(join(dir, 'bin', 'iroha'), ['tools', 'address', 'convert', '--format', 'canonical-hex', pub], { cwd: dir, timeout: 30_000 },
      (err, stdout) => (err ? reject(new Error(`iroha tools address convert gagal: ${err.message.split('\n')[0]}`)) : resolve(stdout)));
  });
  const account = out.split('\n').find((l) => l.startsWith('0x')); // the CLI prints "CLI started" first
  if (!account) throw new Error('iroha tools address convert tidak mengembalikan alamat');
  return makeAuth(Buffer.from(priv.slice(-64), 'hex'), account.trim(), readFileSync(join(dir, 'genesis.expected_hash'), 'utf8'));
}
