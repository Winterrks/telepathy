// node video.mjs <page.html> <master.mp4> [fps=30] [scale=1.2]
// Renders every frame of the page's timeline and pipes it into ffmpeg as a near-lossless master.
import puppeteer from 'puppeteer-core';
import { spawn } from 'node:child_process';
import path from 'node:path';

const [page, out, fpsArg = '30', scaleArg = '1.2'] = process.argv.slice(2);
const fps = Number(fpsArg);
const scale = Number(scaleArg);
const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
  args: ['--force-color-profile=srgb', '--hide-scrollbars', '--font-render-hinting=none'],
});
const tab = await browser.newPage();
await tab.setViewport({ width: 1600, height: 900, deviceScaleFactor: scale });
await tab.goto('file://' + path.resolve(page), { waitUntil: 'load' });
await tab.evaluate(() => document.fonts.ready);
const total = await tab.evaluate(() => window.TOTAL);
const n = Math.round(total * fps);

const ff = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(fps), '-i', '-',
  '-c:v', 'libx264', '-preset', 'medium', '-crf', '6', '-pix_fmt', 'yuv444p', out], { stdio: ['pipe', 'inherit', 'inherit'] });
const done = new Promise((resolve, reject) => ff.on('close', (code) => (code === 0 ? resolve() : reject(new Error('ffmpeg ' + code)))));

const started = Date.now();
for (let i = 0; i < n; i++) {
  await tab.evaluate((t) => window.render(t), i / fps);
  const buf = await tab.screenshot({ type: 'png', optimizeForSpeed: true });
  if (!ff.stdin.write(buf)) await new Promise((r) => ff.stdin.once('drain', r));
  if (i % 300 === 0) console.log(`frame ${i}/${n} (${((Date.now() - started) / 1000).toFixed(0)}s)`);
}
ff.stdin.end();
await done;
await browser.close();
console.log(`done: ${n} frames, ${total}s, in ${((Date.now() - started) / 1000).toFixed(0)}s`);
