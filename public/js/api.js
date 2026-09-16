/**
 * Thin client for the Chess.com published-data API - via our own proxy at /api/chess/
 * when the local server is running, straight to api.chess.com on a static host.
 */

import { STATIC_HOST } from './config.js';

const DRAW_RESULTS = new Set(['agreed', 'repetition', 'stalemate', 'insufficient', 'timevsinsufficient', '50move']);

const TERMINATION_TEXT = {
  win: 'won',
  checkmated: 'checkmate',
  agreed: 'draw by agreement',
  repetition: 'draw by repetition',
  timeout: 'on time',
  resigned: 'by resignation',
  stalemate: 'stalemate',
  lose: 'lost',
  insufficient: 'insufficient material',
  '50move': 'the fifty-move rule',
  abandoned: 'abandoned',
  kingofthehill: 'king of the hill',
  threecheck: 'three check',
  timevsinsufficient: 'timeout vs insufficient material',
  bughousepartnerlose: 'bughouse partner lost'
};

async function get(path) {
  // Chess.com's public API allows cross-origin reads, so a static host can skip the proxy.
  const base = STATIC_HOST ? 'https://api.chess.com/pub/' : '/api/chess/';
  const res = await fetch(base + path, { headers: { Accept: 'application/json' } });
  if (res.status === 404) {
    const err = new Error('Not found');
    err.code = 404;
    throw err;
  }
  if (!res.ok) {
    const err = new Error('Chess.com returned ' + res.status);
    err.code = res.status;
    throw err;
  }
  return res.json();
}

export function getPlayer(username) {
  return get('player/' + encodeURIComponent(username.toLowerCase()));
}

export function getStats(username) {
  return get('player/' + encodeURIComponent(username.toLowerCase()) + '/stats');
}

export async function getArchives(username) {
  const data = await get('player/' + encodeURIComponent(username.toLowerCase()) + '/games/archives');
  // Turn the absolute URLs into { year, month } newest first.
  return (data.archives || [])
    .map((url) => {
      const m = url.match(/\/(\d{4})\/(\d{2})$/);
      return m ? { year: m[1], month: m[2] } : null;
    })
    .filter(Boolean)
    .reverse();
}

export async function getMonthGames(username, year, month) {
  const data = await get('player/' + encodeURIComponent(username.toLowerCase()) + '/games/' + year + '/' + month);
  return (data.games || []).map(normaliseGame).reverse();
}

/** "180" -> "3 min", "180+2" -> "3|2", "1/86400" -> "1 day/move". */
export function formatTimeControl(tc) {
  if (!tc) return null;
  const daily = String(tc).match(/^1\/(\d+)$/);
  if (daily) {
    const days = Math.round(Number(daily[1]) / 86400);
    return days + ' day' + (days === 1 ? '' : 's') + '/move';
  }
  const m = String(tc).match(/^(\d+)(?:\+(\d+))?$/);
  if (!m) return String(tc);
  const base = Number(m[1]);
  const increment = m[2] ? Number(m[2]) : 0;
  const minutes = base % 60 === 0 ? base / 60 : (base / 60).toFixed(1);
  return increment ? minutes + '|' + increment : minutes + ' min';
}

export function proxiedImage(url) {
  if (!url) return null;
  if (STATIC_HOST) return url;
  return '/api/img?u=' + encodeURIComponent(url);
}

/** Chess.com's ECO URLs carry the line's moves in the slug; keep just the name. */
export function openingFromEcoUrl(ecoUrl) {
  if (!ecoUrl) return null;
  const slug = ecoUrl.split('/openings/')[1];
  if (!slug) return null;
  const tokens = slug.split('-');
  const out = [];
  for (const token of tokens) {
    // The move list starts at the first move number, which chess.com sometimes
    // glues straight onto the last word of the name ("Variation...4.Nxd4").
    const cut = token.search(/\.{2,}\d|\b\d+\./);
    if (cut === 0) break;
    if (cut > 0) {
      out.push(token.slice(0, cut).replace(/\.+$/, ''));
      break;
    }
    out.push(token);
  }
  return out.join(' ').replace(/\s+/g, ' ').trim() || null;
}

function headerValue(pgn, tag) {
  if (!pgn) return null;
  const m = pgn.match(new RegExp('\\[' + tag + '\\s+"([^"]*)"\\]'));
  return m ? m[1] : null;
}

/* ------------------------------------------------------------ PGN import -- */

/**
 * Split pasted text into individual games. Chess.com's "Download" gives one
 * game; "Download all games" gives many, back to back.
 */
