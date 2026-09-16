/**
 * UI wiring: routing, the player/games page, and the review page.
 */

import * as api from './api.js';
import { Board, loadPieceSprite } from './board.js';
import { Engine } from './engine.js';
import { analyseGame, LABELS } from './analysis.js';
import { buildReview, explainMove, formatCp, formatSeconds, advantagePhrase, whiteExpectedScore } from './insights.js';
import { Chess } from './chessutils.js';
import { estimateRating, ratingTooltip, unavailableReason } from './rating.js';
import { coachMove } from './coach.js';
import { STATIC_HOST } from './config.js';
import { LiveAnalysis, numberedLine } from './live.js';

const view = document.getElementById('view');
const engineBadge = document.getElementById('engine-badge');

const engine = new Engine();

const state = {
  username: null,
  player: null,
  stats: null,
  archives: [],
  month: null,
  games: [],
  game: null,
  analysis: null,
  perspective: 'w',
  cursor: -1,
  board: null,
  startFen: null,
  history: [],
  pgnSource: null,
  coachOpen: false,
  // A variation the user is trying out from the current game position: the moves
  // played so far and which of them is on the board (-1 = the game position).
  line: null,
  // Live engine lines for whatever position is on the board.
  live: null,
  liveResult: null
};

const LIVE_PREF_KEY = 'chess-review-live';

function livePreferred() {
  try {
    return localStorage.getItem(LIVE_PREF_KEY) !== 'off';
  } catch (e) {
    return true;
  }
}

/* ------------------------------------------------------------- routing -- */

function parseHash() {
  const raw = location.hash.replace(/^#\/?/, '');
  if (!raw) return { name: 'home' };
  const parts = raw.split('/').filter(Boolean);
  if (parts[0] === 'u' && parts[1]) {
    if (parts.length >= 6 && parts[2] === 'g') {
      return { name: 'game', username: decodeURIComponent(parts[1]), year: parts[3], month: parts[4], index: Number(parts[5]) };
    }
    return { name: 'player', username: decodeURIComponent(parts[1]), year: parts[2], month: parts[3] };
  }
  if (parts[0] === 'pgn') {
    return parts[1] !== undefined ? { name: 'pgnGame', index: Number(parts[1]) } : { name: 'pgnList' };
  }
  return { name: 'home' };
}

/* Pasted PGNs live in sessionStorage so a reload keeps the game on screen. */
const PGN_STORE = 'chess-review-pgn';

function storePgnGames(pgns) {
  try {
    sessionStorage.setItem(PGN_STORE, JSON.stringify(pgns));
  } catch (e) {
    /* private mode or over quota - the in-memory copy still works this session */
  }
  state.pgnSource = pgns;
}

function loadPgnGames() {
  if (state.pgnSource && state.pgnSource.length) return state.pgnSource;
  try {
    const raw = sessionStorage.getItem(PGN_STORE);
    state.pgnSource = raw ? JSON.parse(raw) : [];
  } catch (e) {
    state.pgnSource = [];
  }
  return state.pgnSource;
}

async function route() {
  const r = parseHash();
  document.getElementById('search-input').value = r.username || '';
  if (state.live) {
    // Whatever page comes next, the engine should not keep thinking about the last one.
    state.live.set(null);
    state.line = null;
  }
  try {
    if (r.name === 'home') return renderHome();
    if (r.name === 'player') return await renderPlayer(r.username, r.year, r.month);
    if (r.name === 'game') return await renderGamePage(r.username, r.year, r.month, r.index);
    if (r.name === 'pgnList') return renderPgnList();
    if (r.name === 'pgnGame') return renderPgnGame(r.index);
  } catch (err) {
    showError(err);
  }
}

function showError(err) {
  view.innerHTML = '';
  const box = document.createElement('div');
  box.className = 'error-box';
  box.textContent =
    err && err.code === 404
      ? 'No Chess.com player with that username.'
      : 'Something went wrong: ' + (err && err.message ? err.message : String(err));
  view.appendChild(box);
}

function template(id) {
  return document.getElementById(id).content.cloneNode(true);
}

function loading(message) {
  view.innerHTML = '';
  const el = document.createElement('div');
  el.className = 'loading';
  el.innerHTML = '<span class="spinner"></span><span></span>';
  el.lastElementChild.textContent = message;
  view.appendChild(el);
}

/* ---------------------------------------------------------------- home -- */

function renderHome() {
  view.innerHTML = '';
  const frag = template('tpl-home');
  const form = frag.getElementById('home-search');
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const value = form.querySelector('input').value.trim();
    if (value) location.hash = '#/u/' + encodeURIComponent(value);
  });
  for (const chip of frag.querySelectorAll('.chip')) {
    chip.addEventListener('click', () => {
      location.hash = '#/u/' + encodeURIComponent(chip.dataset.user);
    });
  }

  const pgnButton = frag.getElementById('pgn-go');
  const pgnInput = frag.getElementById('pgn-input');
  const pgnError = frag.getElementById('pgn-error');
  pgnButton.addEventListener('click', () => {
    pgnError.textContent = '';
    const games = api.splitPgnGames(pgnInput.value);
    if (!games.length) {
      pgnError.textContent = 'That does not look like a PGN.';
      return;
    }
    // Reject it here rather than failing later inside the analyser.
    const playable = games.filter(isPlayablePgn);
    if (!playable.length) {
      pgnError.textContent = 'No legal moves found in that PGN.';
      return;
    }
    storePgnGames(playable);
    location.hash = playable.length === 1 ? '#/pgn/0' : '#/pgn';
  });

  view.appendChild(frag);
}

function isPlayablePgn(pgn) {
  try {
    const chess = new Chess();
    chess.loadPgn(pgn);
    return chess.history().length > 0;
  } catch (e) {
    return false;
  }
}

/* ---------------------------------------------------------- board theme -- */

const BOARD_THEMES = [
  { id: 'slate', name: 'Slate' },
  { id: 'walnut', name: 'Walnut' },
  { id: 'forest', name: 'Forest' },
  { id: 'dusk', name: 'Dusk' }
];
const THEME_STORE = 'chess-review-board';

function currentBoardTheme() {
  try {
    const saved = localStorage.getItem(THEME_STORE);
    if (saved && BOARD_THEMES.some((t) => t.id === saved)) return saved;
  } catch (e) {
    /* storage blocked - fall through to the default */
  }
  return BOARD_THEMES[0].id;
}

function applyBoardTheme(id) {
  document.documentElement.dataset.board = id;
  try {
    localStorage.setItem(THEME_STORE, id);
  } catch (e) {
    /* not worth failing over */
  }
}

function renderBoardThemePicker(root) {
  root.innerHTML = '';
  const active = currentBoardTheme();
  for (const theme of BOARD_THEMES) {
    const swatch = document.createElement('button');
    swatch.type = 'button';
    swatch.className = 'swatch' + (theme.id === active ? ' on' : '');
    swatch.dataset.theme = theme.id;
    swatch.title = theme.name + ' board';
    swatch.setAttribute('aria-label', theme.name + ' board');
    swatch.innerHTML = '<span></span><span></span>';
    swatch.addEventListener('click', () => {
      applyBoardTheme(theme.id);
      renderBoardThemePicker(root);
    });
    root.appendChild(swatch);
  }
}

/* ------------------------------------------------------ captured pieces -- */

const PIECE_ORDER = ['q', 'r', 'b', 'n', 'p'];
const PIECE_WORTH = { q: 9, r: 5, b: 3, n: 3, p: 1 };
const FULL_ARMY = { q: 1, r: 2, b: 2, n: 2, p: 8 };

