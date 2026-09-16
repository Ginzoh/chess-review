/**
 * Contrast audit: walks the rendered review page and reports the WCAG contrast
 * ratio of every text element against the background actually painted behind it.
 *
 * Flags anything under 4.5:1 (AA for body text) and 3:1 (AA for large text).
 *
 *   node scripts/contrast.mjs [username]
 */

import { launch } from './cdp.mjs';

const PORT = process.env.PORT || 5173;
const BASE = 'http://localhost:' + PORT;
const USERNAME = process.argv[2] || 'hikaru';

const page = await launch({ width: 1500, height: 1000, port: 9230 });

const AUDIT = `(() => {
  const parse = (c) => {
    const m = c.match(/rgba?\\(([^)]+)\\)/);
    if (!m) return null;
    const p = m[1].split(',').map((x) => parseFloat(x));
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  };
  const lum = (c) => {
    const f = (v) => {
      v /= 255;
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
  };
  const over = (fg, bg) => ({
    r: fg.r * fg.a + bg.r * (1 - fg.a),
    g: fg.g * fg.a + bg.g * (1 - fg.a),
    b: fg.b * fg.a + bg.b * (1 - fg.a),
    a: 1
  });
  /** The first opaque background painted behind this element. */
  const backdrop = (el) => {
    let node = el;
    let acc = null;
    while (node && node !== document.documentElement) {
      const bg = parse(getComputedStyle(node).backgroundColor);
      if (bg && bg.a > 0) acc = acc ? over(acc, bg) : bg;
      if (acc && acc.a >= 1) return acc;
      node = node.parentElement;
    }
    return acc || { r: 20, g: 22, b: 28, a: 1 };
  };

  const rows = [];
  const seen = new Set();
  for (const el of document.querySelectorAll('#view *')) {
    const text = Array.from(el.childNodes)
      .filter((n) => n.nodeType === 3)
      .map((n) => n.textContent.trim())
      .join(' ')
      .trim();
    if (!text) continue;
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || parseFloat(style.opacity) === 0) continue;
    const rect = el.getBoundingClientRect();
    if (!rect.width || !rect.height) continue;

    const fg = parse(style.color);
    if (!fg) continue;
    // Fold in any inherited opacity, or a dimmed element reads better than it looks.
    let opacity = 1;
    for (let n = el; n && n !== document.documentElement; n = n.parentElement) {
      opacity *= parseFloat(getComputedStyle(n).opacity);
    }
    fg.a *= opacity;
    const bg = backdrop(el);
    const solid = fg.a < 1 ? over(fg, bg) : fg;
    const l1 = lum(solid);
    const l2 = lum(bg);
    const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);

    const size = parseFloat(style.fontSize);
    const bold = parseInt(style.fontWeight, 10) >= 700;
    const large = size >= 24 || (size >= 18.66 && bold);
    const needs = large ? 3 : 4.5;

    const key = el.className + '|' + style.color + '|' + Math.round(size);
    if (seen.has(key)) continue;
    seen.add(key);

    rows.push({
      sel: (el.tagName.toLowerCase() + (typeof el.className === 'string' && el.className ? '.' + el.className.trim().split(/\\s+/).join('.') : '')).slice(0, 46),
      color: style.color,
      size: Math.round(size),
      ratio: Math.round(ratio * 100) / 100,
      needs,
      pass: ratio >= needs,
      sample: text.slice(0, 40)
    });
  }
  return rows.sort((a, b) => a.ratio - b.ratio);
})()`;

try {
  await page.navigate(BASE + '/');
  await page.waitFor('document.querySelector(".home h1")', 15000);
  await page.evaluate('location.hash = "#/u/' + USERNAME + '"');
  await page.waitFor('document.querySelectorAll(".game-row").length > 0', 30000);
  await page.evaluate('document.querySelectorAll(".game-row")[0].click()');
  await page.waitFor('document.querySelector("#board .piece")', 15000);
  await page.evaluate('document.getElementById("depth-select").value = "12"');
  await page.evaluate('document.getElementById("btn-analyse").click()');
  await page.waitFor('document.querySelector("#review-slot .finding")', 400000);

  // Land on a move with commentary so the note card is populated.
  await page.evaluate(
    `(() => { const j = document.querySelectorAll('#review-slot .f-jump'); if (j.length) j[0].click(); })()`
  );

  const rows = await page.evaluate(AUDIT);
  const failing = rows.filter((r) => !r.pass);

  console.log('contrast audit — ' + rows.length + ' distinct text styles on the review page\n');
  console.log('  ratio  need  size  selector                                      sample');
  for (const r of rows.slice(0, 22)) {
    console.log(
      '  ' + (r.pass ? ' ' : '!') + String(r.ratio).padStart(5) +
      String(r.needs).padStart(6) +
      String(r.size).padStart(6) + '  ' +
      r.sel.padEnd(46) + '  ' + r.sample
    );
  }
  console.log('\n' + failing.length + ' below AA:');
  for (const r of failing) console.log('  ' + r.ratio + ':1 (needs ' + r.needs + ')  ' + r.sel + '  ' + r.color);
} finally {
  await page.close();
}
