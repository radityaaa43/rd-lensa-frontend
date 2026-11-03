import type { Locator, Page } from '@playwright/test';
import { SPEEDS, type Speed } from './spec.ts';

const speed = (process.env.DEMO_SPEED ?? 'normal') as Speed;
if (!(speed in SPEEDS)) throw new Error(`DEMO_SPEED must be slow|normal|fast, got "${speed}"`);
export const FACTOR = SPEEDS[speed];
export const FAST = speed === 'fast';

// A pause for the viewer: scaled by DEMO_SPEED. Never used to wait for the app (that is an expect).
export const pause = (page: Page, ms: number) => (FAST ? Promise.resolve() : page.waitForTimeout(ms * FACTOR));

// Glide the cursor to the element, then click: the viewer sees where the click lands.
export async function click(page: Page, target: Locator, opts: { force?: boolean } = {}) {
  if (!FAST) {
    await target.scrollIntoViewIfNeeded();
    const box = await target.boundingBox();
    if (box) await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 20 });
    await pause(page, 250);
  }
  await target.click(opts);
}

// Type digits like a person would; instant in fast mode.
export async function type(page: Page, target: Locator, text: string) {
  await target.click();
  await target.fill('');
  if (FAST) await target.fill(text);
  else await target.pressSequentially(text, { delay: 90 * FACTOR });
}
