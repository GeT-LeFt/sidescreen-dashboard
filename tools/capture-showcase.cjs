'use strict';
// Real running UI + fictional content; fixtures replace private endpoints before rendering.
// npm install --no-save playwright (or set PLAYWRIGHT_MODULE to its module path).
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const path = require('path');
const fs = require('fs');
const demo = require('./showcase-data.cjs')();
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
      const url = new URL(route.request().url());
      if (['127.0.0.1','localhost'].includes(url.hostname) && demo[url.pathname]) {
        return route.fulfill({status:200,contentType:'application/json',headers:{'Access-Control-Allow-Origin':'*'},body:JSON.stringify(demo[url.pathname])});
      }
      return route.continue();
    });
    const shots = [
      ['dashboard', 1],
      ['sessions', 0],
      ['controls', 2],
      ['media', 3],
    ];
    for (const [name, pageNo] of shots) {
      const p = await ctx.newPage();
      await p.goto(origin + '/wide?page=' + pageNo, { waitUntil: 'domcontentloaded' });
      await p.waitForTimeout(4500);
      await p.addStyleTag({ content: '#pageToast,#toast{display:none!important}' });
      await p.evaluate(() => {
        const badge = document.createElement('div');
        badge.textContent='DEMO · 会话 / 额度 / 媒体均为示例';
        badge.style.cssText='position:fixed;right:32px;top:6px;z-index:99999;font:18px Microsoft YaHei,sans-serif;color:#8493a9;background:#0a0c10;padding:0 12px;border-radius:8px;pointer-events:none';
        document.body.appendChild(badge);
      });
      await p.screenshot({ path: path.join(out, name + '.png'), animations: 'disabled' });
      console.log(name + ': saved example-filled 3840x1100 PNG');
      await p.close();
    }
    await ctx.close();
  } finally { await browser.close(); }
})().catch(e => { console.error(e.message); process.exitCode = 1; });