/**
 * What `color` has captured, worked out from what is missing from the opponent's
 * starting army, plus the material balance in pawns.
 */
function capturedBy(fen, color) {
  const board = fen.split(' ')[0];
  const enemyIsWhite = color === 'b';
  const counts = { q: 0, r: 0, b: 0, n: 0, p: 0 };

  for (const ch of board) {
    const lower = ch.toLowerCase();
    if (!(lower in counts)) continue;
    const chIsWhite = ch === ch.toUpperCase();
    if (chIsWhite === enemyIsWhite) counts[lower]++;
  }

  const taken = [];
  let value = 0;
  for (const type of PIECE_ORDER) {
    // Promotions can leave more pieces on the board than the army started with.
    const missing = Math.max(0, FULL_ARMY[type] - counts[type]);
    for (let i = 0; i < missing; i++) taken.push(type);
    value += missing * PIECE_WORTH[type];
  }
  return { taken: taken, value: value };
}

function renderCaptured(root, fen, color) {
  const mine = capturedBy(fen, color);
  const theirs = capturedBy(fen, color === 'w' ? 'b' : 'w');
  root.innerHTML = '';
  if (!mine.taken.length && mine.value - theirs.value <= 0) return;

  for (const type of mine.taken) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'cap-piece');
    svg.setAttribute('viewBox', '0 0 40 40');
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', '#' + (color === 'w' ? 'b' : 'w') + type);
    svg.appendChild(use);
    root.appendChild(svg);
  }

  const lead = mine.value - theirs.value;
  if (lead > 0) {
    const badge = document.createElement('span');
    badge.className = 'cap-lead';
    badge.textContent = '+' + lead;
    root.appendChild(badge);
  }
}

/* ------------------------------------------------------------ pasted PGNs -- */

function renderPgnList() {
  const pgns = loadPgnGames();
  if (!pgns.length) return renderHome();

  state.username = null;
  state.month = null;
  state.games = pgns.map((pgn, i) => api.gameFromPgn(pgn, i));

  view.innerHTML = '';
  view.appendChild(template('tpl-pgn-list'));
  renderGamesList();
}

function renderPgnGame(index) {
  const pgns = loadPgnGames();
  if (!pgns.length) return renderHome();

  state.username = null;
  state.month = null;
  state.games = pgns.map((pgn, i) => api.gameFromPgn(pgn, i));

  const game = state.games[index];
  if (!game) throw new Error('That pasted game is no longer available.');
  openGame(game, pgns.length > 1 ? '#/pgn' : '#/');
}

/* -------------------------------------------------------- player page -- */

async function renderPlayer(username, year, month) {
  loading('Loading ' + username + '…');

  const [player, stats, archives] = await Promise.all([
    api.getPlayer(username),
    api.getStats(username).catch(() => null),
    api.getArchives(username)
  ]);

  state.username = player.username || username;
  state.player = player;
  state.stats = stats;
  state.archives = archives;

  view.innerHTML = '';
  const frag = template('tpl-player');
  view.appendChild(frag);

  renderProfile(document.getElementById('profile'), player, stats);

  const monthSelect = document.getElementById('month-select');
  if (!archives.length) {
    document.getElementById('games-list').innerHTML = '<div class="empty">This account has no public game archives.</div>';
    return;
  }

  monthSelect.innerHTML = '';
  for (const a of archives) {
    const opt = document.createElement('option');
    opt.value = a.year + '/' + a.month;
    opt.textContent = monthName(a.year, a.month);
    monthSelect.appendChild(opt);
  }

  const wanted = year && month ? year + '/' + month : archives[0].year + '/' + archives[0].month;
  monthSelect.value = archives.some((a) => a.year + '/' + a.month === wanted) ? wanted : monthSelect.options[0].value;

  monthSelect.addEventListener('change', () => {
    const [y, m] = monthSelect.value.split('/');
    location.hash = '#/u/' + encodeURIComponent(state.username) + '/' + y + '/' + m;
  });
  document.getElementById('class-filter').addEventListener('change', renderGamesList);
  document.getElementById('result-filter').addEventListener('change', renderGamesList);

  await loadMonth(monthSelect.value);
}

function monthName(year, month) {
  const d = new Date(Number(year), Number(month) - 1, 1);
  return d.toLocaleString(undefined, { month: 'long', year: 'numeric' });
}

function renderProfile(root, player, stats) {
  root.innerHTML = '';

  if (player.avatar) {
    const img = document.createElement('img');
    // Avatars are served with a restrictive CORP header; a CORS request gets past it.
    if (STATIC_HOST) img.crossOrigin = 'anonymous';
    img.src = api.proxiedImage(player.avatar);
    img.alt = '';
    root.appendChild(img);
  }

  const name = document.createElement('div');
  name.className = 'name';
  if (player.title) {
    const tag = document.createElement('span');
    tag.className = 'title-tag';
    tag.textContent = player.title;
    name.appendChild(tag);
  }
  name.appendChild(document.createTextNode(player.name || player.username));
  root.appendChild(name);

  const handle = document.createElement('div');
  handle.className = 'handle';
  handle.textContent = '@' + player.username + (player.country ? ' · ' + player.country.split('/').pop() : '');
  root.appendChild(handle);

  if (stats) {
    const grid = document.createElement('div');
    grid.className = 'rating-grid';
    const entries = [
      ['Bullet', stats.chess_bullet],
      ['Blitz', stats.chess_blitz],
      ['Rapid', stats.chess_rapid],
      ['Daily', stats.chess_daily]
    ];
    for (const [label, data] of entries) {
      if (!data || !data.last) continue;
      const cell = document.createElement('div');
      cell.innerHTML = '<div class="label"></div><div class="value"></div>';
      cell.querySelector('.label').textContent = label;
      cell.querySelector('.value').textContent = data.last.rating;
      grid.appendChild(cell);
    }
    if (grid.children.length) root.appendChild(grid);
  }
}

async function loadMonth(value) {
  const [year, month] = value.split('/');
  state.month = { year: year, month: month };
  const list = document.getElementById('games-list');
  list.innerHTML = '<div class="loading"><span class="spinner"></span><span>Loading games…</span></div>';
  state.games = await api.getMonthGames(state.username, year, month);
  renderGamesList();
}

/** Win/loss/draw from the searched player's side. Null when there is no such player. */
function outcomeFor(game, username) {
  if (!username) return null;
  const me = game.white.username.toLowerCase() === username.toLowerCase() ? game.white : game.black;
  if (me.result === 'win') return 'win';
  if (['agreed', 'repetition', 'stalemate', 'insufficient', 'timevsinsufficient', '50move'].indexOf(me.result) !== -1) return 'draw';
  return 'loss';
}

const CLASS_ICON = { bullet: '⚡', blitz: '🔥', rapid: '⏱', daily: '📅' };

function playerLabel(player, isSearchedUser) {
  const span = document.createElement('span');
  if (isSearchedUser) span.className = 'you';
  span.textContent = player.username + (player.rating ? ' (' + player.rating + ')' : '');
  return span;
}

