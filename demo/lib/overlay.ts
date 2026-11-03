import type { BrowserContext, Page } from '@playwright/test';

// Caption bar + cursor ring, injected into every page of the context. Both are aria-hidden and pointer-events:none, so they never
// answer a role query or take a click. The page is reloaded by page.goto, so a caption is set after each goto (see ctx.caption).
const INIT = () => {
  const mk = () => {
    if (document.getElementById('demo-cap')) return;
    const st = document.createElement('style');
    st.textContent = `
      #demo-cap{position:fixed;left:50%;bottom:28px;transform:translateX(-50%);z-index:2147483647;max-width:min(880px,92vw);padding:12px 22px;
        border-radius:14px;background:rgba(14,22,38,.92);color:#fff;font:600 18px/1.35 system-ui,sans-serif;text-align:center;pointer-events:none;
        box-shadow:0 8px 30px rgba(0,0,0,.35);transition:opacity .2s}
      #demo-cap:empty{opacity:0}
      #demo-cur{position:fixed;z-index:2147483647;width:30px;height:30px;margin:-15px 0 0 -15px;border:3px solid #ff5a36;border-radius:50%;
        pointer-events:none;transition:transform .08s;left:0;top:0;background:rgba(255,90,54,.18)}
      #demo-cur.dn{transform:scale(.6);background:rgba(255,90,54,.5)}`;
    document.head.append(st);
    const cap = document.createElement('div'); cap.id = 'demo-cap'; cap.setAttribute('aria-hidden', 'true');
    const cur = document.createElement('div'); cur.id = 'demo-cur'; cur.setAttribute('aria-hidden', 'true');
    document.body.append(cap, cur);
    addEventListener('mousemove', (e) => { cur.style.left = `${e.clientX}px`; cur.style.top = `${e.clientY}px`; }, true);
    addEventListener('mousedown', () => cur.classList.add('dn'), true);
    addEventListener('mouseup', () => cur.classList.remove('dn'), true);
  };
  if (document.readyState === 'loading') addEventListener('DOMContentLoaded', mk); else mk();
};

export const installOverlay = (context: BrowserContext) => context.addInitScript(INIT);

export async function setCaption(page: Page, text: string) {
  await page.evaluate((t) => { const el = document.getElementById('demo-cap'); if (el) el.textContent = t; }, text).catch(() => {});
}
