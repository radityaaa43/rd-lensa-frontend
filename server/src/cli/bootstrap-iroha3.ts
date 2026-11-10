import { execFileSync } from 'node:child_process';
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BANKS, type PartyId } from '../domain.ts';
import { CONFIG, createIroha3Adapter, irohaCli, type Iroha3State } from '../adapters/iroha3.ts';
import type { ApsConfig } from '../adapters/iroha3-aps.ts';
import { STATE_DIR, writeState } from '../state.ts';

const RD_OPENING = 10n ** 13n;
const DFABI_OPENING = 1000n;
// genesis ids: AssetDefinitionId::derive_from_components("rd"/"dfabi", "wonderland") (iroha3 repo, network/genesis-rd-dfabi.jq)
const ASSETS = { RD: '7onbjg2gRXveoAAUFsohCZyGW98t', DFABI: '4mBWK1JCwQdHLDPpuVKc56eLsXka' };
// the iroha3 repo's public bundle (chain_id, genesis.expected_hash) of the network that is running
const PUBLIC = fileURLToPath(new URL('../../../../iroha3/network/public', import.meta.url));
const PORT: Record<PartyId, number> = { BI: 38080, A: 38081, B: 38082, C: 38083 };
// APS private DvP (iroha3-aps.ts): the driver image, its wallet seeds from the iroha3 repo's scripts/keys-init.sh, and the
// bi-auditor port-forward (kubectl port-forward -n iroha3 svc/bi-auditor 38090:8090).
const APS_IMAGE = 'ghcr.io/radityaaa43/iroha3-rd-driver:ce4641e2';
const APS_KEYS = join(homedir(), 'iroha3-keys');
const AUDITOR_PORT = 38090;
const FEE_ASSET = '6TEAJqbb8oEPmLncoNiMRbLEK6tw'; // genesis fee asset (iroha3 repo deploy/k8s-apps/rd-dfabi.toml)

// The driver's config as the container sees it: /state = state/iroha3 (admin.toml is the sponsor), /keys, /public.
const driverToml = (chain: string) => `chain = "${chain}"
network_id_file = "/state/genesis.expected_hash"
account_domain = "wonderland.universal"
client_toml = "/state/admin.toml"
peers_json = "/public/peers.json"
key_dir = "/keys"
fee_asset = "${FEE_ASSET}"
auditor_url = "127.0.0.1:${AUDITOR_PORT}"

[torii]
${(Object.keys(PORT) as PartyId[]).map((p) => `${CONFIG[p]} = "http://127.0.0.1:${PORT[p]}/"`).join('\n')}

[assets]
rd = "${ASSETS.RD}"
dfabi = "${ASSETS.DFABI}"

[lanes]
rd = 1
dfabi = 2
`;

// The network runs in the cluster (namespace iroha3); RD, DFABI, the party accounts and their fee balances are in its
// genesis. state/iroha3/ must already hold bin/iroha, <party>.toml (party keys, own Torii) and admin.toml (the node
// operator account, iroha3/network/out/<party>/client.toml: the same key in all four). This derives one operator config per node, records the ids and
// tops each bank up to the opening balances by minting from BI (a bank already above them is left alone).
export async function bootstrap(): Promise<void> {
  const dir = join(STATE_DIR, 'iroha3');
  const admin = readFileSync(join(dir, 'admin.toml'), 'utf8');
  const cli = irohaCli(dir);
  // a redeployed network has a new chain id and genesis hash: take both from the repo's public bundle
  const chain = readFileSync(join(PUBLIC, 'chain_id'), 'utf8').trim();
  copyFileSync(join(PUBLIC, 'genesis.expected_hash'), join(dir, 'genesis.expected_hash'));
  for (const c of [...Object.values(CONFIG), 'admin']) {
    const f = join(dir, `${c}.toml`);
    writeFileSync(f, readFileSync(f, 'utf8').replace(/^chain = .*$/m, `chain = "${chain}"`), { mode: 0o600 });
  }
  const torii = {} as Record<PartyId, string>;
  const accounts = {} as Record<PartyId, string>;
  for (const p of Object.keys(CONFIG) as PartyId[]) {
    torii[p] = `http://127.0.0.1:${PORT[p]}/`;
    writeFileSync(join(dir, `op-${CONFIG[p]}.toml`), admin.replace(/^torii_url = .*$/m, `torii_url = "${torii[p]}"`), { mode: 0o600 });
    const key = /^public_key\s*=\s*"([^"]+)"/m.exec(readFileSync(join(dir, `${CONFIG[p]}.toml`), 'utf8'))![1]!;
    accounts[p] = (await cli(CONFIG[p], ['tools', 'address', 'convert', key])).trim().split('\n').pop()!;
  }
  writeFileSync(join(dir, 'rd-dfabi.toml'), driverToml(chain), { mode: 0o600 });
  const wallets = {} as Record<PartyId, string>;
  for (const p of Object.keys(CONFIG) as PartyId[]) { // `keys show` prints "<name> <public key>"; offline, read-only seeds
    const shown = execFileSync('docker', ['run', '--rm', '--network', 'none', '--user', `${process.getuid!()}:${process.getgid!()}`,
      '-v', `${APS_KEYS}:/k:ro`, APS_IMAGE, 'keys', 'show', '/k', CONFIG[p]], { encoding: 'utf8' }).trim().split(/\s+/).pop()!;
    wallets[p] = (await cli(CONFIG[p], ['tools', 'address', 'convert', shown])).trim().split('\n').pop()!;
  }
  const aps: ApsConfig = { image: APS_IMAGE, config: '/state/rd-dfabi.toml', mounts: { state: dir, keys: APS_KEYS, public: PUBLIC },
    auditor: `http://127.0.0.1:${AUDITOR_PORT}/`, wallets };
  const state: Iroha3State = { dir, torii, accounts, assets: ASSETS, funded: false, aps };
  writeState('iroha3', state);
  const adapter = createIroha3Adapter(state, cli);
  const health = await adapter.health();
  if (!health.ready) throw new Error(health.detail);
  for (const b of BANKS) {
    for (const [asset, opening] of [['RD', RD_OPENING], ['DFABI', DFABI_OPENING]] as const) {
      const have = await adapter.balanceOf(b, asset);
      if (have < opening) await adapter.fund(b, asset, opening - have);
    }
    console.log(`saldo awal ${b}: RD ${await adapter.balanceOf(b, 'RD')}, DFABI ${await adapter.balanceOf(b, 'DFABI')}`);
  }
  writeState('iroha3', { ...state, funded: true });
  console.log('state/iroha3.json ditulis');
}
