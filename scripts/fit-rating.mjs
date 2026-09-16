/**
 * Fit the accuracy -> rating model behind the "played like ~1750" estimate.
 *
 * There are two defensible models and they give very different answers, so this
 * script computes both and reports the trade-off:
 *
 *   A. E[rating | accuracy] - the best guess at the player's actual rating.
 *      Statistically optimal, but because accuracy explains only ~23% of rating
 *      variance it is heavily regressed toward the mean: 95% accuracy comes out
 *      around 2450 no matter how good the game was.
 *
 *   B. The inverse of E[accuracy | rating] - the rating whose *typical* accuracy
 *      matches this game. This is what "you played like a 2600" actually claims,
 *      and it does not compress at the extremes.
 *
 * The app uses B, because it matches what the feature says it is measuring. Its
 * error against the player's real rating is reported below and it is not small -
 * which is why the UI always shows a range.
 *
 *   node scripts/fit-rating.mjs [samples.json]
 */

import fs from 'fs';

const FILE = process.argv[2] || 'scripts/data/rating-samples.json';
const samples = JSON.parse(fs.readFileSync(FILE, 'utf8'));
const CLASSES = ['bullet', 'blitz', 'rapid'];

console.log('samples: ' + samples.length + '\n');

function weightedFit(points) {
  const W = points.reduce((a, p) => a + p.w, 0);
  const mx = points.reduce((a, p) => a + p.w * p.x, 0) / W;
  const my = points.reduce((a, p) => a + p.w * p.y, 0) / W;
  let num = 0;
  let den = 0;
  for (const p of points) {
    num += p.w * (p.x - mx) * (p.y - my);
    den += p.w * (p.x - mx) ** 2;
  }
  const slope = num / den;
  return { slope, intercept: my - slope * mx };
}

function errorStats(predict, rows) {
  const errs = rows.map((r) => Math.abs(r.rating - predict(r.accuracy, r.timeClass))).sort((a, b) => a - b);
  const mean = errs.reduce((a, b) => a + b, 0) / errs.length;
  return {
    mae: Math.round(mean),
    median: Math.round(errs[Math.floor(errs.length * 0.5)]),
    p90: Math.round(errs[Math.floor(errs.length * 0.9)])
  };
}

/* ------------------------------- model A: E[rating | accuracy] (regressed) -- */

const modelA = {};
for (const tc of CLASSES) {
  const rows = samples.filter((s) => s.timeClass === tc);
  if (rows.length < 300) continue;
  modelA[tc] = weightedFit(rows.map((s) => ({ x: s.accuracy, y: s.rating, w: 1 })));
}

/* ---------------- model B: invert E[accuracy | rating] (what "played like" means) -- */

console.log('mean accuracy at each rating level (the relationship we invert):\n');
const modelB = {};

for (const tc of CLASSES) {
  const rows = samples.filter((s) => s.timeClass === tc);
  if (rows.length < 300) continue;

  const bins = new Map();
  for (const s of rows) {
    const b = Math.floor(s.rating / 200) * 200;
    if (!bins.has(b)) bins.set(b, []);
    bins.get(b).push(s.accuracy);
  }

  const points = [];
  const shown = [];
  for (const b of Array.from(bins.keys()).sort((a, c) => a - c)) {
    const v = bins.get(b);
    if (v.length < 20) continue;
    const mean = v.reduce((a, c) => a + c, 0) / v.length;
    // Weight by sample count, so thin bands do not steer the line.
    points.push({ x: b + 100, y: mean, w: v.length });
    shown.push('  ' + String(b).padStart(4) + '  n=' + String(v.length).padStart(4) + '  acc ' + mean.toFixed(1));
  }

  const fit = weightedFit(points);
  // accuracy = slope * rating + intercept  ->  rating = (accuracy - intercept) / slope
  modelB[tc] = { perAccuracyPoint: 1 / fit.slope, intercept: fit.intercept, slope: fit.slope };

  console.log(tc + ' (n=' + rows.length + ', ' + points.length + ' bands)');
  console.log(shown.join('\n'));
  console.log(
    '  fit: accuracy = ' + fit.slope.toFixed(5) + ' * rating + ' + fit.intercept.toFixed(2) +
    '   ->  rating = (accuracy - ' + fit.intercept.toFixed(2) + ') / ' + fit.slope.toFixed(5) +
    '   (' + Math.round(1 / fit.slope) + ' rating per accuracy point)\n'
  );
}

/* --------------------------------------------------------- compare them -- */

const usable = samples.filter((s) => modelB[s.timeClass]);

const predictA = (acc, tc) => modelA[tc].slope * acc + modelA[tc].intercept;
const predictB = (acc, tc) => (acc - modelB[tc].intercept) / modelB[tc].slope;

console.log('error against the player\'s real rating (n=' + usable.length + '):');
console.log('  A  E[rating|accuracy]      ' + JSON.stringify(errorStats(predictA, usable)));
console.log('  B  inverse E[acc|rating]   ' + JSON.stringify(errorStats(predictB, usable)));

console.log('\nwhat each model says for a given accuracy:');
console.log('  acc    A-bullet  B-bullet   A-blitz  B-blitz   A-rapid  B-rapid');
for (const acc of [60, 70, 80, 85, 90, 95]) {
  const cells = [];
  for (const tc of CLASSES) {
    cells.push(String(Math.round(predictA(acc, tc))).padStart(9));
    cells.push(String(Math.round(predictB(acc, tc))).padStart(9));
  }
  console.log('  ' + String(acc).padStart(3) + cells.join(''));
}

/* --------------------------------------------- per-class error for model B -- */

console.log('\nmodel B error by time class:');
const errors = {};
for (const tc of CLASSES) {
  if (!modelB[tc]) continue;
  const rows = usable.filter((s) => s.timeClass === tc);
  const stats = errorStats(predictB, rows);
  errors[tc] = stats.median;
  console.log('  ' + tc.padEnd(7) + ' median ' + String(stats.median).padStart(4) + '  MAE ' + String(stats.mae).padStart(4) + '  p90 ' + String(stats.p90).padStart(4));
}

console.log('\n--- paste into public/js/rating.js ---\n');
console.log('export const RATING_MODEL = {');
for (const tc of CLASSES) {
  if (!modelB[tc]) continue;
  console.log(
    '  ' + tc + ': { slope: ' + modelB[tc].slope.toFixed(5) +
    ', intercept: ' + modelB[tc].intercept.toFixed(2) +
    ', error: ' + errors[tc] + ' },'
  );
}
const blitz = modelB.blitz;
console.log('  daily: { slope: ' + modelB.rapid.slope.toFixed(5) + ', intercept: ' + modelB.rapid.intercept.toFixed(2) + ', error: ' + errors.rapid + ' },');
console.log('  default: { slope: ' + blitz.slope.toFixed(5) + ', intercept: ' + blitz.intercept.toFixed(2) + ', error: ' + errors.blitz + ' }');
console.log('};');
