// node frames.mjs <page.html> <outdir> --at 1,2.5,9   (stills)
// node frames.mjs <page.html> <outdir> --fps 30 [--scale 1.2] [--from 0 --to TOTAL]   (every frame)
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';

const [page, outdir, ...rest] = process.argv.slice(2);
const opt = {};
for (let i = 0; i < rest.length; i += 2) opt[rest[i].replace(/^--/, '')] = rest[i + 1];
fs.mkdirSync(outdir, { recursive: true });
const scale = Number(opt.scale || 1);
const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
  args: ['--force-color-profile=srgb', '--hide-scrollbars', '--font-render-hinting=none'],
});
const tab = await browser.newPage();
await tab.setViewport({ width: 1600, height: 900, deviceScaleFactor: scale });
await tab.goto('file://' + path.resolve(page) + (opt.query ? '?' + opt.query : ''), { waitUntil: 'load' });
await tab.evaluate(() => document.fonts.ready);
const total = await tab.evaluate(() => window.TOTAL);
console.log('total', total, 'mono', await tab.evaluate(() => document.fonts.check('16px "SF Mono"')));

if (opt.at) {
  for (const t of opt.at.split(',').map(Number)) {
    await tab.evaluate((t) => window.render(t), t);
    await tab.screenshot({ path: path.join(outdir, `t${String(t).replace('.', '_')}.png`) });
  }
} else {
  const fps = Number(opt.fps || 30);
  const from = Number(opt.from || 0);
  const to = Math.min(Number(opt.to || total), total);
  const n = Math.round((to - from) * fps);
  for (let i = 0; i < n; i++) {
    const t = from + i / fps;
    await tab.evaluate((t) => window.render(t), t);
    await tab.screenshot({ path: path.join(outdir, `f${String(i).padStart(5, '0')}.png`) });
    if (i % 300 === 0) console.log('frame', i, '/', n);
  }
}
await browser.close();
