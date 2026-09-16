/**
 * Build the accuracy -> rating table baked into public/js/rating.js.
 *
 * The estimate answers "what rating typically plays like this?": for each rating
 * band we measure the accuracy its players actually post (25th percentile, median,
 * 75th), then invert those three curves. A game's accuracy is looked up against the
 * median curve for the headline number, and against the p75/p25 curves for the range
 * - the lowest rating for which this was a good game, and the highest for which it
 * was a poor one.
 *
 * Why this and not E[rating | accuracy]: that regression is the best *guess at the
 * player's rating* but it shrinks every estimate toward the population middle, so a
 * 500 playing a normal game is told ~850 and a 2500 playing a normal game ~2000. It
 * is unbiased over the population and biased for every individual - the opposite of
 * what someone comparing the number to their own rating wants. The inverted curves
 * are noisier per game but centre on the player's real rating over many games,
 * which is the behaviour Chess.com's game rating has and users judge as accurate.
 *
 * Must be built from a NATURAL sample (harvest-ratings.mjs --natural). A band-balanced
 * sample distorts the curves at the ends.
 *
 *   node scripts/build-rating-table.mjs [samples.json]
 */

import fs from 'fs';

// The curves are per-band statistics (what accuracy do 1400s post?), so how many
// samples each band has does not bias them. That lets the band-balanced harvest be
// merged in purely for its coverage of strong players, which the natural sample
// barely reaches. Evaluation below is still reported per band, for the same reason.
const FILES = process.argv.length > 2
  ? process.argv.slice(2)
  : ['scripts/data/rating-samples-natural.json', 'scripts/data/rating-samples.json'];
const samples = [];
for (const file of FILES) {
  if (!fs.existsSync(file)) continue;
  const rows = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const r of rows) samples.push(r);
}
const FILE = FILES.join(' + ');
const CLASSES = ['bullet', 'blitz', 'rapid'];
const BAND = 200;
const MIN_PER_BAND = 30;

console.log('samples: ' + samples.length + ' from ' + FILE + '\n');

function quantile(sorted, p) {
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
}

/** Accuracy percentiles per rating band, forced monotone in rating. */
function curvesFor(rows) {
  const bins = new Map();
  for (const r of rows) {
    const b = Math.floor(r.rating / BAND) * BAND;
    if (!bins.has(b)) bins.set(b, []);
    bins.get(b).push(r.accuracy);
  }
  const points = [];
  for (const b of Array.from(bins.keys()).sort((a, c) => a - c)) {
    const v = bins.get(b).sort((a, c) => a - c);
    if (v.length < MIN_PER_BAND) continue;
    points.push({
      rating: b + BAND / 2,
      n: v.length,
      p25: quantile(v, 0.25),
      median: quantile(v, 0.5),
      p75: quantile(v, 0.75)
    });
  }
  // Higher rating may never mean lower typical accuracy; smooth out sampling dips.
  for (const key of ['p25', 'median', 'p75']) {
    for (let i = 1; i < points.length; i++) {
      if (points[i][key] < points[i - 1][key]) points[i][key] = points[i - 1][key];
    }
  }
  return points;
}

/** Rating at which the given curve reaches `accuracy`, with linear interpolation and clamping. */
function invert(points, key, accuracy) {
  if (!points.length) return null;
  const first = points[0];
  const last = points[points.length - 1];
  if (accuracy <= first[key]) return first.rating - BAND / 2;
  if (accuracy >= last[key]) return last.rating + BAND / 2;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    if (accuracy <= b[key]) {
      const span = b[key] - a[key];
      const t = span > 0 ? (accuracy - a[key]) / span : 1;
      return a.rating + t * (b.rating - a.rating);
    }
  }
  return last.rating;
}

const tables = {};
for (const tc of CLASSES) {
  const rows = samples.filter((s) => s.timeClass === tc);
  tables[tc] = curvesFor(rows);
  console.log(tc + ' (n=' + rows.length + ')  accuracy a player of each rating typically posts:');
  console.log('  rating     n    p25  median  p75');
  for (const p of tables[tc]) {
    console.log(
      '  ' + String(p.rating - BAND / 2).padStart(4) + '-' + String(p.rating + BAND / 2 - 1).padEnd(6) +
      String(p.n).padStart(4) + String(p.p25).padStart(7) + String(p.median).padStart(8) + String(p.p75).padStart(6)
    );
  }
  console.log();
}

/* ---- how well does the inverted table track real ratings? ---- */

console.log('estimate quality on the sample (median estimate for players in each real band):\n');
const errors = {};
for (const tc of CLASSES) {
  const pts = tables[tc];
  if (pts.length < 3) continue;
  const rows = samples.filter((s) => s.timeClass === tc);
  const bands = new Map();
  const errs = [];
  let inside = 0;
  for (const r of rows) {
    const mid = invert(pts, 'median', r.accuracy);
    const lo = invert(pts, 'p75', r.accuracy);
    const hi = invert(pts, 'p25', r.accuracy);
    errs.push(Math.abs(mid - r.rating));
    if (r.rating >= lo && r.rating <= hi) inside++;
    const b = Math.floor(r.rating / 400) * 400;
    if (!bands.has(b)) bands.set(b, []);
    bands.get(b).push(mid);
  }
  errs.sort((a, c) => a - c);
  errors[tc] = Math.round(quantile(errs, 0.5));
  console.log(tc + ':  median |error| ' + errors[tc] + '   range covers real rating ' + Math.round((100 * inside) / rows.length) + '%');
  console.log('    (bias per band is what matters: it says whether a player of that rating is read correctly on average)');
  for (const b of Array.from(bands.keys()).sort((a, c) => a - c)) {
    const v = bands.get(b).sort((a, c) => a - c);
    if (v.length < 25) continue;
    const med = Math.round(quantile(v, 0.5));
    console.log('    real ' + String(b).padStart(4) + '-' + (b + 399) + '  n=' + String(v.length).padStart(4) + '  estimate median ' + String(med).padStart(4) + '  bias ' + String(med - (b + 200)).padStart(5));
  }
  console.log();
}

fs.writeFileSync('scripts/data/rating-table.json', JSON.stringify({ tables, errors }, null, 1));

console.log('--- paste into public/js/rating.js ---\n');
console.log('export const RATING_CURVES = {');
for (const tc of CLASSES) {
  if (tables[tc].length < 3) continue;
  const rows = tables[tc].map((p) => '[' + p.rating + ',' + p.p25 + ',' + p.median + ',' + p.p75 + ']');
  console.log('  // ' + tc + ': [rating, p25 accuracy, median accuracy, p75 accuracy]');
  console.log('  ' + tc + ': [' + rows.join(', ') + '],');
}
console.log('};');
console.log('export const TYPICAL_ERROR = ' + JSON.stringify(errors) + ';');