function renderGamesList() {
  const list = document.getElementById('games-list');
  // The pasted-PGN list has no filter controls.
  const classSelect = document.getElementById('class-filter');
  const resultSelect = document.getElementById('result-filter');
  const classFilter = classSelect ? classSelect.value : '';
  const resultFilter = resultSelect ? resultSelect.value : '';

  const rows = state.games
    .map((g, index) => ({ g: g, index: index }))
    .filter((x) => x.g.rules === 'chess' && x.g.pgn)
    .filter((x) => !classFilter || x.g.timeClass === classFilter)
    .filter((x) => !resultFilter || !state.username || outcomeFor(x.g, state.username) === resultFilter);

  list.innerHTML = '';
  if (!rows.length) {
    list.innerHTML =
      '<div class="empty">' +
      (state.month ? 'No games match these filters for ' + monthName(state.month.year, state.month.month) + '.' : 'No reviewable games found.') +
      '</div>';
    return;
  }

  for (const { g, index } of rows) {
    const outcome = outcomeFor(g, state.username);
    const row = document.createElement('button');
    row.className = 'game-row';
    row.type = 'button';

    const icon = document.createElement('div');
    icon.className = 'icon';
    icon.textContent = CLASS_ICON[g.timeClass] || '♟';

    const meIsWhite = !!state.username && g.white.username.toLowerCase() === state.username.toLowerCase();
    const players = document.createElement('div');
    players.className = 'players';

    const line = document.createElement('div');
    line.appendChild(playerLabel(g.white, meIsWhite));
    line.appendChild(document.createTextNode(' '));
    const vs = document.createElement('span');
    vs.className = 'muted';
    vs.textContent = 'vs';
    line.appendChild(vs);
    line.appendChild(document.createTextNode(' '));
    line.appendChild(playerLabel(g.black, !meIsWhite));
    players.appendChild(line);

    const sub = document.createElement('div');
    sub.className = 'sub';
    sub.textContent = [g.timeClass, api.formatTimeControl(g.timeControl), g.opening || g.eco, g.termination]
      .filter(Boolean)
      .join(' · ');
    players.appendChild(sub);

    const result = document.createElement('div');
    if (state.username) {
      result.className = 'outcome ' + outcome;
      result.textContent = outcome === 'win' ? 'Win' : outcome === 'loss' ? 'Loss' : 'Draw';
    } else {
      // No searched player, so there is no "you" to win or lose - show the score.
      result.className = 'outcome draw';
      result.textContent = g.result === '1/2-1/2' ? '½–½' : g.result;
    }

    const when = document.createElement('div');
    when.className = 'when';
    when.textContent = g.endTime ? g.endTime.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '';

    row.append(icon, players, result, when);
    row.addEventListener('click', () => {
      location.hash = state.username
        ? '#/u/' + encodeURIComponent(state.username) + '/g/' + state.month.year + '/' + state.month.month + '/' + index
        : '#/pgn/' + index;
    });
    list.appendChild(row);
  }
}

/* ---------------------------------------------------------- game page -- */

async function renderGamePage(username, year, month, index) {
  if (state.username !== username || !state.games.length || !state.month || state.month.year !== year || state.month.month !== month) {
    loading('Loading game…');
    state.username = username;
    state.month = { year: year, month: month };
    state.games = await api.getMonthGames(username, year, month);
  }

  const game = state.games[index];
  if (!game) throw new Error('That game is no longer in this archive.');

  openGame(game, '#/u/' + encodeURIComponent(username) + '/' + year + '/' + month);
}

/**
 * Render the review page for one game, whichever route we arrived by.
 * `backHref` is where the "back" link points.
 */
function openGame(game, backHref) {
  state.game = game;
  state.analysis = null;
  state.cursor = -1;
  // Review the searched player by default; with a pasted PGN there is no
  // "you", so start from White and let the toggle switch sides.
  state.perspective =
    state.username && game.black.username.toLowerCase() === state.username.toLowerCase() ? 'b' : 'w';

  const chess = new Chess();
  chess.loadPgn(game.pgn);
  state.history = chess.history({ verbose: true });
  state.startFen = state.history.length ? state.history[0].before : chess.fen();

  view.innerHTML = '';
  view.appendChild(template('tpl-review'));

  const back = document.getElementById('back-link');
  back.href = backHref;
  back.textContent = state.username ? '← Back to games' : '← Back';

  state.board = new Board(document.getElementById('board'));
  state.board.setOrientation(state.perspective);
  applyBoardTheme(currentBoardTheme());
  renderBoardThemePicker(document.getElementById('board-themes'));
  state.board.enableMoves({ dests: legalDestinations, onMove: playUserMove });

  state.line = null;
  state.liveResult = null;
  if (!state.live) state.live = new LiveAnalysis(engine, onLiveUpdate);
  state.live.setEnabled(livePreferred());
  renderEnginePanel();

  renderGameHead();
  renderMoveList();
  renderPlayerStrips();
  goTo(state.history.length - 1, { instant: true }); // opening a game should not replay the last move

  document.getElementById('btn-first').onclick = () => goTo(-1);
  document.getElementById('btn-prev').onclick = stepBack;
  document.getElementById('btn-next').onclick = stepForward;
  document.getElementById('btn-last').onclick = () => goTo(state.history.length - 1);
  document.getElementById('btn-flip').onclick = () => {
    state.board.flip();
    renderPlayerStrips();
  };
  document.getElementById('btn-analyse').onclick = runAnalysis;
}

function renderGameHead() {
  const g = state.game;
  const head = document.getElementById('game-head');
  head.innerHTML = '<div class="title"></div><div class="meta"></div><div class="opening"></div>';
  head.querySelector('.title').textContent =
    g.white.username + ' vs ' + g.black.username + '  ' + g.result;
  head.querySelector('.meta').textContent = [
    g.rated === null || g.rated === undefined ? null : g.rated ? 'Rated' : 'Unrated',
    g.timeClass === 'unknown' ? null : g.timeClass,
    api.formatTimeControl(g.timeControl),
    g.endTime ? g.endTime.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : null,
    (g.result === '1/2-1/2' ? 'Drawn — ' : (g.result === '1-0' ? g.white.username : g.black.username) + ' won ') + g.termination
  ]
    .filter(Boolean)
    .join(' · ');

  const opening = head.querySelector('.opening');
  if (g.opening) {
    opening.textContent = (g.eco ? g.eco + ' · ' : '') + g.opening + ' ';
    if (g.ecoUrl) {
      const a = document.createElement('a');
      a.href = g.ecoUrl;
      a.target = '_blank';
      a.rel = 'noreferrer';
      a.textContent = 'theory ↗';
      opening.appendChild(a);
    }
  } else {
    opening.remove();
  }
}

function renderPlayerStrips() {
  const g = state.game;
  const topColor = state.board.flipped ? 'w' : 'b';
  fillStrip(document.getElementById('strip-top'), topColor === 'w' ? g.white : g.black, topColor);
  fillStrip(document.getElementById('strip-bottom'), topColor === 'w' ? g.black : g.white, topColor === 'w' ? 'b' : 'w');
}

function fillStrip(root, player, color) {
  root.innerHTML =
    '<span class="dot ' + color + '"></span><span class="who"></span><span class="elo"></span>' +
    '<span class="captured"></span><span class="acc"></span>';
  root.querySelector('.who').textContent = player.username;
  root.querySelector('.elo').textContent = player.rating ? player.rating : '';

  // What this player has taken off the board, at the position on screen.
  renderCaptured(root.querySelector('.captured'), displayedFen(), color);

  const acc = root.querySelector('.acc');
  if (state.analysis) {
    const value = state.analysis.stats[color].accuracy;
    acc.innerHTML = 'Accuracy <b></b>';
    acc.querySelector('b').textContent = value === null ? '—' : value.toFixed(1) + '%';

    // Repeat the rating estimate right beside the board, where the eye already is.
    const estimate = estimateRating({
      accuracy: value,
      timeClass: state.game.timeClass,
      moveCount: state.analysis.stats[color].moveCount
    });
    if (estimate && estimate.available) {
      const chip = document.createElement('span');
      chip.className = 'strip-rating';
      chip.innerHTML = 'played like <b></b>';
      chip.querySelector('b').textContent = '~' + estimate.rating;
      chip.title = ratingTooltip(estimate, state.game.timeClass);
      acc.appendChild(chip);
    }
  } else {
    const clockMove = clockAt(color);
    if (clockMove !== null) {
      const span = document.createElement('span');
      span.className = 'clock';
      span.textContent = formatClock(clockMove);
      acc.appendChild(span);
    }
  }
}

