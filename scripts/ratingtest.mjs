/**
 * Checks on the "played like ~1750" estimator.
 *
 * The property that matters is per-band bias: a player of a given rating, playing
 * a typical game, should be read as roughly that rating - not pulled toward the
 * population middle. That is verified against the harvested real games, per
 * 400-point band, for every time class the estimator supports.
 *
 *   node scripts/ratingtest.mjs
 */

import fs from 'fs';
import { estimateRating, TYPICAL_ERROR } from '../public/js/rating.js';

let failures = 0;
const check = (label, ok, extra) => {
  console.log((ok ? '  ok   ' : '  FAIL ') + label + (ok || !extra ? '' : ' — ' + extra));
  if (!ok) failures++;
};

/* ------------------------------------------------------------- basics -- */

console.log('sanity');

check('needs an accuracy', estimateRating({ accuracy: null, timeClass: 'blitz', moveCount: 40 }) === null);
check('short games are declined with a reason', estimateRating({ accuracy: 85, timeClass: 'blitz', moveCount: 6 }).reason === 'short');
check('rejects NaN', estimateRating({ accuracy: NaN, timeClass: 'blitz', moveCount: 40 }) === null);

const typical = estimateRating({ accuracy: 76, timeClass: 'blitz', moveCount: 40 });
check('returns a rating', typical && typical.available && typical.rating > 0, JSON.stringify(typical));
check('range brackets the estimate', typical.low <= typical.rating && typical.high >= typical.rating, JSON.stringify(typical));
check('rounded to 25', typical.rating % 25 === 0, String(typical.rating));

const unknownClass = estimateRating({ accuracy: 76, timeClass: 'something-else', moveCount: 40 });
check('unknown time class falls back sensibly', unknownClass !== null && unknownClass.available);

const bullet = estimateRating({ accuracy: 80, timeClass: 'bullet', moveCount: 40 });
check('bullet is declined outright, not guessed at', bullet.available === false && bullet.reason === 'bullet', JSON.stringify(bullet));

/* --------------------------------------------------------- monotonic -- */

console.log('\nordering');
for (const tc of ['blitz', 'rapid']) {
  let monotonic = true;
  let previous = -Infinity;
  for (let acc = 40; acc <= 100; acc += 2) {
    const r = estimateRating({ accuracy: acc, timeClass: tc, moveCount: 40 });
    if (r.rating < previous) monotonic = false;
    previous = r.rating;
  }
  check(tc + ': more accuracy never means a lower rating', monotonic);
}

/* ------------------------------------------------------------ bounds -- */

console.log('\nbounds');
const perfect = estimateRating({ accuracy: 100, timeClass: 'blitz', moveCount: 40 });
const awful = estimateRating({ accuracy: 20, timeClass: 'blitz', moveCount: 40 });
check('a perfect game tops out at a real rating', perfect.rating <= 3500, String(perfect.rating));
check('a terrible game does not go negative', awful.rating >= 0, String(awful.rating));

// The case that prompted the redesign: a low-rated player's ordinary game must read
// as low-rated, not be flattered up toward the population average.
const ordinary500 = estimateRating({ accuracy: 65, timeClass: 'rapid', moveCount: 40 });
check('a typical ~500 rapid game (65%) reads as roughly 500, not ~1000',
  ordinary500.rating >= 350 && ordinary500.rating <= 700, String(ordinary500.rating));
const ordinary2000 = estimateRating({ accuracy: 80, timeClass: 'rapid', moveCount: 40 });
check('a typical ~2000 rapid game (80%) reads as roughly 2000',
  ordinary2000.rating >= 1800 && ordinary2000.rating <= 2300, String(ordinary2000.rating));

/* -------------------------------------------- calibration against data -- */

const FILES = ['scripts/data/rating-samples-natural.json', 'scripts/data/rating-samples.json'].filter((f) => fs.existsSync(f));
if (!FILES.length) {
  console.log('\n(no harvested samples; run scripts/harvest-ratings.mjs to check calibration)');
} else {
  const samples = FILES.flatMap((f) => JSON.parse(fs.readFileSync(f, 'utf8')));
  console.log('\ncalibration against ' + samples.length + ' real games');

  for (const tc of ['blitz', 'rapid']) {
    const rows = samples.filter((s) => s.timeClass === tc);
    const errors = [];
    let inside = 0;
    const bands = new Map();

    for (const s of rows) {
      const e = estimateRating({ accuracy: s.accuracy, timeClass: tc, moveCount: 40 });
      if (!e || !e.available) continue;
      errors.push(Math.abs(s.rating - e.rating));
      if (s.rating >= e.low && s.rating <= e.high) inside++;
      const b = Math.floor(s.rating / 400) * 400;
      if (!bands.has(b)) bands.set(b, []);
      bands.get(b).push(e.rating);
    }
    errors.sort((a, b) => a - b);
    const median = errors[Math.floor(errors.length / 2)];
    const coverage = Math.round((100 * inside) / errors.length);

    console.log('\n  ' + tc + ' (n=' + errors.length + '): median error ' + Math.round(median) + ', range covers real rating ' + coverage + '%');
    check(tc + ': median error matches the documented figure', median <= TYPICAL_ERROR[tc] + 60, String(Math.round(median)));
    check(tc + ': range coverage is close to the 50% the quartiles promise', coverage >= 40 && coverage <= 62, coverage + '%');

    // The headline property: no band is systematically flattered or under-sold.
    let worstBias = 0;
    const shown = [];
    for (const b of Array.from(bands.keys()).sort((x, y) => x - y)) {
      const v = bands.get(b).sort((x, y) => x - y);
      if (v.length < 40) continue;
      const med = v[Math.floor(v.length / 2)];
      const bias = med - (b + 200);
      shown.push(b + '→' + Math.round(med));
      if (Math.abs(bias) > Math.abs(worstBias)) worstBias = bias;
    }
    console.log('    real band → median estimate: ' + shown.join('  '));
    check(tc + ': every rating band is read within 120 points of itself', Math.abs(worstBias) <= 120, 'worst bias ' + Math.round(worstBias));
  }
}

console.log(failures ? '\n' + failures + ' FAILURES' : '\nAll rating estimator checks passed.');
process.exit(failures ? 1 : 0);
