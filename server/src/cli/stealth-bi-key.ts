import { ensureBiKeys } from '../adapters/stealth.ts';

// Operator step for the Stealth award flow. Stop the server first. Adds BI's stealth receive keys to state/stealth.json if missing.
console.log(ensureBiKeys() ? 'Kunci penerima stealth BI ditambahkan ke state/stealth.json. Jalankan ulang server.' : 'BI sudah punya kunci penerima stealth, tidak ada yang diubah.');
