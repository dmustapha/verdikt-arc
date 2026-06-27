import { chromium } from '/opt/homebrew/lib/node_modules/playwright/index.mjs';

const BASE = 'http://localhost:3000';
const SHOT = '/Users/MAC/hackathon-toolkit/candidates/lepton-canteen/verdikt-arc/screenshots/stress';
const routes = ['/', '/courtroom', '/proof', '/ledger'];
const results = { overflow: [], console: [], shots: [], checks: {} };

const browser = await chromium.launch();

async function overflowAt(page, w, h, route) {
  await page.setViewportSize({ width: w, height: h });
  await page.goto(BASE + route, { waitUntil: 'networkidle' });
  const scrollW = await page.evaluate(() => document.documentElement.scrollWidth);
  const clientW = await page.evaluate(() => document.documentElement.clientWidth);
  if (scrollW > clientW + 2) results.overflow.push(`${route} @${w}: scrollW=${scrollW} > clientW=${clientW}`);
}

const ctx = await browser.newContext();
const page = await ctx.newPage();
page.on('console', (m) => { if (m.type() === 'error') results.console.push(m.text().slice(0, 200)); });
page.on('pageerror', (e) => results.console.push('PAGEERROR: ' + String(e).slice(0, 200)));

// 1. Overflow sweep + screenshots
for (const r of routes) {
  for (const [w, h] of [[320, 800], [768, 1024], [1440, 900]]) {
    await overflowAt(page, w, h, r);
  }
  // screenshot at 1440 + 390
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(BASE + r, { waitUntil: 'networkidle' });
  const name = r === '/' ? 'home' : r.slice(1);
  const p1 = `${SHOT}/${name}-1440.png`; await page.screenshot({ path: p1, fullPage: true }); results.shots.push(p1);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(BASE + r, { waitUntil: 'networkidle' });
  const p2 = `${SHOT}/${name}-390.png`; await page.screenshot({ path: p2, fullPage: true }); results.shots.push(p2);
}

// 2. /proof Gateway counter (E-1)
await page.setViewportSize({ width: 1440, height: 900 });
await page.goto(BASE + '/proof', { waitUntil: 'networkidle' });
const proofText = await page.evaluate(() => document.body.innerText);
results.checks.proof_gateway_counter = /\$0\.001|gateway|nanopay|×|x \$0\.001/i.test(proofText);
results.checks.proof_counter_snippet = (proofText.match(/[^\n]*0\.001[^\n]*/i) || ['(not found)'])[0].slice(0, 120);

// 3. /ledger triad
await page.goto(BASE + '/ledger', { waitUntil: 'networkidle' });
const ledgerText = await page.evaluate(() => document.body.innerText);
results.checks.ledger_has_rows = /release|refund|abstain/i.test(ledgerText);
results.checks.ledger_rowcount = await page.locator('table tr, [class*="row"]').count().catch(() => 0);

// 4. a11y: focus-visible on first courtroom button
await page.goto(BASE + '/courtroom', { waitUntil: 'networkidle' });
const btns = await page.locator('button').count();
results.checks.courtroom_buttons = btns;
await page.keyboard.press('Tab');
results.checks.focus_works = await page.evaluate(() => document.activeElement?.tagName !== 'BODY');

// 5. LIVE courtroom run — click abstain (cheapest), watch SSE render
await page.goto(BASE + '/courtroom', { waitUntil: 'networkidle' });
const abstainBtn = page.locator('button', { hasText: /unsupported|abstain/i }).first();
const t0 = Date.now();
await abstainBtn.click();
// wait up to 70s for settled status or verdict card to show a triad outcome
let settled = false;
try {
  await page.waitForFunction(() => {
    const t = document.body.innerText.toLowerCase();
    return t.includes('settled') || t.includes('refunded to payer') || t.includes('could not be judged');
  }, { timeout: 70000 });
  settled = true;
} catch {}
results.checks.courtroom_live_seconds = Math.round((Date.now() - t0) / 1000);
results.checks.courtroom_live_settled = settled;
const logText = await page.evaluate(() => document.body.innerText);
results.checks.courtroom_log_has_steps = /arbiter|escrow|evidence|verdict/i.test(logText);
results.checks.courtroom_log_has_floor = /conservative floor|deterministic floor|abstain/i.test(logText);
const liveShot = `${SHOT}/courtroom-live-run.png`;
await page.screenshot({ path: liveShot, fullPage: true }); results.shots.push(liveShot);

await browser.close();
console.log(JSON.stringify(results, null, 2));
