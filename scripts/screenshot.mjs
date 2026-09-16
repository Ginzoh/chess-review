/**
 * Capture screenshots of the running app, for eyeballing the layout.
 *
 *   node scripts/screenshot.mjs [username] [outDir]
 */

import path from 'path';
import { launch } from './cdp.mjs';

const PORT = process.env.PORT || 5173;
const BASE = 'http://localhost:' + PORT;
const username = process.argv[2] || 'hikaru';
const outDir = process.argv[3] || '.';

const page = await launch({ width: 1500, height: 1050, port: 9223 });

try {
  await page.navigate(BASE + '/');
  await page.waitFor('document.querySelector(".home h1")', 15000, 'home');
  await page.screenshot(path.join(outDir, 'shot-home.png'));

  await page.evaluate('location.hash = "#/u/' + username + '"');
  await page.waitFor('document.querySelectorAll(".game-row").length > 0', 30000, 'games');
  await page.screenshot(path.join(outDir, 'shot-games.png'));

  await page.evaluate('document.querySelectorAll(".game-row")[0].click()');
  await page.waitFor('document.querySelector("#board .piece")', 15000, 'board');
  await page.screenshot(path.join(outDir, 'shot-game.png'));

  await page.evaluate('document.getElementById("depth-select").value = "12"');
  await page.evaluate('document.getElementById("btn-analyse").click()');
  await page.waitFor('document.querySelector("#review-slot .finding")', 600000, 'review');

  // Land on a real mistake so the commentary panel has something to show.
  await page.evaluate(
    'const j = document.querySelectorAll("#review-slot .f-jump"); if (j.length) j[j.length > 2 ? 2 : 0].click();'
  );
  await page.screenshot(path.join(outDir, 'shot-review.png'));
  await page.screenshot(path.join(outDir, 'shot-review-full.png'), true);

  const errors = page.errors();
  if (errors.length) console.log('page errors:\n  ' + errors.join('\n  '));
  console.log('Saved shot-home.png, shot-games.png, shot-game.png, shot-review.png, shot-review-full.png to ' + outDir);
} finally {
  await page.close();
}
