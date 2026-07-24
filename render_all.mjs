// render_all.mjs
//
// Render every exercise (#1..#407) via the practice page's Verovio
// renderer and save a screenshot of the score container to
// /tmp/bml-renders/<NNNN>.png. Used by visual_diff_transcriptions.py.
//
// Usage:
//   node render_all.mjs
//
// Assumes the dev server is running on localhost:8080.

import { createRequire } from 'node:module';
import { mkdir, unlink, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const require = createRequire('/Users/kaidejuricmasscmbook/.nvm/versions/node/v26.1.0/lib/node_modules/playwright/');
const { chromium } = require('playwright');

const BASE = 'http://localhost:8080';
const OUT_DIR = '/tmp/bml-renders';
const START = 1;
const END = 407;

if (!existsSync(OUT_DIR)) {
  await mkdir(OUT_DIR, { recursive: true });
}

const browser = await chromium.launch({ headless: true });
try {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
  const page = await ctx.newPage();
  // Pre-set the range + dismiss-seen flag so the range modal
  // doesn't pop up on the first navigation.
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => {
    localStorage.setItem('jazz_lex_ranges', JSON.stringify({
      'concert': { lowMidi: 56, highMidi: 76, lowName: 'Ab3', highName: 'E5' },
    }));
    localStorage.setItem('jazz_lex_range_seen', '1');
  });

  let ok = 0, fail = 0;
  const t0 = Date.now();
  for (let eid = START; eid <= END; eid++) {
    const padded = String(eid).padStart(4, '0');
    const out = join(OUT_DIR, `${padded}.png`);
    try {
      await page.goto(`${BASE}/practice/?id=${eid}`, {
        waitUntil: 'domcontentloaded',
        timeout: 20000,
      });
      // Wait for the score SVG to render. Some broken exercises
      // (e.g. id 17, 79, 132, 152, 168, 229) take longer because
      // the server returns a static-PNG fallback.
      try {
        await page.waitForFunction(() => {
          const svg = document.querySelector('#score-container svg');
          return svg && svg.children.length > 0;
        }, { timeout: 8000 });
      } catch (e) {
        // Fall through — we still screenshot whatever rendered.
      }
      const el = await page.$('#score-container');
      if (el) {
        await el.screenshot({ path: out });
        ok++;
      } else {
        fail++;
      }
    } catch (e) {
      fail++;
    }
    if (eid % 20 === 0 || eid === END) {
      const elapsed = (Date.now() - t0) / 1000;
      const rate = (eid - START + 1) / elapsed;
      const remaining = (END - eid) / rate;
      process.stderr.write(`  ${eid}/${END}  ok=${ok} fail=${fail}  elapsed=${elapsed.toFixed(0)}s  remaining≈${remaining.toFixed(0)}s\n`);
    }
  }
  console.log(`Done. ok=${ok} fail=${fail}`);
} finally {
  await browser.close();
}
