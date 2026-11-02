import { expect, test } from 'vitest';
import { loadAdapters, loadAdaptersWithFailures } from '../src/adapters/index.ts';
import { fakeAdapter } from './fake-adapter.ts';

test('no adapters selected gives {} regardless of state files on disk', async () => expect(await loadAdapters({ only: [] })).toEqual({}));

test('a model whose module does not exist is skipped', async () =>
  expect(await loadAdapters({ only: ['nonexistent' as any] })).toEqual({}));

test('a load() that throws takes only its model out; the others load and the failure text carries no path', async () => {
  const log = console.error;
  console.error = () => {};
  try {
    const r = await loadAdaptersWithFailures({
      only: ['stealth', 'iroha3', 'noto'],
      importModule: async (m) => ({
        load: async () => {
          if (m === 'stealth') throw Object.assign(new Error("ENOENT: no such file or directory, open '/secret/path/ERC5564Announcer.json'"), { code: 'ENOENT' });
          if (m === 'noto') throw new Error('boom /secret/path');
          return fakeAdapter(m);
        },
      }),
    });
    expect(Object.keys(r.adapters)).toEqual(['iroha3']);
    expect(r.failures).toEqual({ stealth: 'Gagal dimuat: berkas tidak terbaca (ENOENT)', noto: 'Gagal dimuat: lihat log server' });
    expect(JSON.stringify(r.failures)).not.toContain('/secret');
  } finally { console.error = log; }
});
