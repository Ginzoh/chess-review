/**
 * "Played like ~1750" - the rating a game's move quality corresponds to.
 *
 * The question this answers is "what rating typically plays like this?". For each
 * rating band we measured the accuracy its players actually post - 25th percentile,
 * median and 75th - on ~16,000 real rated Chess.com games (scripts/harvest-ratings.mjs
 * with --natural, plus a band-balanced harvest for coverage of strong players;
 * scripts/build-rating-table.mjs). A game's accuracy is then looked up against the
 * median curve for the headline number, and against the p75 and p25 curves for the
 * range: the lowest rating for which this was a good game, and the highest for which
 * it was a poor one.
 *
 * This replaced an earlier version that estimated E[rating | accuracy] from a
 * band-balanced sample. That had two faults, one a bug and one a design choice:
 *
 *  - The balanced sample made the population look uniform from 400 to 3200 when
 *    68% of real players are under 1200. That alone inflated a typical low-rated
 *    player's estimate by 200-300 points.
 *  - E[rating | accuracy] is the best guess at a player's rating over the whole
 *    population, and for that very reason it shrinks every estimate toward the
 *    middle: a 500 playing a normal game was told ~850. It is unbiased for the
 *    population and biased for every individual - the opposite of what someone
 *    comparing the number to their own rating wants.
 *
 * The inverted curves are noisier per game (median error ~520 rapid, ~710 blitz)
 * but they centre on the player's real rating: measured per 400-point band across
 * 100-3400, the median estimate is within about 50 points of the band it came
 * from. That is the behaviour Chess.com's game rating has, and what users read as
 * accurate. The range shown beside the number is what makes the noise honest.
 *
 * Bullet is still not estimated. Its curve is nearly flat and non-monotone in the
 * middle (a 1600-1999 bullet player came out at ~1100), so there is no reading of
 * a single bullet game that means anything.
 */

/** [band centre rating, p25 accuracy, median accuracy, p75 accuracy] - Chess.com's accuracy scale. */
export const RATING_CURVES = {
  blitz: [
    [100, 48.78, 62.24, 73.49], [300, 58.52, 66.28, 75.81], [500, 58.73, 68.7, 77.31], [700, 61.54, 71.32, 78.61],
    [900, 64.49, 73.02, 79.67], [1100, 66.94, 74.8, 81.78], [1300, 68.73, 75.25, 81.87], [1500, 69.04, 75.57, 83.24],
    [1700, 71.55, 77.48, 83.24], [1900, 71.55, 77.98, 83.36], [2100, 73.31, 79.12, 84.21], [2300, 75.18, 81.06, 87.5],
    [2500, 77.62, 82.49, 87.5], [2700, 78.29, 82.64, 87.5], [2900, 79.84, 84.18, 88.4], [3100, 80.86, 86.46, 91.72],
    [3300, 83.82, 88.63, 92.74]
  ],
  rapid: [
    [100, 46.4, 57.35, 64.64], [300, 49.09, 60.52, 69.8], [500, 55.85, 64.82, 73.87], [700, 61.76, 69.72, 77.09],
    [900, 65.43, 72.08, 79.3], [1100, 65.86, 73.61, 80.5], [1300, 67.91, 73.92, 80.94], [1500, 69.68, 76.42, 83.02],
    [1700, 69.81, 76.42, 83.02], [1900, 71.11, 76.82, 83.81], [2100, 75.26, 80.81, 86.04], [2300, 80.26, 84.2, 87.61],
    [2500, 80.26, 85.87, 89.71], [2700, 83.68, 88.56, 92.44]
  ]
};

/** Median absolute error of the headline number against real ratings, per time class. */
export const TYPICAL_ERROR = { blitz: 711, rapid: 519 };

/** Below this many moves there is not enough evidence to say anything at all. */
const MIN_MOVES = 10;
const BAND = 200;

/** Rating at which `curve` reaches `accuracy`: linear between band centres, clamped at the ends. */
function invert(points, index, accuracy) {
  const first = points[0];
  const last = points[points.length - 1];
  if (accuracy <= first[index]) return first[0] - BAND / 2;
  if (accuracy >= last[index]) return last[0] + BAND / 2;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    if (accuracy <= b[index]) {
      const span = b[index] - a[index];
      const t = span > 0 ? (accuracy - a[index]) / span : 1;
      return a[0] + t * (b[0] - a[0]);
    }
  }
  return last[0];
}

/**
 * @param {{accuracy:number|null, timeClass?:string, moveCount:number}} input
 *        `accuracy` must already be on Chess.com's scale (see calibrateAccuracy in analysis.js).
 * @returns {{available:boolean, reason?:string, rating?:number, low?:number, high?:number,
 *            reliable?:boolean}|null}
 */
export function estimateRating(input) {
  const accuracy = input && input.accuracy;
  if (accuracy === null || accuracy === undefined || !isFinite(accuracy)) return null;

  if (input.timeClass === 'bullet') return { available: false, reason: 'bullet' };
  if (!input.moveCount || input.moveCount < MIN_MOVES) return { available: false, reason: 'short' };

  // Daily and anything unknown use the rapid curve - long think time, like rapid.
  const curve = RATING_CURVES[input.timeClass] || RATING_CURVES.rapid;
  const round = (v) => Math.round(v / 25) * 25;

  // Median curve for the number; p75 gives the lowest rating for which this was a
  // *good* game, p25 the highest for which it was a *poor* one.
  const rating = round(invert(curve, 2, accuracy));
  const low = round(invert(curve, 3, accuracy));
  const high = round(invert(curve, 1, accuracy));

  return {
    available: true,
    rating: rating,
    low: Math.min(low, rating),
    high: Math.max(high, rating),
    reliable: input.moveCount >= 20
  };
}

/** Why no number is shown, in words. */
export function unavailableReason(estimate) {
  if (!estimate || estimate.available) return '';
  if (estimate.reason === 'bullet') {
    return 'Not shown for bullet: accuracy barely varies with rating there, so any estimate would be guesswork.';
  }
  return 'Too few moves to estimate a rating from.';
}

/** One line explaining what the number is, for a tooltip. */
export function ratingTooltip(estimate, timeClass) {
  if (!estimate || !estimate.available) return unavailableReason(estimate);
  const base =
    'This accuracy is what a ~' + estimate.rating + ' player typically posts in rated ' +
    (timeClass || 'online') + ' games. It would be a good game for a ' + estimate.low +
    ' and a poor one for a ' + estimate.high + '. Measured on ~16,000 real games.';
  return estimate.reliable
    ? base + ' One game swings a lot - read it as a range.'
    : base + ' Treat this one as very rough - a short game proves little.';
}