function clockAt(color) {
  if (!state.analysis) return null;
  for (let i = state.cursor; i >= 0; i--) {
    const m = state.analysis.moves[i];
    if (m.color === color && m.clock !== null) return m.clock;
  }
  return null;
}

function formatClock(seconds) {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return m + ':' + String(s).padStart(2, '0');
}

/* ------------------------------------------------------- move display -- */

/** The position on the board right now: the variation being tried, or the game. */
function displayedFen() {
  if (state.line) return state.line.index >= 0 ? state.line.moves[state.line.index].fen : baseFenOfLine();
  return state.cursor >= 0 ? state.history[state.cursor].after : state.startFen;
}

/** The game position the current variation branched from. */
function baseFenOfLine() {
  const base = state.line ? state.line.baseCursor : state.cursor;
  return base >= 0 ? state.history[base].after : state.startFen;
}

/** Where the piece on `square` may legally go in the displayed position. */
function legalDestinations(square) {
  const chess = new Chess(displayedFen());
  return chess.moves({ square: square, verbose: true }).map((m) => m.to);
}

function goTo(index, opts0) {
  const settings = opts0 || {};
  const previous = state.cursor;
  const max = state.history.length - 1;
  state.cursor = Math.max(-1, Math.min(max, index));
  const wasExploring = !!state.line;
  cancelAutoplay();
  state.line = null;

  const move = state.cursor >= 0 ? state.history[state.cursor] : null;
  const fen = move ? move.after : state.startFen;
  const animate = !settings.instant && state.cursor !== previous;

  // Jumping more than a step - from a review link, the graph, or a distant move in
  // the list - would otherwise just snap. Put the position from *before* the target
  // move up first, so what you see is that move being played. Both renders happen in
  // one task, so the intermediate position is never painted.
  if (animate && move && previous !== state.cursor - 1) {
    state.board.setPosition(move.before, { animate: false });
  }

  const board = new Chess(fen);
  const opts = { lastMove: move ? { from: move.from, to: move.to } : null };
  if (board.isCheck()) {
    const kingColor = board.turn();
    for (const row of board.board()) {
      for (const sq of row) {
        if (sq && sq.type === 'k' && sq.color === kingColor) opts.check = sq.square;
      }
    }
  }

  // Show the engine's preferred move as an arrow whenever the played move wasn't it,
  // and the move's label on the square it landed on.
  const analysed = state.analysis && state.cursor >= 0 ? state.analysis.moves[state.cursor] : null;
  if (analysed && !analysed.isBest && analysed.bestUci) {
    opts.arrow = { from: analysed.bestUci.slice(0, 2), to: analysed.bestUci.slice(2, 4), kind: 'best' };
  }
  if (analysed) {
    opts.badge = { square: move.to, key: analysed.label.key, symbol: analysed.label.symbol, title: analysed.label.text };
  }

  opts.animate = animate || wasExploring;
  state.board.setPosition(fen, opts);
  state.liveResult = null;
  if (state.live) state.live.set(fen);
  updateEvalBar(analysed);
  updateMoveNote(analysed);
  renderVariationBar();
  highlightCurrentMove();
  renderPlayerStrips();
}

/* ----------------------------------------------------------- variations -- */

/** The user moved a piece: branch off the displayed position and follow it. */
function playUserMove(from, to) {
  const chess = new Chess(displayedFen());
  let made = null;
  try {
    // Promotion always makes a queen; the other choices are rare enough in
    // analysis that a picker would be more in the way than useful.
    made = chess.move({ from: from, to: to, promotion: 'q' });
  } catch (e) {
    made = null;
  }
  if (!made) return;

  cancelAutoplay();
  if (!state.line) state.line = { baseCursor: state.cursor, moves: [], index: -1 };
  // Playing from the middle of a variation discards what came after.
  state.line.moves = state.line.moves.slice(0, state.line.index + 1);
  state.line.moves.push({ san: made.san, from: made.from, to: made.to, fen: chess.fen() });
  state.line.index = state.line.moves.length - 1;
  showVariation({ animate: true });
}

/** Put a variation move (or the base position, index -1) on the board. */
function showVariation(opts0) {
  const settings = opts0 || {};
  const line = state.line;
  if (!line) return;
  const step = line.index >= 0 ? line.moves[line.index] : null;
  const fen = displayedFen();

  const chess = new Chess(fen);
  const opts = { lastMove: step ? { from: step.from, to: step.to } : null, animate: settings.animate !== false };
  if (chess.isCheck()) {
    const kingColor = chess.turn();
    for (const row of chess.board()) {
      for (const sq of row) {
        if (sq && sq.type === 'k' && sq.color === kingColor) opts.check = sq.square;
      }
    }
  }
  state.board.setPosition(fen, opts);
  state.liveResult = null;
  if (state.live) state.live.set(fen);
  updateEvalBar(null);
  updateVariationNote();
  renderVariationBar();
  renderPlayerStrips();
}

/** Play the first `count` moves of an engine line as a variation. */
function playEngineLine(fromFen, sans, count) {
  // The panel may still show lines for the previous position for a moment.
  if (fromFen !== displayedFen()) return;
  const chess = new Chess(fromFen);
  const steps = [];
  for (let i = 0; i < count && i < sans.length; i++) {
    let made = null;
    try {
      made = chess.move(sans[i]);
    } catch (e) {
      made = null;
    }
    if (!made) break;
    steps.push({ san: made.san, from: made.from, to: made.to, fen: chess.fen() });
  }
  if (!steps.length) return;
  cancelAutoplay();
  if (!state.line) state.line = { baseCursor: state.cursor, moves: [], index: -1 };
  state.line.moves = state.line.moves.slice(0, state.line.index + 1).concat(steps);
  state.line.index = state.line.moves.length - 1;
  showVariation({ animate: true });
}

/** Back to the game position this variation branched from. */
function leaveVariation() {
  if (!state.line) return;
  goTo(state.cursor);
}

function stepBack() {
  if (state.line) {
    cancelAutoplay();
    if (state.line.index < 0) return leaveVariation();
    state.line.index--;
    showVariation();
    return;
  }
  goTo(state.cursor - 1);
}

function stepForward() {
  if (state.line) {
    cancelAutoplay();
    if (state.line.index >= state.line.moves.length - 1) return;
    state.line.index++;
    showVariation();
    return;
  }
  goTo(state.cursor + 1);
}

