# Chess Review

Search a Chess.com username, browse that player's games, and get a full engine-backed
review of any one of them: every move labelled and explained, plus a written report on
what the player did well, what went wrong, and where the game turned.

Analysis runs entirely on your machine — Stockfish 18 compiled to WebAssembly, inside the
browser. Nothing about the games is sent anywhere except the public Chess.com API calls
that fetch them.

## Credits

Chess pieces are the Cburnett set from Wikimedia Commons, licensed
[CC BY-SA 3.0](https://creativecommons.org/licenses/by-sa/3.0/), obtained through the
MIT-licensed [cm-chessboard](https://github.com/shaack/cm-chessboard) package. The engine
is [Stockfish](https://stockfishchess.org/) (GPLv3) compiled to WebAssembly by
[stockfish.js](https://github.com/nmrugg/stockfish.js).

## Running it

```sh
yarn install
yarn start
```

Then open <http://localhost:5173>.

Search a username (try `hikaru`), pick a month, click a game, and press **Review this game**.

## Online version

The app is also published at <https://ginzoh.github.io/chess-review/> — every push to
`main` rebuilds and redeploys it (`.github/workflows/pages.yml`). Nothing runs on a
server there: the engine is WebAssembly in your browser, Chess.com's public API allows
cross-origin reads so the front end calls it directly, and a small service worker
(`public/coi.js`) adds the cross-origin-isolation headers a static host cannot, so the
multi-threaded engine still works. `scripts/build-static.mjs` assembles the build
(copies `public/`, the Stockfish files, and flips `public/js/config.js` to static mode);
`scripts/statictest.mjs` serves that build the way GitHub Pages does — plain files,
under a sub-path, no headers — and drives it in a headless browser.

## Games against bots

Chess.com's public API does **not** publish games played against its bots. They live in a
separate "vs Computer" archive that only the logged-in account can see, so they never
appear in `/pub/player/{user}/games/...` — rated or unrated — and no username search can
reach them. (Verified: the JSON and PGN archive endpoints return identical game counts,
the game object has no computer flag, and a scan of 2,093 games across 25 accounts turned
up no bot opponents.)

The way in is the PGN. On Chess.com open the bot game and use **Share → PGN**, or the
download button in your archive, then paste it into the **Or paste a PGN** box on the home
page. The review is identical — the same engine, labels and written report. Multi-game
PGNs (Chess.com's "Download all games") are listed so you can pick one.

This also works for any other PGN: Lichess exports, tournament files, or a game you typed
out by hand. Missing headers are fine; a bare move list still reviews.

## What the review gives you

**Per move** — a label (Brilliant, Great, Best, Excellent, Good, Inaccuracy, Mistake,
Blunder, Missed win, Forced), shown in the move list and as a badge on the square the
move landed on; the evaluation before and after; and a sentence explaining it in board
terms: what the move allowed, what the better move would have done, whether it hung a
piece, missed free material, or walked into mate.

**An analysis board, not just a replay.** The pieces move — click or drag — from any
position, and the app follows you into the variation: a strip under the board lists the
moves you have played, the arrow keys step through them, and *Back to game* (or Escape)
returns you to where you branched off. Playing a move from the middle of a variation
discards what came after it, as on Lichess. The move list keeps marking the game position
you left from.

**Two tabs beside the board.** The right-hand column is split into **Moves** (engine
lines, evaluation graph, move list) and **Report** (accuracy, the move breakdown and the
written review), and scrolls on its own, so the board never leaves the screen however
long the report is. Finishing a review opens the Report tab.

**Engine lines** — the top three lines for whatever is on the board, with an evaluation
and the continuation, deepening live (the panel shows the depth reached). Every move in a
line is clickable and plays the line up to that point as a variation. This runs from the
moment a game opens — before the full review — and the evaluation bar follows it, so you
get an instant read on any position. The switch on the panel turns it off, and the choice
is remembered. While a full review runs the live search pauses, since it is the same
engine.

**Played like ~1750** — an estimated rating for each side's play in that one game,
the equivalent of Chess.com's game-review rating. Shown under each accuracy score and
beside the board, with a range.

It answers *"what rating typically plays like this?"* For each rating band we measured
the accuracy its players actually post (25th percentile, median, 75th) on **16,000 real
rated games** (`scripts/harvest-ratings.mjs`; Chess.com publishes its own accuracy and
both players' ratings for nearly every game), then inverted those curves
(`scripts/build-rating-table.mjs`). The median curve gives the number; the quartile
curves give the range — the lowest rating for which this was a good game and the
highest for which it was a poor one.

Measured per 400-point band from 100 to 3400, the median estimate lands within about
50 points of the band it came from, for both blitz and rapid. A typical 500-rated game
reads as ~500; a typical 2000 game as ~2000. One game is still noisy (median error ~520
rapid, ~710 blitz), which is what the range is for.

*An earlier version got this wrong in two ways, both since fixed.* It estimated the
most likely rating given the accuracy — which is biased toward the population middle
for every individual (a 500 playing normally was told ~850) — and it was calibrated on
a sample balanced across rating bands, which made the population look uniform when 68%
of real players are under 1200. Together those flattered low-rated players by several
hundred points.

**Bullet is not estimated.** Its accuracy-by-rating curve is nearly flat and not even
monotone in the middle (1600–1999 bullet players came out at ~1100), so no single
bullet game reads as anything.

**Missed wins.** A move that throws away a forced mate — or lets one stretch by three
moves or more — while the position stays clearly winning is labelled **Missed win**,
counted against accuracy, and grouped in *What to work on*. This needed two things:

- *The label itself.* Above roughly +8 the win-probability curve is flat, so without
  it a missed mate-in-7 scored as "Excellent".
- *Seeing the mate at all.* On real games that ended in checkmate, the winner's
  positions in the last six moves showed a mate score only **43% of the time at depth
  12 and 51% at depth 16** — the engine simply did not know most of those wins existed.
  Searching everything deeper is 15× slower, so instead a **mate hunt** re-examines
  only positions where the side to move is already clearly winning (≥ +5), with a
  deeper, time-capped search. Chosen against a depth-28 oracle
  (`scripts/matehunt-recall.mjs`): depth+10 capped at 2.5s recovered **10 of 10** mates
  the shallow pass had missed, at ~1.4s each on one thread. Only a handful of positions
  per game qualify, and the hunt is capped at 18, so it adds seconds, not minutes.

**Accuracy is on Chess.com's scale.** Per-move accuracy starts from the standard
expected-score model (a mistake in a balanced position costs far more than the same
centipawn drop in a decided one), but that model alone runs far too kind once a game is
decided: every move in a lost position scores near 100, so a player who got crushed can
still read 85%. Three corrections fix that, all chosen by measurement rather than taste
(`scripts/accuracy-lab.mjs` scores every candidate formula against Chess.com's own figure
on a fixed set of real games, with the game that prompted the work held out):

- a **centipawn floor** — a move can never lose less than 4 accuracy-loss points per pawn
  it gives away, however lopsided the position already was (evaluations clamped at ±15);
- a **plain mean** over moves rather than the volatility-weighted blend, which was
  punishing swingy games twice;
- a **cap of 80** on any move made while already inside a forced mate. When every move
  loses, "best" only means slowest. The general set has almost no such games, so this
  was judged on a separate set of 30 checkmate games (`scripts/harvest-mated-games.mjs`):
  sides that made three or more such moves read 7.4 points too kind without the cap and
  1.0 too harsh with it. The label is unchanged — only the score.

Together they take the correlation with Chess.com's figure from 0.87 to **0.96**; 65 of
68 player-games land within 10 points after a fixed linear map (1.94x − 93) onto their
scale, and on the checkmate set 58 of 60. The map is applied so the displayed figure is
directly comparable; the figure before the map is kept as `rawAccuracy`. Our engine is
newer than the one behind Chess.com's reviews and sometimes finds a missed win theirs
did not, so a few points of difference on a given game is expected — the neighbourhood
is what matters for the rating estimate.

**Explain** — every move has an *Explain this move* button under the board that opens a
coaching breakdown rather than a one-liner:

- **What happened** — the consequence, followed through the engine's line rather than
  stopping at the immediate reply. A quiet-looking move that drops a queen three plies
  later is reported as dropping a queen.
- **The idea behind it** — the concept actually at work, named only when it was found on
  the board: pins and skewers by walking the ray, loose pieces by static exchange
  evaluation, overloaded defenders by counting duties on the square that fell, plus
  back-rank, trapped pieces, king safety, development and endgame themes.
- **What to play instead** — the engine's move, what it does in board terms, and the line.
- **Work on this** — concrete training advice tied to that concept, and a note when the
  move was played much faster than your average, since that is often the real cause.

Every quoted line is clickable and opens on the board as a variation, playing itself out
move by move; from there you can step through it, play on, or go back to the game.

The coach never names a motif it cannot detect. Where nothing specific is found it says
so plainly rather than inventing a theme, because a coach that guesses teaches the wrong
lesson. It runs locally like everything else — no data leaves the machine.

**Who is winning** — every move in the list carries its evaluation as a number, always
from White's point of view, so the sign alone tells you who is ahead (`+1.24` White,
`-0.80` Black, `M3` mate in three). The commentary panel under the board spells the same
number out: **`+1.24` White is better · White 68%**, where the percentage is White's
expected score. The bar beside the board shows it graphically.

**Per game** — accuracy for both players, a move-quality breakdown, an evaluation graph,
accuracy split by opening/middlegame/endgame, and a written review with four parts:

- **What you did well** — sacrifices found, only-moves found, accurate streaks, opponent
  mistakes punished, positions defended, wins converted.
- **What to work on** — your three worst moves fully explained, missed chances, and any
  *repeating* pattern across the game (e.g. "you left pieces undefended at moves 14, 22
  and 31") with concrete advice for that pattern.
- **Turning points** — the moves, by either player, where the game actually swung.
- **Clock** — how time was spent, and whether the serious errors were the fast ones.

Switch which player is being reviewed with the toggle above the move list.

## Look and feel

The board and the whole shell are dark-themed, tuned so long analysis sessions do not
tire the eyes: layered surfaces instead of one flat near-black, text that tops out at
`#dfe4ec` rather than pure white, and desaturated move-grade colours.

**Board colours** are switchable from the swatches under the board — Slate (default),
Walnut, Forest and Dusk. The choice is remembered in the browser.

**Pieces** are vector art, not text glyphs: the Cburnett set from Wikimedia Commons, used
under [CC BY-SA 3.0](https://creativecommons.org/licenses/by-sa/3.0/), vendored at
`public/assets/pieces.svg` via the MIT-licensed
[cm-chessboard](https://github.com/shaack/cm-chessboard) package. The sprite is injected
once and each square references a piece by id.

**Captured material** is shown beside each player's name as light silhouettes with the
material lead (`+3`), updating as you step through the game.

**Contrast is measured, not eyeballed.** `scripts/contrast.mjs` walks the rendered review
page, works out the background actually painted behind every piece of text (including
translucent layers and inherited opacity), and reports the WCAG ratio. Every text style
currently clears AA — 4.5:1 for body text, 3:1 for large. Run it after any colour change.

## How it works

| Piece | What it does |
| --- | --- |
| `server.js` | Serves the front end, proxies and caches the Chess.com API, and sets the COOP/COEP headers that unlock `SharedArrayBuffer` so the multi-threaded engine can run. |
| `public/js/engine.js` | Promise-based UCI client over the Stockfish worker. Uses the multi-threaded build when the page is cross-origin isolated, single-threaded otherwise. `analyse()` for the review, `analyseStream()` for the live lines (reports as it deepens, can be stopped). |
| `public/js/live.js` | The live engine lines: one streaming multi-PV search following the board, serialised so searches never overlap, paused while the review runs. |
| `public/js/analysis.js` | Searches every position once (N+1 searches for N moves), then hunts deeper for forced mates where a side is clearly winning; converts scores to expected-score loss, classifies each move (incl. Missed win), computes calibrated accuracy and phases. |
| `public/js/insights.js` | Turns that into English — the per-move explanations and the whole-game review. |
| `public/js/chessutils.js` | Static exchange evaluation, material counting, fork/hanging-piece detection: the board facts the sentences are built from. |
| `public/js/api.js` | Chess.com API client, plus the PGN importer that turns pasted text into the same game shape — so bot games and API games share one code path. |
| `public/js/rating.js` | The "played like" estimate: accuracy-by-rating curves inverted, and the rules for when not to guess. |
| `public/js/concepts.js` | Pattern detection (pins, skewers, back rank, trapped pieces, overloads, development) and the catalogue of concepts with training advice. |
| `public/js/coach.js` | Builds the Explain breakdown: what happened, the concept, the better move, what to work on. |
| `public/js/board.js` | Board rendering, the best-move arrow, label badges, click-and-drag move input with legal-move dots, and the sliding-piece animation (worked out by diffing the two positions, so castling, en passant and promotion all animate, forwards and backwards). |
| `public/js/app.js` | Routing, UI, board themes, and the captured-material strip. |

Accuracy uses the logistic expected-score model with a centipawn floor — see *What the
review gives you* above for why the floor is needed and how the formula was chosen.

## Depth

The depth selector trades time for reliability:

- **Fast (12)** — a few seconds for a blitz game; occasionally misses a deep tactic.
- **Balanced (16)** — the default.
- **Deep (20)** — slowest, and the one to use if a label looks wrong.

A shallow search can label a move a blunder because it only finds the refutation one ply
later; if something reads oddly, re-run it deeper.

## Tests

```sh
node scripts/selftest.mjs [username]   # real game from the API through the whole pipeline
node scripts/pgntest.mjs               # fixed PGNs: sacrifices, forced mates, hung pieces
node scripts/boardtest.mjs             # move-animation diff: castling, en passant, promotion
node scripts/ratingtest.mjs            # "played like" estimator: per-band bias vs 16,000 real games
node scripts/conceptstest.mjs          # pin/skewer/back-rank/overload detectors on known positions
node scripts/coachtest.mjs             # the Explain panel over fixture games, incl. legality of every line
node scripts/browsertest.mjs           # drives the real UI in headless Edge/Chrome
node scripts/statictest.mjs            # the GitHub Pages build: sub-path, no headers, service worker
node scripts/contrast.mjs              # WCAG contrast of every text style on the review page
node scripts/screenshot.mjs            # writes shot-*.png of each screen
```

The browser scripts need the server running and use Edge or Chrome via the DevTools
protocol. `DEPTH=10` makes the engine-driven ones quicker.

Calibration (already done; the results are baked into `public/js/rating.js`):

```sh
node scripts/harvest-ratings.mjs --natural   # (rating, accuracy) pairs, real population
node scripts/harvest-ratings.mjs             # same, balanced across bands (coverage of strong players)
node scripts/build-rating-table.mjs          # accuracy-by-rating curves + per-band bias report
node scripts/fit-rating.mjs                  # the regression models that were tried and rejected
node scripts/calibrate-depths.mjs 44 12      # our accuracy vs Chess.com's on a fixed game set
node scripts/accuracy-lab.mjs                # every candidate accuracy formula vs Chess.com's, game by game
node scripts/harvest-mated-games.mjs 30      # checkmate games: how moves inside a forced mate are scored
node scripts/analyse-set.mjs scripts/data/mated-games.json scripts/data/mated-moves.json 12
node scripts/mate-detection.mjs              # how often each depth sees mates that exist
node scripts/matehunt-recall.mjs             # mate-hunt settings against a deep oracle
```
