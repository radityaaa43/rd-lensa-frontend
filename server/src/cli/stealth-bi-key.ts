import { connect } from 'node:net';
import { ensureBiKeys } from '../adapters/stealth.ts';

// Operator step for the Stealth award flow. Adds BI's stealth receive keys to state/stealth.json if missing.
// A running Lensa server rewrites the state file from memory and would drop the new keys, so refuse while one listens.
const PORTS = (process.env.LENSA_PORTS ?? '8790,8792').split(',').map(Number);
const listening = (port: number) => new Promise<boolean>((done) => {
  const s = connect({ host: '127.0.0.1', port }, () => { s.destroy(); done(true); });
  s.on('error', () => done(false));
});
const busy = (await Promise.all(PORTS.map(async (p) => ((await listening(p)) ? p : null)))).filter((p) => p !== null);
if (busy.length) {
  console.error(`Server Lensa masih berjalan di port ${busy.join(', ')}: hentikan dulu, lalu jalankan ulang perintah ini.`);
  process.exit(1);
}
// ensureBiKeys reads the file right before it writes, so nothing written since startup is lost.
console.log(ensureBiKeys() ? 'Kunci penerima stealth BI ditambahkan ke state/stealth.json. Jalankan ulang server.' : 'BI sudah punya kunci penerima stealth, tidak ada yang diubah.');