/** The strip under the board listing the variation's moves, with a way home. */
function renderVariationBar() {
  const bar = document.getElementById('variation-bar');
  if (!bar) return;
  const line = state.line;
  if (!line) {
    bar.classList.add('hidden');
    bar.innerHTML = '';
    return;
  }
  bar.classList.remove('hidden');
  bar.innerHTML = '<span class="variation-tag">Variation</span><span class="variation-moves"></span>' +
    '<button type="button" class="variation-back" id="btn-leave-variation">↩ Back to game</button>';

  const parts = baseFenOfLine().split(' ');
  let moveNumber = Number(parts[5]) || 1;
  let white = parts[1] !== 'b';
  const holder = bar.querySelector('.variation-moves');
  line.moves.forEach((step, i) => {
    if (white || i === 0) {
      const num = document.createElement('span');
      num.className = 'num';
      num.textContent = moveNumber + (white ? '.' : '...');
      holder.appendChild(num);
    }
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'variation-move' + (i === line.index ? ' current' : '');
    btn.textContent = step.san;
    btn.addEventListener('click', () => {
      cancelAutoplay();
      state.line.index = i;
      showVariation();
    });
    holder.appendChild(btn);
    if (!white) moveNumber++;
    white = !white;
  });
  document.getElementById('btn-leave-variation').addEventListener('click', leaveVariation);
}

/** The commentary card while exploring: the live verdict on the position. */
function updateVariationNote() {
  const note = document.getElementById('move-note');
  const line = state.line;
  if (!line) return;
  const step = line.index >= 0 ? line.moves[line.index] : null;
  note.innerHTML = '<div class="note-head"><span class="note-move"></span><span class="muted note-label">Your variation</span></div>' +
    '<div class="note-text muted"></div>';
  note.querySelector('.note-move').textContent = step ? numberedLine(line.index > 0 ? line.moves[line.index - 1].fen : baseFenOfLine(), [step.san]) : 'Game position';
  const result = state.liveResult;
  const text = note.querySelector('.note-text');
  if (result && result.terminal) {
    text.textContent = result.terminal === 'checkmate' ? 'Checkmate.' : 'The game is over — a draw.';
  } else if (result && result.lines.length) {
    const best = result.lines[0];
    text.textContent = 'The engine suggests ' + best.san[0] + ' here (depth ' + result.depth + '). Keep moving pieces to explore, or go back to the game.';
    note.querySelector('.note-head').appendChild(buildEvalReadout(best.whiteCp));
  } else {
    text.textContent = state.live && state.live.enabled ? 'Thinking…' : 'Engine lines are off — turn them on to see what the engine makes of this.';
  }
}

/* --------------------------------------------------------- engine lines -- */

function onLiveUpdate(result) {
  state.liveResult = result;
  renderEngineLines();
  if (state.line) {
    updateVariationNote();
    updateEvalBar(null);
    // In a variation the arrow follows the engine's current first choice.
    const best = result && result.lines.length ? result.lines[0].first : null;
    state.board.setArrow(best ? { from: best.from, to: best.to, kind: 'best' } : null);
  } else {
    const analysed = state.analysis && state.cursor >= 0 ? state.analysis.moves[state.cursor] : null;
    updateEvalBar(analysed);
    if (!state.analysis) {
      const best = result && result.lines.length ? result.lines[0].first : null;
      state.board.setArrow(best ? { from: best.from, to: best.to, kind: 'best' } : null);
    }
  }
}

function renderEnginePanel() {
  const card = document.getElementById('engine-card');
  if (!card) return;
  card.innerHTML =
    '<div class="engine-head"><h3>Engine lines</h3><span class="engine-depth muted" id="engine-depth"></span>' +
    '<label class="switch" title="Analyse the position on the board as you browse">' +
    '<input type="checkbox" id="live-toggle"><span></span></label></div>' +
    '<ol class="engine-lines" id="engine-lines"></ol>';
  const toggle = document.getElementById('live-toggle');
  toggle.checked = livePreferred();
  toggle.addEventListener('change', () => {
    try {
      localStorage.setItem(LIVE_PREF_KEY, toggle.checked ? 'on' : 'off');
    } catch (e) {
      /* preference just will not stick */
    }
    state.live.setEnabled(toggle.checked);
    renderEngineLines();
  });
  renderEngineLines();
}

function renderEngineLines() {
  const list = document.getElementById('engine-lines');
  const depthEl = document.getElementById('engine-depth');
  if (!list) return;
  list.innerHTML = '';
  const result = state.liveResult;
  const live = state.live;

  if (!live || !live.enabled) {
    depthEl.textContent = 'off';
    return;
  }
  if (live.paused) {
    depthEl.textContent = 'paused while the review runs';
    return;
  }
  if (result && result.terminal) {
    depthEl.textContent = '';
    list.innerHTML = '<li class="muted">' + (result.terminal === 'checkmate' ? 'Checkmate' : 'Game over — draw') + '</li>';
    return;
  }
  if (!result || !result.lines.length) {
    depthEl.textContent = 'thinking…';
    return;
  }
  depthEl.textContent = 'depth ' + result.depth;

  for (const line of result.lines) {
    const li = document.createElement('li');
    li.className = 'engine-line';

    const score = document.createElement('span');
    score.className = 'move-eval ' + (line.whiteCp > 30 ? 'white-ahead' : line.whiteCp < -30 ? 'black-ahead' : 'level');
    score.textContent = line.mate !== null ? (line.mate > 0 ? 'M' + line.mate : '-M' + Math.abs(line.mate)) : formatCp(line.whiteCp);
    li.appendChild(score);

    // Every move in the line is clickable: it plays the line that far.
    const moves = document.createElement('span');
    moves.className = 'engine-moves';
    const parts = result.fen.split(' ');
    let moveNumber = Number(parts[5]) || 1;
    let white = parts[1] !== 'b';
    line.san.slice(0, 10).forEach((san, i) => {
      if (white || i === 0) {
        const num = document.createElement('span');
        num.className = 'num';
        num.textContent = moveNumber + (white ? '.' : '...');
        moves.appendChild(num);
      }
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'engine-move';
      btn.textContent = san;
      btn.title = 'Play the line up to here';
      btn.addEventListener('click', () => playEngineLine(result.fen, line.san, i + 1));
      moves.appendChild(btn);
      if (!white) moveNumber++;
      white = !white;
    });
    li.appendChild(moves);
    list.appendChild(li);
  }
}

function updateEvalBar(move) {
  const bar = document.getElementById('evalbar');
  const fill = bar.querySelector('.evalbar-fill');
  const text = bar.querySelector('.evalbar-text');

  // The live search knows the position on the board, whatever it is; the review
  // only knows the game's own moves.
  const live = state.liveResult && state.liveResult.fen === displayedFen() ? state.liveResult : null;
  let whiteCp = null;
  if (live && live.terminal) {
    whiteCp = live.terminal === 'checkmate' ? (new Chess(live.fen).turn() === 'w' ? -10000 : 10000) : 0;
  } else if (live && live.lines.length) {
    whiteCp = live.lines[0].whiteCp;
  } else if (state.analysis && !state.line) {
    const source = move || state.analysis.moves[0];
    whiteCp = move
      ? (move.color === 'w' ? move.evalAfterCp : -move.evalAfterCp)
      : (source.color === 'w' ? source.evalBeforeCp : -source.evalBeforeCp);
  }

  if (whiteCp === null) {
    fill.style.height = '50%';
    text.textContent = '';
    bar.classList.remove('negative');
    return;
  }

  const clamped = Math.max(-1000, Math.min(1000, whiteCp));
  const percent = 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * clamped)) - 1);
  fill.style.height = percent + '%';
  text.textContent = formatCp(whiteCp);
  bar.classList.toggle('negative', whiteCp < 0);
}

/** Evaluation after `move`, converted to White's point of view. */
function whiteCpAfter(move) {
  return move.color === 'w' ? move.evalAfterCp : -move.evalAfterCp;
}

/** Evaluation of the starting position, from White's point of view. */
function whiteCpAtStart() {
  const first = state.analysis.moves[0];
  return first.color === 'w' ? first.evalBeforeCp : -first.evalBeforeCp;
}

