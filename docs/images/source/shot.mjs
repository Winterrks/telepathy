// node shot.mjs <page.html> <out.png> <width> <height> [scale]
import puppeteer from 'puppeteer-core';
import path from 'node:path';

const [page, out, w, h, scale = '2'] = process.argv.slice(2);
const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
  args: ['--force-color-profile=srgb', '--hide-scrollbars'],
});
const tab = await browser.newPage();
await tab.setViewport({ width: Number(w), height: Number(h), deviceScaleFactor: Number(scale) });
await tab.goto('file://' + path.resolve(page), { waitUntil: 'load' });
await tab.evaluate(() => document.fonts.ready);
await tab.screenshot({ path: out, omitBackground: true });
await browser.close();
