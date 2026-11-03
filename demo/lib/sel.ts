// Every selector the scenarios use that is not a plain role/label query. A flaky one gets a data-testid in the product, not a longer
// selector here (lead's rule); until then this is the only file to fix when the markup moves.
import type { Page } from '@playwright/test';

export const sel = {
  tile: (p: Page, platform: string) => p.locator(`a.tile.${platform}`),
  partyLabel: (p: Page, name: string) => p.locator(`fieldset.pills label[title="${name}"]`),
  modelLabel: (p: Page, name: string) => p.locator('fieldset.pills label', { hasText: new RegExp(`^${name}$`) }),
  themeToggle: (p: Page) => p.getByRole('button', { name: 'Ganti tema' }),
  heroFigure: (p: Page) => p.locator('section.hero .big'),
  dfabiFigure: (p: Page) => p.getByRole('region', { name: 'Saldo DFABI' }).locator('.fig'),
  netRows: (p: Page) => p.locator('table.netlist tbody tr'),
  netChip: (p: Page) => p.locator('a.chip span[aria-live]'),
  histRows: (p: Page) => p.locator('table.hist tbody tr'),
  histRowOf: (p: Page, tx: string) => p.locator('table.hist tbody tr', { has: p.locator(`a[href*="${encodeURIComponent(tx)}"]`) }),
  lensCols: (p: Page) => p.locator('.lens2'),
  lensNotes: (p: Page) => p.locator('.lens2.note'),
  steps: (p: Page) => p.getByRole('region', { name: 'Proses' }).locator('li'),
  stepsOk: (p: Page) => p.getByRole('region', { name: 'Proses' }).locator('li.ok'),
  reportRows: (p: Page) => p.locator('section.report tbody tr'),
};