/** The "who stands better" readout: number, plain English, and expected score. */
function buildEvalReadout(whiteCp) {
  const el = document.createElement('div');
  el.className = 'eval-readout ' + (whiteCp > 30 ? 'white-ahead' : whiteCp < -30 ? 'black-ahead' : 'level');

  const value = document.createElement('b');
  value.textContent = formatCp(whiteCp);
  el.appendChild(value);

  const phrase = document.createElement('span');
  const percent = whiteExpectedScore(whiteCp);
  phrase.textContent = advantagePhrase(whiteCp) + (percent === null ? '' : ' · White ' + percent + '%');
  el.appendChild(phrase);

  return el;
}

function updateMoveNote(move) {
  const note = document.getElementById('move-note');
  if (!state.analysis) {
    note.innerHTML = '<p class="muted">Run the review for move-by-move commentary. You can already move the pieces to try ideas — the engine lines follow the board.</p>';
    return;
  }

  if (!move) {
    note.innerHTML = '<p class="muted">Starting position. Use ← and → to step through the game.</p>';
    note.appendChild(buildEvalReadout(whiteCpAtStart()));
    return;
  }

  const explanation = explainMove(move);
  note.innerHTML =
    '<div class="note-head"><span class="sym ' + move.label.key + '"></span><span class="note-move"></span>' +
    '<span class="muted note-label"></span></div>' +
    '<div class="note-text"></div><div class="note-line"></div>';

  note.querySelector('.sym').textContent = move.label.symbol;
  note.querySelector('.note-move').textContent = move.moveNumber + (move.color === 'w' ? '.' : '...') + ' ' + move.san;
  note.querySelector('.note-label').textContent = move.label.text;
  note.querySelector('.note-text').textContent = explanation.text;
  note.querySelector('.note-head').appendChild(buildEvalReadout(whiteCpAfter(move)));

  // "Explain" opens the coaching breakdown, and stays open as you step through.
  const explain = document.createElement('button');
  explain.className = 'explain-btn';
  explain.type = 'button';
  explain.innerHTML = '<span class="explain-icon">💡</span> Explain this move';
  explain.addEventListener('click', () => {
    state.coachOpen = !state.coachOpen;
    updateMoveNote(move);
  });

  const panel = document.createElement('div');
  panel.className = 'coach-panel';
  if (state.coachOpen) {
    explain.classList.add('on');
    explain.innerHTML = '<span class="explain-icon">💡</span> Hide explanation';
    renderCoachPanel(panel, move);
  }

  note.appendChild(explain);
  note.appendChild(panel);

  const line = note.querySelector('.note-line');
  const bits = [];
  if (move.bestPvSan.length) bits.push('<b>Engine line:</b> ' + move.bestPvSan.join(' '));
  if (move.timeSpent !== null) bits.push('<b>Time:</b> ' + formatSeconds(move.timeSpent));
  line.innerHTML = bits.join(' &nbsp;·&nbsp; ');
}

function renderMoveList() {
  const list = document.getElementById('move-list');
  list.innerHTML = '';

  for (let i = 0; i < state.history.length; i++) {
    if (i % 2 === 0) {
      const num = document.createElement('li');
      num.className = 'num';
      num.textContent = i / 2 + 1 + '.';
      list.appendChild(num);
    }
    const li = document.createElement('li');
    li.className = 'move-item';
    li.dataset.ply = i;

    const analysed = state.analysis ? state.analysis.moves[i] : null;
    if (analysed) {
      const sym = document.createElement('span');
      sym.className = 'sym ' + analysed.label.key;
      sym.textContent = analysed.label.symbol;
      sym.title = analysed.label.text;
      li.appendChild(sym);
    }
    const san = document.createElement('span');
    san.textContent = state.history[i].san;
    li.appendChild(san);

    if (analysed) {
      // The evaluation after this move, always from White's side, so the sign
      // alone tells you who is ahead without re-reading whose turn it was.
      const whiteCp = whiteCpAfter(analysed);
      const evalTag = document.createElement('span');
      evalTag.className = 'move-eval ' + (whiteCp > 30 ? 'white-ahead' : whiteCp < -30 ? 'black-ahead' : 'level');
      evalTag.textContent = formatCp(whiteCp);
      evalTag.title = advantagePhrase(whiteCp);
      li.appendChild(evalTag);
    }

    li.addEventListener('click', () => goTo(i));
    list.appendChild(li);
  }
  highlightCurrentMove();
}

function highlightCurrentMove() {
  for (const el of document.querySelectorAll('.move-item')) {
    const on = Number(el.dataset.ply) === state.cursor;
    el.classList.toggle('current', on);
    if (on) el.scrollIntoView({ block: 'nearest' });
  }
}

/* ----------------------------------------------------------- coach panel -- */

function renderCoachPanel(root, move) {
  const lesson = coachMove(move, state.analysis);
  root.innerHTML = '';

  const headline = document.createElement('p');
  headline.className = 'coach-headline ' + move.label.key;
  headline.textContent = lesson.headline;
  root.appendChild(headline);

  for (const section of lesson.sections) {
    const block = document.createElement('div');
    block.className = 'coach-section';

    const title = document.createElement('h4');
    title.textContent = section.title;
    block.appendChild(title);

    const body = document.createElement('p');
    body.textContent = section.body;
    block.appendChild(body);

    if (section.variation) {
      const line = document.createElement('button');
      line.type = 'button';
      line.className = 'coach-line';
      line.textContent = section.variation;
      line.title = 'Play this line out on the board';
      line.addEventListener('click', () => playVariation(section.variationFrom, section.variation));
      block.appendChild(line);
    }
    root.appendChild(block);
  }
}

/**
 * Put a quoted line on the board as a variation and play it out move by move, so
 * it can be watched rather than read. It stays there afterwards: step through it,
 * play on from it, or go back to the game. The line starts from `fromFen`, which
 * for a "better was" line is the position *before* the move under review.
 */
function playVariation(fromFen, variation) {
  if (!fromFen || !variation) return;
  const sans = variation.replace(/\d+\.(\.\.)?/g, ' ').trim().split(/\s+/).filter(Boolean);

  // Which game position is this line branching from?
  let baseCursor = fromFen === state.startFen ? -1 : state.history.findIndex((m) => m.after === fromFen);
  if (baseCursor === -1 && fromFen !== state.startFen) return;

  const board = new Chess(fromFen);
  const steps = [];
  for (const san of sans) {
    let made = null;
    try {
      made = board.move(san);
    } catch (e) {
      made = null;
    }
    if (!made) break;
    steps.push({ san: made.san, from: made.from, to: made.to, fen: board.fen() });
  }
  if (!steps.length) return;

  cancelAutoplay();
  state.line = { baseCursor: baseCursor, moves: steps, index: -1 };
  showVariation({ animate: false });
  const tick = () => {
    if (!state.line || state.line.index >= state.line.moves.length - 1) return;
    state.line.index++;
    showVariation({ animate: true });
    state.variationTimer = setTimeout(tick, 620);
  };
  state.variationTimer = setTimeout(tick, 250);
}

/** Any deliberate move or navigation stops a line that is playing itself out. */
function cancelAutoplay() {
  clearTimeout(state.variationTimer);
  state.variationTimer = null;
}

/* ------------------------------------------------------------ analysis -- */