export function splitPgnGames(text) {
  const trimmed = (text || '').trim();
  if (!trimmed) return [];
  // A new game starts at an [Event ...] tag that begins a line.
  const parts = trimmed.split(/\n(?=\s*\[Event\s)/);
  return parts.map((p) => p.trim()).filter((p) => /[a-hKQRBNO0-9]/.test(p));
}

/** Chess.com writes "Hikaru won by resignation" / "Game drawn by stalemate". */
function terminationFromHeader(value, result) {
  if (!value) return result === '1/2-1/2' ? 'a draw' : 'decisive';
  const drawn = value.match(/drawn\s+by\s+(.+)$/i);
  if (drawn) return 'by ' + drawn[1].trim();
  const won = value.match(/\bwon\s+(.+)$/i);
  if (won) return won[1].trim();
  return value;
}

/** Guess the time class the way Chess.com labels it, from the base time. */
function timeClassFromControl(tc) {
  if (!tc || tc === '-') return 'unknown';
  if (/^1\/\d+$/.test(tc)) return 'daily';
  const base = Number(String(tc).split('+')[0]);
  if (!Number.isFinite(base)) return 'unknown';
  if (base < 180) return 'bullet';
  if (base < 600) return 'blitz';
  if (base <= 1800) return 'rapid';
  return 'daily';
}

/**
 * Build the same game shape `normaliseGame` produces, but from a raw PGN.
 * Everything is optional - a bare move list still yields a reviewable game.
 */
export function gameFromPgn(pgn, index) {
  const tag = (name) => headerValue(pgn, name);
  const num = (value) => {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : null;
  };

  const result = tag('Result') || '*';
  const timeControl = tag('TimeControl');
  const ecoUrl = tag('ECOUrl');

  let endTime = null;
  const date = tag('UTCDate') || tag('Date');
  if (date && /^\d{4}\.\d{2}\.\d{2}$/.test(date)) {
    const time = tag('UTCTime') || tag('StartTime') || '00:00:00';
    const parsed = new Date(date.replace(/\./g, '-') + 'T' + time + 'Z');
    if (!isNaN(parsed.getTime())) endTime = parsed;
  }

  return {
    id: 'pgn-' + (index || 0),
    url: tag('Link') || null,
    uuid: null,
    pgn: pgn,
    rated: null, // PGN carries no rated flag; the UI omits the field rather than guessing
    timeClass: timeClassFromControl(timeControl),
    timeControl: timeControl,
    endTime: endTime,
    rules: (tag('Variant') || 'chess').toLowerCase().indexOf('960') !== -1 ? 'chess960' : 'chess',
    white: { username: tag('White') || 'White', rating: num(tag('WhiteElo')), result: null, avatar: null },
    black: { username: tag('Black') || 'Black', rating: num(tag('BlackElo')), result: null, avatar: null },
    result: ['1-0', '0-1', '1/2-1/2'].indexOf(result) !== -1 ? result : '*',
    termination: terminationFromHeader(tag('Termination'), result),
    eco: tag('ECO'),
    ecoUrl: ecoUrl && ecoUrl.indexOf('/openings/') !== -1 ? ecoUrl : null,
    opening: openingFromEcoUrl(ecoUrl) || tag('Opening') || null,
    accuracies: null,
    fromPgn: true
  };
}

export function normaliseGame(raw) {
  const white = raw.white || {};
  const black = raw.black || {};

  let result = '1/2-1/2';
  if (white.result === 'win') result = '1-0';
  else if (black.result === 'win') result = '0-1';
  else if (!DRAW_RESULTS.has(white.result)) result = white.result === 'lose' ? '0-1' : '1/2-1/2';

  const loserResult = white.result === 'win' ? black.result : white.result;
  const termination =
    result === '1/2-1/2'
      ? TERMINATION_TEXT[white.result] || 'a draw'
      : TERMINATION_TEXT[loserResult] || 'decisive';

  const ecoUrl = raw.eco || headerValue(raw.pgn, 'ECOUrl');

  return {
    id: String(raw.url || raw.uuid || Math.random()),
    url: raw.url,
    uuid: raw.uuid,
    pgn: raw.pgn,
    rated: !!raw.rated,
    timeClass: raw.time_class || 'unknown',
    timeControl: raw.time_control || headerValue(raw.pgn, 'TimeControl'),
    endTime: raw.end_time ? new Date(raw.end_time * 1000) : null,
    rules: raw.rules || 'chess',
    white: { username: white.username || '?', rating: white.rating || null, result: white.result, avatar: white['@id'] },
    black: { username: black.username || '?', rating: black.rating || null, result: black.result, avatar: black['@id'] },
    result: result,
    termination: termination,
    eco: headerValue(raw.pgn, 'ECO'),
    ecoUrl: typeof ecoUrl === 'string' && ecoUrl.indexOf('/openings/') !== -1 ? ecoUrl : null,
    opening: openingFromEcoUrl(typeof ecoUrl === 'string' ? ecoUrl : null),
    accuracies: raw.accuracies || null
  };
}
