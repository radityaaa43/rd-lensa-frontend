// Run by test/noto-real-loader.test.ts under the real tsx loader (not vitest).
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const before = require('paladin-example-common').nodeConnections.map((n: { clientOptions: unknown }) => n.clientOptions);
const { applyNotoConnections } = await import('../../src/adapters/noto-connections.ts');
applyNotoConnections();
const after = require('paladin-example-common').nodeConnections as { clientOptions: unknown }[];
console.log(JSON.stringify({ n: after.length, replaced: after.map((n, i) => n.clientOptions !== before[i]) }));
