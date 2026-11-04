# Banner and demo sources

`banner.html` and `demo.html` are the sources of `../banner.webp`, `../demo.webp` and `../demo.mp4`. The demo is a
timeline: `render(t)` draws the frame at `t` seconds, so a render always comes out the same.

Render them with Google Chrome, ffmpeg and `img2webp` (from libwebp), with `puppeteer-core` installed next to the
scripts (`npm install --no-save puppeteer-core`):

```sh
node shot.mjs banner.html banner.png 1280 512 2
ffmpeg -i banner.png -c:v libwebp -quality 92 -pix_fmt yuva420p banner.webp

node video.mjs demo.html master.mp4 30 1.2        # 1920x1080, near lossless
ffmpeg -i master.mp4 -c:v libx264 -preset slow -tune animation -crf 22 -pix_fmt yuv420p -movflags +faststart demo.mp4

node frames.mjs demo.html frames --fps 15 --scale 0.8 --query cuts=1
img2webp -loop 0 -mixed -q 92 -m 6 -d 67 frames/*.png -o demo.webp
```

The WebP renders with `?cuts=1`: quick cuts and no window glow. A lossy WebP leaves stale blocks behind a slow
fade on a dark background, and frames taken straight from Chrome keep still areas identical from frame to frame.
Keep `demo.mp4` under 10 MB, so it can also be attached on GitHub, and `demo.webp` under about 5 MB.
