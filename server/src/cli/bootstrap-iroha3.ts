import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BANKS, type PartyId } from '../domain.ts';
import { CONFIG, createIroha3Adapter, irohaCli, type Iroha3State } from '../adapters/iroha3.ts';
import { STATE_DIR, writeState } from '../state.ts';

const RD_OPENING = 10n ** 13n;
const DFABI_OPENING = 1000n;
// genesis ids: AssetDefinitionId::derive_from_components("rd"/"dfabi", "wonderland") (iroha3 repo, network/genesis-rd-dfabi.jq)
const ASSETS = { RD: '7onbjg2gRXveoAAUFsohCZyGW98t', DFABI: '4mBWK1JCwQdHLDPpuVKc56eLsXka' };
// the iroha3 repo's public bundle (chain_id, genesis.expected_hash) of the network that is running
const PUBLIC = fileURLToPath(new URL('../../../../iroha3/network/public', import.meta.url));
const PORT: Record<PartyId, number> = { BI: 38080, A: 38081, B: 38082, C: 38083 };

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
  const state: Iroha3State = { dir, torii, accounts, assets: ASSETS, funded: false };
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
