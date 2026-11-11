import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BI_DATA_FILE, latestContractData, syncNoto } from '../policy/noto-config.ts';
import { STATE_DIR, readState, writeState } from '../state.ts';

// The deploy script lives in the besu repo (not vendored): point LENSA_BOND_DIR at its noto+pente/bond checkout.
const BOND_DIR = process.env.LENSA_BOND_DIR ?? '';

// Fresh deployment by the project's own script: BI identities on node1, investor1..3 on node2..4.
// Cash/supply are raised from the script defaults so a DvP at PRICE_PER_UNIT (1e6 RD per unit) is payable.
// Refuses when state/noto.json exists: a second deployment would add a contract-data file that findLatestContractDataFile
// may pick over the live one. Pass --force to deploy anyway.
export async function bootstrap(): Promise<void> {
  if (!BOND_DIR) { console.error('LENSA_BOND_DIR is not set: it must name the besu repo checkout of noto+pente/bond.'); process.exit(1); }
  if (readState('noto') && !process.argv.includes('--force')) {
    console.error('state/noto.json sudah ada: bootstrap Noto kedua akan menambah deployment baru. Jalankan ulang dengan --force jika memang diinginkan.');
    process.exit(1);
  }
  const dataDir = join(STATE_DIR, 'noto');
  const previous = existsSync(dataDir) ? latestContractData(dataDir) : undefined;
  execFileSync('npx', ['ts-node', 'src/index.ts', '--cache', dataDir,
    '--cash-per-investor', '10000000000000', '--supply', '1000000', '--units-per-investor', '1000'],
  { cwd: BOND_DIR, stdio: 'inherit', timeout: 15 * 60_000 });
  writeState('noto', { dataDir });
  console.log(`state/noto.json ditulis: ${dataDir}`);
  // The gateways only know the contracts and groups listed in data.json: write the new ones in.
  writeFileSync(BI_DATA_FILE, syncNoto(readFileSync(BI_DATA_FILE, 'utf8'), latestContractData(dataDir)!, previous?.restrictedAtomFactoryAddress));
  console.log(`${BI_DATA_FILE} diperbarui (kontrak Noto, grup Pente, pabrik atom). Wajib di-commit, lalu BI menerbitkan ulang kebijakan di Lensa; sebelum itu semua transaksi Noto ditolak gateway.`);
}