async function runAnalysis() {
  const button = document.getElementById('btn-analyse');
  const depth = Number(document.getElementById('depth-select').value);
  const progress = document.getElementById('progress');
  const fill = progress.querySelector('.progress-fill');
  const label = progress.querySelector('.progress-text');

  button.disabled = true;
  document.getElementById('depth-select').disabled = true;
  progress.classList.remove('hidden');
  fill.style.width = '0%';
  label.textContent = 'Starting the engine…';

  try {
    engineBadge.textContent = 'Engine loading…';
    await engine.boot();
    if (state.live) {
      // One worker: wait until the live search has actually stopped.
      await state.live.pause();
      renderEngineLines();
    }
    engineBadge.textContent = 'Stockfish 18 · ' + (engine.isMultithreaded ? engine.threads + ' threads' : 'single thread');
    engineBadge.classList.add('on');

    const started = Date.now();
    const analysis = await analyseGame(engine, state.game.pgn, { depth: depth }, (done, total) => {
      const pct = (done / total) * 100;
      fill.style.width = pct + '%';
      const elapsed = (Date.now() - started) / 1000;
      const remaining = done > 2 ? Math.round((elapsed / done) * (total - done)) : null;
      // The last "position" is the mate hunt, reported as a fraction as it progresses.
      label.textContent = done > total - 1
        ? 'Looking deeper for forced mates…'
        : 'Analysing position ' + done + ' of ' + (total - 1) + (remaining !== null ? ' · about ' + remaining + 's left' : '');
    });

    state.analysis = analysis;
    progress.classList.add('hidden');
    document.getElementById('analysis-setup').innerHTML =
      '<span class="muted">Reviewed at depth ' + depth + ' · ' + Math.round((Date.now() - started) / 1000) + 's</span>';

    renderMoveList();
    renderSummary();
    renderGraph();
    renderPerspectiveToggle();
    renderReview();
    if (state.live) state.live.resume();
    goTo(state.cursor);
  } catch (err) {
    if (state.live) state.live.resume();
    progress.classList.add('hidden');
    button.disabled = false;
    document.getElementById('depth-select').disabled = false;
    const box = document.createElement('div');
    box.className = 'error-box';
    box.textContent = 'Analysis failed: ' + (err && err.message ? err.message : String(err));
    document.getElementById('analysis-card').appendChild(box);
  }
}

function renderSummary() {
  const slot = document.getElementById('summary-slot');
  const g = state.game;
  const stats = state.analysis.stats;

  slot.innerHTML =
    '<div class="card"><div class="accuracy-row">' +
    '<div class="accuracy-box" data-color="w"><div class="who"></div><div class="value"></div><div class="label">Accuracy</div>' +
    '<div class="played-like"></div></div>' +
    '<div class="accuracy-box" data-color="b"><div class="who"></div><div class="value"></div><div class="label">Accuracy</div>' +
    '<div class="played-like"></div></div>' +
    '</div><div class="breakdown"></div></div>';

  for (const box of slot.querySelectorAll('.accuracy-box')) {
    const color = box.dataset.color;
    box.querySelector('.who').textContent = color === 'w' ? g.white.username : g.black.username;
    const value = stats[color].accuracy;
    box.querySelector('.value').textContent = value === null ? '—' : value.toFixed(1);
    box.classList.toggle('active', color === state.perspective);
    box.addEventListener('click', () => setPerspective(color));

    // "Played like ~1750" - the rating this game's move quality corresponds to.
    const estimate = estimateRating({
      accuracy: value,
      timeClass: g.timeClass,
      moveCount: stats[color].moveCount
    });
    const playedLike = box.querySelector('.played-like');
    if (estimate && estimate.available) {
      playedLike.innerHTML = '<span class="pl-label">played like</span> <b></b><span class="pl-range"></span>';
      playedLike.querySelector('b').textContent = '~' + estimate.rating;
      playedLike.querySelector('.pl-range').textContent = estimate.low + '–' + estimate.high;
      playedLike.title = ratingTooltip(estimate, g.timeClass);
      if (!estimate.reliable) playedLike.classList.add('rough');
    } else if (estimate) {
      // Say why there is no number rather than silently leaving a gap.
      playedLike.classList.add('unavailable');
      playedLike.textContent = estimate.reason === 'bullet' ? 'rating estimate n/a for bullet' : 'game too short to estimate';
      playedLike.title = unavailableReason(estimate);
    } else {
      playedLike.remove();
    }
  }

  const breakdown = slot.querySelector('.breakdown');
  const order = ['brilliant', 'great', 'best', 'excellent', 'good', 'missedWin', 'inaccuracy', 'mistake', 'blunder', 'forced'];
  for (const key of order) {
    const w = stats.w.counts[key];
    const b = stats.b.counts[key];
    if (!w && !b) continue;
    const row = document.createElement('div');
    row.className = 'breakdown-row';
    row.innerHTML =
      '<span class="sym ' + key + '"></span><span class="name"></span><span class="n"></span><span class="n"></span>';
    row.querySelector('.sym').textContent = LABELS[key].symbol;
    row.querySelector('.name').textContent = LABELS[key].text;
    const cells = row.querySelectorAll('.n');
    cells[0].textContent = w;
    cells[1].textContent = b;
    cells[state.perspective === 'w' ? 0 : 1].classList.add('me');
    breakdown.appendChild(row);
  }
}

function renderGraph() {
  const slot = document.getElementById('graph-slot');
  const moves = state.analysis.moves;
  const width = 600;
  const height = 78;

  // Expected score from White's point of view, per ply.
  const points = moves.map((m, i) => {
    const whiteWin = m.color === 'w' ? m.winAfter : 100 - m.winAfter;
    return { x: (i / Math.max(1, moves.length - 1)) * width, y: height - (whiteWin / 100) * height, i: i };
  });

  const path = points.map((p) => p.x.toFixed(1) + ',' + p.y.toFixed(1)).join(' ');
  const area = '0,' + height + ' ' + path + ' ' + width + ',' + height;

  // Black's territory is the dark ground, White's the light area drawn over it.
  slot.innerHTML =
    '<svg class="graph" viewBox="0 0 ' + width + ' ' + height + '" preserveAspectRatio="none">' +
    '<rect width="' + width + '" height="' + height + '" fill="#20242c"/>' +
    '<polygon points="' + area + '" fill="#cdd4de"/>' +
    '<polyline points="' + path + '" fill="none" stroke="#ffffff" stroke-width="1.2" stroke-opacity=".55"/>' +
    '<line x1="0" y1="' + height / 2 + '" x2="' + width + '" y2="' + height / 2 + '" stroke="#6c7686" stroke-width="1" stroke-dasharray="3 4"/>' +
    '<line class="cursor-line" x1="0" y1="0" x2="0" y2="' + height + '" stroke="#7fc08d" stroke-width="2"/>' +
    '</svg>';

  const svg = slot.querySelector('svg');

  // Mark the serious errors so the graph doubles as a jump list.
  for (const [i, m] of moves.entries()) {
    if (['mistake', 'blunder'].indexOf(m.label.key) === -1) continue;
    const p = points[i];
    const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    dot.setAttribute('cx', p.x);
    dot.setAttribute('cy', p.y);
    dot.setAttribute('r', 4);
    dot.setAttribute('fill', m.label.key === 'blunder' ? '#d0433f' : '#e58f2a');
    svg.appendChild(dot);
  }

  svg.addEventListener('click', (e) => {
    const rect = svg.getBoundingClientRect();
    const ratio = (e.clientX - rect.left) / rect.width;
    goTo(Math.round(ratio * (moves.length - 1)));
  });

  updateGraphCursor();
}

function updateGraphCursor() {
  const line = document.querySelector('.cursor-line');
  if (!line || !state.analysis) return;
  const total = Math.max(1, state.analysis.moves.length - 1);
  const x = (Math.max(0, state.cursor) / total) * 600;
  line.setAttribute('x1', x);
  line.setAttribute('x2', x);
}

