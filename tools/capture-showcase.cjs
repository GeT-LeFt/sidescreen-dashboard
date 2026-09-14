'use strict';
// Read-only screenshot capture. Redaction happens in the browser before PNG encoding.
// npm install --no-save playwright (or set PLAYWRIGHT_MODULE to its module path).
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const path = require('path');
const fs = require('fs');
const out = path.join(__dirname, '..', 'docs', 'images');
const origin = process.env.DASHBOARD_URL || 'http://127.0.0.1:3777';
(async () => {
  fs.mkdirSync(out, { recursive: true });
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    const ctx = await browser.newContext({ viewport: { width: 3840, height: 1100 }, deviceScaleFactor: 1 });
    // Viewing the showcase must never launch apps, change volume or send commands.
    await ctx.route('**/*', route => {
      if (!['GET', 'HEAD'].includes(route.request().method())) return route.abort();
      return route.continue();
    });
    const shots = [
      ['dashboard', 1, '#usageCard,#npCover,#npInfo,#lyricsCard,#weatherStrip,#dynCol,[data-f="model"],#clockDate'],
      ['sessions', 0, '#csMsg,#csDevs,#csUsage,.cs-card .cs-dev,.cs-card .proj,.cs-card .sid,.cs-card .act,.cs-card .reply'],
      ['controls', 2, '#cNp,#cDate,#sndApps,#appGrid'],
    ];
    for (const [name, pageNo, mask] of shots) {
      const p = await ctx.newPage();
      await p.goto(origin + '/wide?page=' + pageNo, { waitUntil: 'domcontentloaded' });
      await p.waitForTimeout(4500);
      await p.addStyleTag({ content: '#pageToast,#toast{display:none!important}' });
      // Native screenshot mask is a second opaque layer; no unredacted image is saved.
      await p.screenshot({ path: path.join(out, name + '.png'), mask: [p.locator(mask)], maskColor: '#172335', animations: 'disabled' });
      console.log(name + ': saved redacted 3840x1100 PNG');
      await p.close();
    }
    await ctx.close();
  } finally { await browser.close(); }
})().catch(e => { console.error(e.message); process.exitCode = 1; });
