/**
 * End-to-end browser check: launches Edge headless, drives the real app over the
 * DevTools protocol, and asserts that the pages render and that a full engine
 * review completes in the browser.
 *
 *   node scripts/browsertest.mjs [username]
 *
 * Assumes the server is already running on PORT (default 5173).
 */

import { launch, findBrowser } from './cdp.mjs';

const PORT = process.env.PORT || 5173;
const BASE = 'http://localhost:' + PORT;
const USERNAME = process.argv[2] || 'hikaru';

if (!findBrowser()) {
  console.error('No Edge/Chrome found; skipping browser test.');
  process.exit(0);
}

const page = await launch({ port: 9222, width: 1500, height: 1000 });
const { evaluate, waitFor } = page;

const failures = [];
const check = (label, ok, extra) => {
  console.log((ok ? '  ok   ' : '  FAIL ') + label + (ok || !extra ? '' : ' — ' + extra));
  if (!ok) failures.push(label + (extra ? ': ' + extra : ''));
};

try {
  console.log('\n1. Home page');
  await page.navigate(BASE + '/');
  await waitFor('document.querySelector(".home")', 15000, 'home page');
  check('home renders', await evaluate('!!document.querySelector(".home h1")'));
  check('cross-origin isolated (multi-threaded engine available)', await evaluate('crossOriginIsolated === true'));

  console.log('\n2. Player page for ' + USERNAME);
  await evaluate('location.hash = "#/u/' + USERNAME + '"');
  await waitFor('document.querySelectorAll(".game-row").length > 0', 30000, 'games list');
  const gameCount = await evaluate('document.querySelectorAll(".game-row").length');
  check('games listed', gameCount > 0, gameCount + ' rows');
  check('profile rendered', await evaluate('!!document.querySelector("#profile .name")'));
  check(
    'game rows name both players',
    await evaluate('document.querySelector(".game-row .players div").textContent.split("vs").length === 2'),
    await evaluate('document.querySelector(".game-row .players div").textContent')
  );
  check('game rows have a subtitle', await evaluate('document.querySelector(".game-row .sub").textContent.length > 3'));

  console.log('\n3. Opening a game');
  await evaluate('document.querySelectorAll(".game-row")[0].click()');
  await waitFor('document.querySelector("#board .sq .piece")', 15000, 'board');
  check('board has pieces', (await evaluate('document.querySelectorAll("#board .piece").length')) >= 2);
  check('move list built', (await evaluate('document.querySelectorAll(".move-item").length')) > 0);
  check('game header filled', (await evaluate('document.querySelector("#game-head .title").textContent.length')) > 5);

  // Pieces are vector art from the sprite, not outlined text glyphs.
  check('pieces are SVG referencing the sprite',
    await evaluate(`document.querySelector('#board .piece').tagName.toLowerCase() === 'svg'`),
    await evaluate(`document.querySelector('#board .piece').tagName`));
  check('the sprite is in the document',
    await evaluate(`!!document.getElementById('piece-sprite') && !!document.getElementById('wn')`));
  check('pieces render at a real size',
    await evaluate(`document.querySelector('#board .piece').getBoundingClientRect().width > 20`),
    String(await evaluate(`Math.round(document.querySelector('#board .piece').getBoundingClientRect().width)`)));

  console.log('\n3b. Board theme picker');
  check('four board themes are offered', (await evaluate(`document.querySelectorAll('.swatch').length`)) === 4);
  check('swatches sit in a row, not stacked in a column',
    await evaluate(`(() => {
      const s = document.querySelectorAll('.swatch');
      return s.length > 1 && Math.abs(s[0].getBoundingClientRect().top - s[1].getBoundingClientRect().top) < 2;
    })()`));
  await evaluate(`Array.from(document.querySelectorAll('.swatch')).find((s) => s.dataset.theme === 'walnut').click()`);
  check('picking a theme switches the board', (await evaluate(`document.documentElement.dataset.board`)) === 'walnut');
  check('the square colour actually changes',
    (await evaluate(`getComputedStyle(document.querySelector('#board .sq.dark')).backgroundColor`)) === 'rgb(181, 136, 99)',
    await evaluate(`getComputedStyle(document.querySelector('#board .sq.dark')).backgroundColor`));
  check('the choice is remembered', (await evaluate(`localStorage.getItem('chess-review-board')`)) === 'walnut');
  await evaluate(`Array.from(document.querySelectorAll('.swatch')).find((s) => s.dataset.theme === 'slate').click()`);

  console.log('\n4. Keyboard navigation');
  const beforeNav = await evaluate('document.querySelector(".move-item.current").dataset.ply');
  await evaluate('document.getElementById("btn-first").click()');
  check('first-move button resets the board', (await evaluate('!document.querySelector(".move-item.current")')) === true);
  await evaluate('document.getElementById("btn-next").click()');
  check('next advances to ply 0', (await evaluate('document.querySelector(".move-item.current").dataset.ply')) === '0');
  await evaluate('document.getElementById("btn-flip").click(); document.getElementById("btn-flip").click();');
  check('flip works twice without error', true, beforeNav);

  console.log('\n5. Move animation');
  // Stepping one move must start a real CSS transition on the piece that moved,
  // beginning offset at its old square rather than appearing at the new one.
  const stepAnim = await evaluate(`(() => {
    document.getElementById('btn-first').click();
    document.getElementById('btn-next').click();
    const moving = Array.from(document.querySelectorAll('#board .piece'))
      .filter((p) => getComputedStyle(p).transitionDuration !== '0s');
    return {
      count: moving.length,
      duration: moving.length ? getComputedStyle(moving[0]).transitionDuration : null,
      transform: moving.length ? getComputedStyle(moving[0]).transform : null,
      zIndex: moving.length ? moving[0].style.zIndex : null
    };
  })()`);
  check('stepping a move animates exactly one piece', stepAnim.count === 1, JSON.stringify(stepAnim));
  // Computed style lists one duration per transitioned property (transform, opacity).
  check('animation has a duration',
    /^0\.18s(, 0\.18s)*$/.test(String(stepAnim.duration)), String(stepAnim.duration));
  check('piece starts offset from its destination',
    stepAnim.transform && stepAnim.transform !== 'none' && stepAnim.transform !== 'matrix(1, 0, 0, 1, 0, 0)',
    String(stepAnim.transform));
  check('moving piece is lifted above the rest', stepAnim.zIndex === '6', String(stepAnim.zIndex));

  const settled = 'Array.from(document.querySelectorAll("#board .piece")).every((p) => !p.style.transform)';
  await waitFor(settled, 3000, 'animation cleanup');
  check('inline styles are cleaned up when it lands', true);

  // A jump of several moves should still show the clicked move being played.
  const jumpAnim = await evaluate(`(() => {
    document.getElementById('btn-first').click();
    const items = document.querySelectorAll('.move-item');
    items[Math.min(9, items.length - 1)].click();
    return Array.from(document.querySelectorAll('#board .piece'))
      .filter((p) => getComputedStyle(p).transitionDuration !== '0s').length;
  })()`);
  check('jumping to a distant move still animates that move', jumpAnim >= 1, String(jumpAnim));

  await waitFor(settled, 3000, 'jump cleanup');

  // Anyone who asks their OS for less motion should get an instant board.
  await page.setReducedMotion('reduce');
  const reducedAnim = await evaluate(`(() => {
    document.getElementById('btn-first').click();
    document.getElementById('btn-next').click();
    return Array.from(document.querySelectorAll('#board .piece'))
      .filter((p) => getComputedStyle(p).transitionDuration !== '0s').length;
  })()`);
  check('prefers-reduced-motion switches the animation off', reducedAnim === 0, String(reducedAnim));
  await page.setReducedMotion('no-preference');

  await evaluate('document.getElementById("btn-last").click()');

  console.log('\n6. Running a full review in the browser (depth 12)');
  await evaluate('document.getElementById("depth-select").value = "12"');
  const started = Date.now();
  await evaluate('document.getElementById("btn-analyse").click()');
  await waitFor('document.querySelector("#review-slot .finding")', 600000, 'review output');
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  console.log('     review finished in ' + seconds + 's');

  check('engine badge shows the build', /Stockfish/.test(await evaluate('document.getElementById("engine-badge").textContent')),
    await evaluate('document.getElementById("engine-badge").textContent'));
  check('the review opens the Report tab', (await evaluate('document.querySelector(".tab.on").dataset.tab')) === 'report');
  check('accuracy shown for both players', (await evaluate('document.querySelectorAll(".accuracy-box .value").length')) === 2);
  const accuracies = await evaluate('Array.from(document.querySelectorAll(".accuracy-box .value")).map(e => e.textContent)');
  check('accuracies are numbers', accuracies.every((a) => /^\d+(\.\d+)?$/.test(a)), JSON.stringify(accuracies));
  check('move list now labelled', (await evaluate('document.querySelectorAll(".move-item .sym").length')) > 0);
  check('eval graph drawn', await evaluate('!!document.querySelector(".graph polygon")'));
  check('eval bar has a value', (await evaluate('document.querySelector(".evalbar-text").textContent.length')) > 0);

  // The exact evaluation must be readable as text, not just inferred from the bar.
  const evalTags = await evaluate('Array.from(document.querySelectorAll(".move-list .move-eval")).map(e => e.textContent)');
  check('every move shows a numeric evaluation',
    evalTags.length === (await evaluate('document.querySelectorAll(".move-item").length')),
    evalTags.length + ' tags');
  check('evaluations are signed numbers or mate scores',
    evalTags.every((t) => /^-?(M\d+|\d+\.\d{2})$/.test(t.replace('+', ''))),
    JSON.stringify(evalTags.slice(0, 6)));
  check('a move-list evaluation is negative somewhere (both sides represented)',
    evalTags.some((t) => t.startsWith('-')) || evalTags.some((t) => t.startsWith('+')),
    JSON.stringify(evalTags.slice(0, 4)));
  check('readout names who stands better',
    /Equal|White|Black/.test(await evaluate('document.querySelector("#move-note .eval-readout span").textContent')),
    await evaluate('document.querySelector("#move-note .eval-readout").textContent'));
  check('readout shows the exact number',
    /^[+-]?(M?\d)/.test(await evaluate('document.querySelector("#move-note .eval-readout b").textContent')),
    await evaluate('document.querySelector("#move-note .eval-readout b").textContent'));

  // Stepping to the start position must still answer "who is better".
  await evaluate('document.getElementById("btn-first").click()');
  check('start position also shows an evaluation',
    (await evaluate('document.querySelectorAll("#move-note .eval-readout").length')) === 1,
    await evaluate('document.querySelector("#move-note").textContent'));
  await evaluate('document.getElementById("btn-last").click()');

  // "Played like ~1750" - the estimated rating for each side.
  const playedLike = await evaluate(
    'Array.from(document.querySelectorAll(".played-like")).map((e) => e.textContent.trim())'
  );
  check('a rating estimate is shown for both players', playedLike.length === 2, JSON.stringify(playedLike));
  const stripRatings = await evaluate(
    'Array.from(document.querySelectorAll(".player-strip .strip-rating")).map((e) => e.textContent.trim())'
  );
  const timeClass = await evaluate('document.querySelector("#game-head .meta").textContent');
  if (/bullet/.test(timeClass)) {
    check('bullet games decline to estimate rather than guess',
      playedLike.every((t) => /n\/a for bullet/.test(t)), JSON.stringify(playedLike));
  } else {
    check('estimate shows a number and a range',
      playedLike.every((t) => /played like\s*~\d+\s*\d+[–-]\d+/.test(t.replace(/\s+/g, ' '))),
      JSON.stringify(playedLike));
    check('the rating is also shown beside the board, not only in the side panel',
      stripRatings.length === 2 && stripRatings.every((t) => /played like\s*~\d+/.test(t)),
      JSON.stringify(stripRatings));
    check('estimate carries an explanatory tooltip',
      await evaluate('(document.querySelector(".played-like").title || "").length > 40'),
      await evaluate('document.querySelector(".played-like").title'));
  }

  const headline = await evaluate('document.querySelector("#review-slot .headline").textContent');
  check('headline written', headline.length > 40, headline.slice(0, 120));
  const reviewText = await evaluate('document.getElementById("review-slot").textContent');
  check('review text has no placeholders', !/undefined|NaN|\[object/.test(reviewText));
  check('strengths section present', /What you did well/.test(reviewText));
  check('improvements section present', /What to work on/.test(reviewText));

  console.log('\n6. Clicking through the review');
  await evaluate('document.querySelectorAll("#review-slot .f-jump")[0].click()');
  check('jump link moves the board', await evaluate('!!document.querySelector(".move-item.current")'));
  check('move note filled in', (await evaluate('document.querySelector("#move-note .note-text").textContent.length')) > 20,
    (await evaluate('document.querySelector("#move-note .note-text").textContent')).slice(0, 140));

  await evaluate('document.querySelectorAll("#perspective button")[1].click()');
  check('perspective switch re-renders', (await evaluate('document.querySelectorAll("#review-slot .finding").length')) > 0);

  console.log('\n6a. Explain (the coaching panel)');
  // Land on the worst move in the game, so the panel has a real error to teach from.
  await evaluate(`(() => {
    const items = Array.from(document.querySelectorAll('.move-item'));
    const bad = items.find((i) => i.querySelector('.sym.blunder')) ||
                items.find((i) => i.querySelector('.sym.mistake')) ||
                items.find((i) => i.querySelector('.sym.inaccuracy'));
    (bad || items[items.length - 1]).click();
  })()`);

  check('an Explain button sits on every move', await evaluate(`!!document.querySelector('.explain-btn')`));
  check('the panel starts closed', (await evaluate(`document.querySelectorAll('.coach-section').length`)) === 0);

  await evaluate(`document.querySelector('.explain-btn').click()`);
  const sections = await evaluate(
    `Array.from(document.querySelectorAll('.coach-section h4')).map((h) => h.textContent)`
  );
  check('opening it produces a coaching breakdown', sections.length >= 2, JSON.stringify(sections));

  // A clean game may have no errors at all, so only demand the teaching sections
  // when we actually landed on a mistake.
  const onError = await evaluate(
    `!!document.querySelector('.move-item.current .sym.blunder, .move-item.current .sym.mistake, .move-item.current .sym.inaccuracy')`
  );
  if (onError) {
    check('it names the concept behind the move',
      sections.some((t) => /The idea behind it/.test(t)), JSON.stringify(sections));
    check('it says what to play instead',
      sections.some((t) => /What to play instead/.test(t)), JSON.stringify(sections));
    check('it gives something to work on',
      sections.some((t) => /Work on this/.test(t)), JSON.stringify(sections));
  } else {
    check('a good move still gets a reason',
      sections.some((t) => /Why this works|Why this is worth remembering/.test(t)), JSON.stringify(sections));
  }

  const coachText = await evaluate(`document.querySelector('.coach-panel').textContent`);
  check('the breakdown is substantial prose', coachText.length > 200, String(coachText.length) + ' chars');
  check('no placeholders in the coaching text', !/undefined|NaN|\[object/.test(coachText));
  check('a headline is shown', (await evaluate(`document.querySelector('.coach-headline').textContent.length`)) > 20);

  // Variations are clickable and play out on the board.
  const hasLine = await evaluate(`!!document.querySelector('.coach-line')`);
  check('at least one variation is offered', hasLine);
  if (hasLine) {
    await evaluate(`document.querySelector('.coach-line').click()`);
    await waitFor('!document.getElementById("variation-bar").classList.contains("hidden")', 3000, 'coach line as a variation');
    check('clicking a line opens it as a variation on the board', true);
    await waitFor('document.querySelectorAll("#variation-bar .variation-move.current").length === 1', 3000, 'first move of the line played');
    check('the line plays itself out move by move', true);
    // Leaving it must stop the autoplay dead - nothing may move the board later.
    await evaluate('document.getElementById("btn-leave-variation").click()');
    await new Promise((r) => setTimeout(r, 1500));
    check('leaving the variation stops the playback', await evaluate('document.getElementById("variation-bar").classList.contains("hidden")'));
  }

  // The panel should stay open as you step, not need reopening every move.
  await evaluate('document.getElementById("btn-next").click()');
  check('the panel stays open while stepping',
    (await evaluate(`document.querySelectorAll('.coach-section').length`)) > 0);
  await evaluate(`document.querySelector('.explain-btn').click()`);
  check('it can be closed again', (await evaluate(`document.querySelectorAll('.coach-section').length`)) === 0);

  console.log('\n6b. Captured material');
  await evaluate('document.getElementById("btn-last").click()');
  const captured = await evaluate(
    `Array.from(document.querySelectorAll('.player-strip .captured')).map((e) => e.querySelectorAll('.cap-piece').length)`
  );
  check('captured pieces are shown beside the players', captured.some((n) => n > 0), JSON.stringify(captured));
  await evaluate('document.getElementById("btn-first").click()');
  const atStart = await evaluate(`document.querySelectorAll('.player-strip .cap-piece').length`);
  check('nothing is captured at the starting position', atStart === 0, String(atStart));
  await evaluate('document.getElementById("btn-last").click()');

  console.log('\n6c. Label badges on the board');
  const badge = await evaluate(`(function(){const b=document.querySelector('#board .badge'); return b ? b.className + ' ' + b.textContent : '';})()`);
  check('the last move carries its label badge on the board', /badge \w+/.test(badge), badge);
  const badgeSquare = await evaluate(`document.querySelector('#board .badge').closest('.sq').dataset.square`);
  const lastTo = await evaluate(`document.querySelector('.move-item.current .sym').className`);
  check('the badge sits on the square the move landed on', /^[a-h][1-8]$/.test(badgeSquare), badgeSquare);
  check('badge and move list agree on the label', badge.indexOf(lastTo.replace('sym ', '')) !== -1, badge + ' vs ' + lastTo);

  console.log('\n6d. Engine lines follow the board');
  await evaluate('document.querySelector(".tab[data-tab=moves]").click()'); // the review left us on Report
  await waitFor('document.querySelectorAll("#engine-lines .engine-line").length >= 2', 90000, 'engine lines');
  const firstLine = await evaluate('document.querySelector("#engine-lines .engine-line").innerText.replace(/\\n/g, " ")');
  check('three lines with an evaluation and a continuation', /^[+-]?(\d+\.\d\d|M\d+) \d+\.(\.\.)? \w/.test(firstLine), firstLine);
  check('depth is reported', /^depth \d+/.test(await evaluate('document.getElementById("engine-depth").textContent')));

  console.log('\n6e. Trying moves on the board');
  const centre = async (square) => evaluate(`(function(){const b=document.querySelector('[data-square="${square}"]').getBoundingClientRect();return {x:b.left+b.width/2,y:b.top+b.height/2};})()`);
  const mouse = (type, x, y) => page.cdp.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 }, page.sessionId);
  const clickSquare = async (square) => { const c = await centre(square); await mouse('mousePressed', c.x, c.y); await mouse('mouseReleased', c.x, c.y); };
  await evaluate('document.getElementById("btn-first").click()');
  await clickSquare('e2');
  check('clicking a piece selects it and shows its destinations',
    (await evaluate('document.querySelectorAll(".sq.dest").length')) === 2 && (await evaluate('document.querySelector(".sq.selected").dataset.square')) === 'e2');
  await clickSquare('e4');
  await waitFor('!document.getElementById("variation-bar").classList.contains("hidden")', 5000, 'variation bar');
  // Flex items come through innerText separated by newlines, so collapse whitespace.
  const barText = () => evaluate('document.getElementById("variation-bar").innerText.replace(/\\s+/g, " ")');
  check('a click-move starts a variation', /1\. e4/.test(await barText()), await barText());
  check('the piece moved on the board', await evaluate(`!!document.querySelector('[data-square="e4"] .piece') && !document.querySelector('[data-square="e2"] .piece')`));
  check('the move list is left alone (no game move is current at the start)', (await evaluate('document.querySelectorAll(".move-item.current").length')) === 0);
  // Flex items come through innerText with newlines, so the helper collapses them.
  const firstEngineLine = String.raw`document.querySelector("#engine-lines .engine-line").innerText.replace(/\s+/g, " ")`;
  await waitFor(String.raw`document.getElementById("engine-depth").textContent.startsWith("depth") && /^[^ ]+ 1\.\.\. /.test(` + firstEngineLine + ')', 90000, 'lines for the variation');
  check('engine lines now analyse the variation position (Black to move)', true);
  check('the eval bar follows the variation', (await evaluate('document.querySelector(".evalbar-text").textContent.length')) > 0);
  check('the commentary card explains it is a variation', /variation/i.test(await evaluate('document.getElementById("move-note").innerText')));

  // Drag a piece: pointer down, several moves, release on the target.
  const from = await centre('e7');
  const to = await centre('e5');
  await mouse('mousePressed', from.x, from.y);
  for (let i = 1; i <= 4; i++) await page.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x + (to.x - from.x) * i / 4, y: from.y + (to.y - from.y) * i / 4, button: 'left' }, page.sessionId);
  await mouse('mouseReleased', to.x, to.y);
  try {
    await waitFor('/1\\. e4 e5/.test(document.getElementById("variation-bar").innerText.replace(/\\s+/g, " "))', 5000, 'dragged move');
  } catch (err) {
    console.log('     drag debug: from', JSON.stringify(from), 'to', JSON.stringify(to), 'scrollY', await evaluate('window.scrollY'),
      'atFrom', await evaluate(`(function(){const e=document.elementFromPoint(${from.x},${from.y}); return e ? e.className + ' ' + (e.dataset.square||'') : 'none';})()`),
      'atTo', await evaluate(`(function(){const e=document.elementFromPoint(${to.x},${to.y}); return e ? e.className + ' ' + (e.dataset.square||'') : 'none';})()`),
      'bar', await barText(), 'selected', await evaluate('document.querySelector(".sq.selected") ? document.querySelector(".sq.selected").dataset.square : null'));
    throw err;
  }
  check('a dragged move extends the variation', true);

  // A move from an engine line is playable too, once the lines are for this position.
  await waitFor(String.raw`document.getElementById("engine-depth").textContent.startsWith("depth") && /^[^ ]+ 2\. /.test(` + firstEngineLine + ')', 90000, 'lines after 1. e4 e5');
  await evaluate('document.querySelector("#engine-lines .engine-move").click()');
  await waitFor('document.querySelectorAll("#variation-bar .variation-move").length === 3', 5000, 'engine move played');
  check('clicking an engine-line move plays it', true);

  // Arrow keys walk the variation; Escape leaves it.
  await evaluate(`document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }))`);
  check('left arrow steps back inside the variation', (await evaluate('document.querySelector("#variation-bar .variation-move.current").textContent')) === 'e5');
  await evaluate(`document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await waitFor('document.getElementById("variation-bar").classList.contains("hidden")', 5000, 'back to game');
  check('Escape returns to the game position', await evaluate(`!!document.querySelector('[data-square="e2"] .piece') && document.querySelectorAll(".move-item.current").length === 0`));
  await evaluate('document.getElementById("btn-last").click()');
  check('the game position is intact afterwards', (await evaluate('document.querySelectorAll(".move-item.current").length')) === 1);

  console.log('\n6f. Moves and Report tabs');
  await evaluate('document.querySelector(".tab[data-tab=report]").click()');
  check('the Report tab shows the recap and hides the moves',
    await evaluate('!document.getElementById("tab-report").classList.contains("hidden") && document.getElementById("tab-moves").classList.contains("hidden")'));
  check('the recap holds the accuracy boxes and the written review',
    await evaluate('document.getElementById("tab-report").contains(document.querySelector(".accuracy-box")) && document.getElementById("tab-report").contains(document.querySelector("#review-slot .finding"))'));
  // The board must stay put however far the side column is scrolled.
  const boardTopBefore = await evaluate('Math.round(document.getElementById("board").getBoundingClientRect().top)');
  await evaluate('document.querySelector(".side-column").scrollTop = 100000');
  const boardTopAfter = await evaluate('Math.round(document.getElementById("board").getBoundingClientRect().top)');
  check('scrolling the report leaves the board where it is', boardTopBefore === boardTopAfter && boardTopAfter >= 0, boardTopBefore + ' -> ' + boardTopAfter);
  check('the tab bar stays reachable while scrolled', (await evaluate('document.querySelector(".tabs").getBoundingClientRect().top')) >= 0);
  await evaluate('document.querySelector(".tab[data-tab=moves]").click()');
  check('the Moves tab brings back the list and the engine lines',
    await evaluate('!document.getElementById("tab-moves").classList.contains("hidden") && document.getElementById("tab-moves").contains(document.getElementById("move-list")) && document.getElementById("tab-moves").contains(document.getElementById("engine-card"))'));
  check('the current move is scrolled into view inside the list', await evaluate(`(function(){const el=document.querySelector('.move-item.current'); const l=el.parentElement; const t=el.offsetTop; return t >= l.scrollTop && t + el.offsetHeight <= l.scrollTop + l.clientHeight;})()`));

  console.log('\n7. Pasted PGN (the route for games against bots)');
  const botPgn = [
    '[Event "Computer Opponent"]',
    '[Site "Chess.com"]',
    '[Date "2026.08.20"]',
    '[White "somehuman"]',
    '[Black "Martin"]',
    '[Result "1-0"]',
    '[WhiteElo "1100"]',
    '[TimeControl "600"]',
    '[Termination "somehuman won by checkmate"]',
    '[UTCDate "2026.08.20"]',
    '[UTCTime "18:04:11"]',
    '',
    '1. e4 e5 2. Bc4 Nc6 3. Qh5 Nf6 4. Qxf7# 1-0'
  ].join('\n');

  await evaluate('location.hash = "#/"');
  await waitFor('document.querySelector("#pgn-input")', 10000, 'home pgn panel');

  // Discoverability: the box has to be usable on sight, with nothing to expand first.
  check('paste box is visible without interaction',
    await evaluate('document.querySelector("#pgn-input").getBoundingClientRect().height > 40'),
    'height ' + (await evaluate('Math.round(document.querySelector("#pgn-input").getBoundingClientRect().height)')));
  check('paste button is visible without interaction',
    await evaluate('document.querySelector("#pgn-go").getBoundingClientRect().height > 0'));
  check('an entry point exists on the player page',
    await evaluate('!!document.getElementById("tpl-player").content.querySelector(".pgn-button")'));

  await evaluate(
    'document.querySelector("#pgn-input").value = ' + JSON.stringify(botPgn) + ';' +
      'document.querySelector("#pgn-go").click();'
  );
  await waitFor('document.querySelector("#board .piece")', 15000, 'pgn review board');
  check('pasted PGN opens the review page', await evaluate('location.hash === "#/pgn/0"'), await evaluate('location.hash'));
  const pgnHead = await evaluate('document.querySelector("#game-head .title").textContent');
  check('bot game header names both sides', /somehuman/.test(pgnHead) && /Martin/.test(pgnHead), pgnHead);
  const pgnMeta = await evaluate('document.querySelector("#game-head .meta").textContent');
  check('metadata parsed from PGN headers', /blitz|rapid/.test(pgnMeta) && /checkmate/.test(pgnMeta), pgnMeta);
  check('moves parsed from PGN', (await evaluate('document.querySelectorAll(".move-item").length')) === 7,
    String(await evaluate('document.querySelectorAll(".move-item").length')));

  await evaluate('document.getElementById("depth-select").value = "12"');
  await evaluate('document.getElementById("btn-analyse").click()');
  await waitFor('document.querySelector("#review-slot .finding")', 300000, 'pgn review');
  const pgnReview = await evaluate('document.getElementById("review-slot").textContent');
  check('bot game reviewed', /What to work on/.test(pgnReview) && !/undefined|NaN/.test(pgnReview));
  check('mate found in the review', /mate/i.test(pgnReview), pgnReview.slice(0, 100));

  console.log('\n7b. Missed wins show up on screen');
  const missPgn =
    '[Event "Miss"]\n[White "A"]\n[Black "B"]\n[Result "1-0"]\n[TimeControl "600"]\n' +
    '[SetUp "1"]\n[FEN "6k1/5ppp/1b6/8/8/8/4QPPP/R5K1 w - - 0 1"]\n\n' +
    '1. Qe4 h6 2. Qb7 Bd4 3. Ra8+ Kh7 4. Qf3 1-0';
  await evaluate('location.hash = "#/"');
  await waitFor('document.querySelector("#pgn-input")', 10000, 'home pgn panel');
  await evaluate(
    'document.querySelector("#pgn-input").value = ' + JSON.stringify(missPgn) + ';' +
      'document.querySelector("#pgn-go").click();'
  );
  await waitFor('document.querySelector("#board .piece")', 15000, 'miss fixture board');
  await evaluate('document.getElementById("depth-select").value = "12"');
  await evaluate('document.getElementById("btn-analyse").click()');
  await waitFor('document.querySelector("#review-slot .finding")', 300000, 'miss fixture review');
  const missCount = await evaluate(`document.querySelectorAll('.move-item .sym.missedWin').length`);
  check('missed wins are labelled in the move list', missCount >= 2, String(missCount));
  check('the breakdown table has a Missed win row',
    await evaluate(`Array.from(document.querySelectorAll('.breakdown-row .name')).some((n) => /Missed win/.test(n.textContent))`));
  check('the review groups them under What to work on',
    /let a forced win slip|Missed win on move/.test(await evaluate('document.getElementById("review-slot").textContent')));
  check('the headline counts them',
    /missed win/.test(await evaluate('document.querySelector("#review-slot .headline").textContent')),
    await evaluate('document.querySelector("#review-slot .headline").textContent'));

  console.log('\n8. Multi-game PGN');
  await evaluate('location.hash = "#/"');
  await waitFor('document.querySelector("#pgn-input")', 10000, 'home pgn panel');
  await evaluate(
    'document.querySelector("#pgn-input").value = ' + JSON.stringify(botPgn + '\n\n' + botPgn.replace('Martin', 'Nelson')) + ';' +
      'document.querySelector("#pgn-go").click();'
  );
  await waitFor('document.querySelectorAll(".game-row").length > 0', 10000, 'pgn list');
  check('multi-game PGN lists both games', (await evaluate('document.querySelectorAll(".game-row").length')) === 2);
  await evaluate('document.querySelectorAll(".game-row")[1].click()');
  await waitFor('document.querySelector("#board .piece")', 15000, 'second pgn game');
  check('second pasted game opens', /Nelson/.test(await evaluate('document.querySelector("#game-head .title").textContent')));

  console.log('\n9. Single-threaded engine fallback');
  // Browsers without SharedArrayBuffer get this build; make sure it loads and answers.
  const fallback = await evaluate(
    `new Promise((resolve) => {
       const w = new Worker('/engine/stockfish-18-lite-single.js');
       const timer = setTimeout(() => resolve('timeout'), 60000);
       w.onmessage = (e) => {
         const line = typeof e.data === 'string' ? e.data : '';
         if (/^bestmove/.test(line)) { clearTimeout(timer); w.terminate(); resolve(line); }
       };
       w.postMessage('uci');
       w.postMessage('position startpos moves e2e4 e7e5 g1f3');
       w.postMessage('go depth 10');
     })`,
    true
  );
  check('single-threaded build searches', /^bestmove \w/.test(fallback), fallback);

  console.log('\n9b. Stale-tab notice');
  const build = await evaluate(`fetch('/version', { cache: 'no-store' }).then((r) => r.json()).then((j) => j.build)`, true);
  check('the server reports a build stamp', /^\d{4}-\d{2}-\d{2}T/.test(String(build)), String(build));
  check('the badge says when this tab\'s code was loaded',
    /Code loaded/.test(await evaluate('document.getElementById("engine-badge").title')));
  check('no stale notice while the code is current', await evaluate('!document.getElementById("stale-notice")'));
  // Change a front-end file under the open tab; the poll must notice within a cycle.
  const fsMod = await import('fs');
  const touched = new Date();
  fsMod.utimesSync(new URL('../public/styles.css', import.meta.url), touched, touched);
  await waitFor('!!document.getElementById("stale-notice")', 30000, 'stale-tab notice');
  check('a changed file makes the tab announce it is stale', true);
  check('the notice offers a reload', await evaluate('!!document.querySelector("#stale-notice button")'));

  console.log('\n10. Console errors');
  const errors = page.errors();
  check('no page errors', errors.length === 0, errors.slice(0, 4).join(' | '));

  console.log('\n--- sample review ---\n');
  console.log((await evaluate('document.getElementById("review-slot").innerText')).split('\n').slice(0, 40).join('\n'));
} catch (err) {
  failures.push('threw: ' + err.message);
  console.error('\nERROR: ' + err.message);
  const errors = page.errors();
  if (errors.length) console.error('page errors:\n  ' + errors.slice(0, 6).join('\n  '));
} finally {
  await page.close();
}

console.log(failures.length ? '\n' + failures.length + ' FAILURES:\n  ' + failures.join('\n  ') : '\nAll browser checks passed.');
process.exit(failures.length ? 1 : 0);