function renderPerspectiveToggle() {
  const root = document.getElementById('perspective');
  root.classList.remove('hidden');
  root.innerHTML = '';
  for (const color of ['w', 'b']) {
    const btn = document.createElement('button');
    btn.textContent = 'Review ' + (color === 'w' ? state.game.white.username : state.game.black.username);
    btn.classList.toggle('on', state.perspective === color);
    btn.addEventListener('click', () => setPerspective(color));
    root.appendChild(btn);
  }
}

function setPerspective(color) {
  state.perspective = color;
  state.board.setOrientation(color);
  renderSummary();
  renderPerspectiveToggle();
  renderReview();
  renderPlayerStrips();
}

function renderReview() {
  const slot = document.getElementById('review-slot');
  const g = state.game;

  const review = buildReview(state.analysis, state.perspective, {
    white: g.white,
    black: g.black,
    result: g.result,
    termination: g.termination,
    opening: g.opening,
    openingUrl: g.ecoUrl,
    timeClass: g.timeClass
  });

  slot.innerHTML = '';
  const card = document.createElement('div');
  card.className = 'card';
  slot.appendChild(card);

  card.appendChild(section('Summary', [{ html: '<p class="headline"></p>', fill: (el) => (el.querySelector('.headline').textContent = review.headline) }]));

  if (review.opening) {
    card.appendChild(
      section('Opening', [
        {
          html: '<div class="finding moment"><div class="f-title"></div><div class="f-detail"></div></div>',
          fill: (el) => {
            el.querySelector('.f-title').textContent = review.opening.name;
            el.querySelector('.f-detail').textContent = review.opening.detail;
          },
          ply: review.opening.ply
        }
      ])
    );
  }

  card.appendChild(findingSection('What you did well', review.strengths, 'good'));
  card.appendChild(findingSection('What to work on', review.improvements, 'bad'));

  if (review.keyMoments.length) card.appendChild(findingSection('Turning points', review.keyMoments, 'moment'));

  if (review.time && !review.time.isProblem) {
    card.appendChild(findingSection('Clock', [review.time], 'moment'));
  }

  card.appendChild(phaseSection(review.phases));
}

function section(title, items) {
  const wrap = document.createElement('div');
  wrap.className = 'review-section';
  const h = document.createElement('h3');
  h.textContent = title;
  wrap.appendChild(h);
  for (const item of items) {
    const holder = document.createElement('div');
    holder.innerHTML = item.html;
    item.fill(holder);
    if (item.ply !== null && item.ply !== undefined) holder.appendChild(jumpButton(item.ply));
    wrap.appendChild(holder);
  }
  return wrap;
}

function findingSection(title, findings, kind) {
  const wrap = document.createElement('div');
  wrap.className = 'review-section';
  const h = document.createElement('h3');
  h.textContent = title;
  wrap.appendChild(h);

  if (!findings.length) {
    const p = document.createElement('p');
    p.className = 'muted';
    p.textContent = 'Nothing notable here.';
    wrap.appendChild(p);
    return wrap;
  }

  for (const f of findings) {
    const el = document.createElement('div');
    el.className = 'finding ' + kind;
    el.innerHTML = '<div class="f-title"></div><div class="f-detail"></div>';
    el.querySelector('.f-title').textContent = f.title;
    el.querySelector('.f-detail').textContent = f.detail;
    if (f.ply !== null && f.ply !== undefined) el.appendChild(jumpButton(f.ply));
    wrap.appendChild(el);
  }
  return wrap;
}

function jumpButton(ply) {
  const btn = document.createElement('button');
  btn.className = 'f-jump';
  const move = state.analysis.moves[ply];
  btn.textContent = move ? 'Go to move ' + move.moveNumber + (move.color === 'w' ? '' : '…') : 'Go to position';
  btn.addEventListener('click', () => {
    goTo(ply);
    document.getElementById('board').scrollIntoView({ behavior: 'smooth', block: 'center' });
  });
  return btn;
}

function phaseSection(phases) {
  const wrap = document.createElement('div');
  wrap.className = 'review-section';
  const h = document.createElement('h3');
  h.textContent = 'Accuracy by phase';
  wrap.appendChild(h);

  const bars = document.createElement('div');
  bars.className = 'phase-bars';
  for (const phase of phases) {
    const row = document.createElement('div');
    row.className = 'phase-row';
    row.innerHTML = '<span class="name"></span><span class="track"><span class="fill"></span></span><span class="pct"></span>';
    row.querySelector('.name').textContent = phase.name + ' (' + phase.count + ')';
    row.querySelector('.fill').style.width = (phase.accuracy || 0) + '%';
    row.querySelector('.pct').textContent = phase.accuracy === null ? '—' : phase.accuracy.toFixed(0) + '%';
    bars.appendChild(row);
  }
  wrap.appendChild(bars);
  return wrap;
}

/* ------------------------------------------------------------- startup -- */

document.getElementById('search-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const value = document.getElementById('search-input').value.trim();
  if (value) location.hash = '#/u/' + encodeURIComponent(value);
});

document.addEventListener('keydown', (e) => {
  if (!state.board || e.target.matches('input, select, textarea')) return;
  if (e.key === 'ArrowLeft') { e.preventDefault(); stepBack(); }
  else if (e.key === 'ArrowRight') { e.preventDefault(); stepForward(); }
  else if (e.key === 'Escape' && state.line) { e.preventDefault(); leaveVariation(); }
  else if (e.key === 'Home') { e.preventDefault(); goTo(-1); }
  else if (e.key === 'End') { e.preventDefault(); goTo(state.history.length - 1); }
  else if (e.key === 'f' || e.key === 'F') { state.board.flip(); renderPlayerStrips(); }
});

window.addEventListener('hashchange', route);

/* ------------------------------------------------------- stale-tab notice -- */

/**
 * The code on disk changes without a server restart, but a tab that is already
 * open keeps running whatever it loaded. That produced a confusing session where a
 * review ran on old code after a fix had shipped. So: remember the build this tab
 * loaded, poll the server's, and say so plainly when they differ.
 */
let loadedBuild = null;

async function fetchBuild() {
  try {
    const res = await fetch('/version', { cache: 'no-store' });
    if (!res.ok) return null;
    return (await res.json()).build || null;
  } catch (e) {
    return null;
  }
}

function showStaleNotice(serverBuild) {
  if (document.getElementById('stale-notice')) return;
  const bar = document.createElement('div');
  bar.id = 'stale-notice';
  bar.className = 'stale-notice';
  bar.innerHTML =
    '<span>The app has been updated since this tab loaded — results here come from older code.</span>' +
    '<button type="button" class="primary">Reload</button>';
  bar.querySelector('button').addEventListener('click', () => location.reload());
  document.body.appendChild(bar);
  engineBadge.title = 'This tab: ' + loadedBuild + ' | Server: ' + serverBuild + ' | Reload to pick up the new code.';
}

async function watchBuild() {
  loadedBuild = await fetchBuild();
  if (loadedBuild) {
    const stamp = new Date(loadedBuild);
    engineBadge.title = 'Code loaded: ' + stamp.toLocaleString() + ' · analysis runs locally in your browser';
  }
  setInterval(async () => {
    const current = await fetchBuild();
    if (current && loadedBuild && current !== loadedBuild) showStaleNotice(current);
  }, 20000);
}

// The piece sprite has to be in the document before any board is drawn.
await loadPieceSprite().catch((err) => console.error(err));
if (!STATIC_HOST) watchBuild();
route();
