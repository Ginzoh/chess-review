/**
 * Analyse a set of games once and cache slim per-move data for the accuracy lab.
 *
 *   node scripts/analyse-set.mjs <games.json> <moves.json> [depth]
 */
import fs from 'fs';
import { CliEngine } from './cli-engine.mjs';
import { analyseGame } from '../public/js/analysis.js';

const [gamesFile, movesFile] = process.argv.slice(2);
const DEPTH = Number(process.argv[4] || 12);

export function slimMoves(analysis) {
  return analysis.moves.map((m) => ({
    color: m.color,
    isBest: m.isBest,
    forced: m.label.key === 'forced',
    evalBeforeCp: m.evalBeforeCp,
    evalAfterCp: m.evalAfterCp,
    winBefore: m.winBefore,
    winAfter: m.winAfter,
    missedWin: m.missedWin ? m.missedWin.kind : null,
    mateBefore: m.bestScore && m.bestScore.mate !== null && m.bestScore.mate !== undefined ? m.bestScore.mate : null,
    mateAfter: m.afterScore && m.afterScore.mate !== null && m.afterScore.mate !== undefined ? -m.afterScore.mate : null
  }));
}

const games = JSON.parse(fs.readFileSync(gamesFile, 'utf8'));
const engine = new CliEngine();
await engine.boot();
const out = { depth: DEPTH, games: [] };
const t0 = Date.now();
for (const [i, g] of games.entries()) {
  const a = await analyseGame(engine, g.pgn, { depth: DEPTH }, () => {});
  out.games.push({ timeClass: g.timeClass, white: g.white, black: g.black, moves: slimMoves(a) });
  console.log('  analysed ' + (i + 1) + '/' + games.length + '  (' + Math.round((Date.now() - t0) / 1000) + 's)');
}
engine.quit();
fs.writeFileSync(movesFile, JSON.stringify(out));
console.log('cached ' + out.games.length + ' games to ' + movesFile);
