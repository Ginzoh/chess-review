/**
 * The "Explain" panel: a coaching breakdown of one move.
 *
 * Where insights.js writes a sentence, this writes a lesson - what happened, the
 * concept behind it, what to play instead and why, and something concrete to work
 * on. It runs entirely on the analysis already computed plus the pattern detectors
 * in concepts.js, so it works offline and never invents a motif it cannot see.
 */

import {
  Chess,
  uciToMove,
  captureGain,
  pieceName,
  materialPhrase,
  formatVariation,
  materialBalance,
  PIECE_VALUE
} from './chessutils.js';
import { describeMove, errorKind, formatEval, advantagePhrase } from './insights.js';
import {
  CONCEPTS,
  findPins,
  backRankRisk,
  trappedPieces,
  overloadedDefenders,
  developmentState,
  isLoose
} from './concepts.js';

/* ------------------------------------------------------------- helpers -- */

function joinList(items) {
  if (!items.length) return '';
  if (items.length === 1) return items[0];
  if (items.length === 2) return items[0] + ' and ' + items[1];
  return items.slice(0, -1).join(', ') + ' and ' + items[items.length - 1];
}

function moveLabel(move) {
  return move.moveNumber + (move.color === 'w' ? '.' : '...') + ' ' + move.san;
}

function sideName(color) {
  return color === 'w' ? 'White' : 'Black';
}

/** The opponent's punishing line, written out as a variation. */
function refutation(move) {
  if (!move.replyPvSan || !move.replyPvSan.length) return null;
  return formatVariation(move.fenAfter, move.replyPvSan.slice(0, 5));
}

/** The line the engine wanted, from the position before the move. */
function bestLine(move) {
  if (!move.bestPvSan || !move.bestPvSan.length) return null;
  return formatVariation(move.fenBefore, move.bestPvSan.slice(0, 5));
}

/* ------------------------------------------------- what actually happened -- */

/**
 * The concrete consequence of the move: what the opponent wins, or what the move
 * achieved. Returns { text, material, replySan }.
 */
function consequence(move) {
  const board = new Chess(move.fenAfter);
  if (!move.replyUci) return { text: null, material: 0, replySan: null };

  const reply = uciToMove(board, move.replyUci);
  if (!reply) return { text: null, material: 0, replySan: null };

  const replySan = new Chess(move.fenAfter).move({
    from: reply.from,
    to: reply.to,
    promotion: reply.promotion
  }).san;

  const gain = reply.captured ? captureGain(board, reply) : 0;
  return { text: null, material: gain, replySan: replySan, reply: reply };
}

/**
 * Follow the engine's refutation and find where material actually goes.
 *
 * The opponent's first reply is often quiet - the piece drops two or three moves
 * later. Reporting only the immediate reply produced explanations like "hands the
 * initiative over" for positions where a queen was plainly lost, so the line is
 * walked to the point where the material actually changes hands.
 *
 * @returns {{loss:number, san:string, movePair:string, fenBefore:string, square:string}|null}
 */
function materialLossInLine(move) {
  if (!move.replyPvSan || !move.replyPvSan.length) return null;

  const board = new Chess(move.fenAfter);
  const mover = move.color;
  const startBalance = mover === 'w' ? materialBalance(move.fenAfter) : -materialBalance(move.fenAfter);

  let worst = null;
  for (const san of move.replyPvSan) {
    const fenBefore = board.fen();
    let made;
    try {
      made = board.move(san);
    } catch (e) {
      break;
    }
    if (!made) break;

    const balance = mover === 'w' ? materialBalance(board.fen()) : -materialBalance(board.fen());
    const loss = startBalance - balance;
    // Only the opponent's captures count, and only once the dust has settled on
    // that exchange - a recapture on the next ply gives it back.
    if (made.color !== mover && made.captured && loss >= 1 && (!worst || loss > worst.loss)) {
      worst = {
        loss: loss,
        san: made.san,
        fenBefore: fenBefore,
        square: made.to,
        captured: made.captured,
        by: made.piece
      };
    }
  }
  return worst;
}

/* ------------------------------------------------------- concept picking -- */

/**
 * Decide which concept this move is really about, using the detectors rather than
 * the label alone. Returns { id, evidence } where evidence is a sentence naming
 * what was found on the board.
 */
function pickConcept(move, kind) {
  const mover = move.color;
  const opponent = mover === 'w' ? 'b' : 'w';
  const after = new Chess(move.fenAfter);
  const outcome = consequence(move);

  // Forced mate dominates everything else.
  if (kind === 'allowsMate') return { id: 'kingSafety', evidence: null };
  if (kind === 'missedMate') return { id: 'calculation', evidence: null };

  // Did the move hand over material, and if so through which motif? The loss may
  // land a few plies into the refutation, so look at the position where it happens.
  const deferred = materialLossInLine(move);
  const immediate = outcome.material >= 1 && outcome.reply;
  if (immediate || (deferred && deferred.loss >= 1)) {
    const target = immediate ? outcome.reply.to : deferred.square;
    const scene = immediate ? after : new Chess(deferred.fenBefore);
    const takenBy = immediate ? outcome.replySan : deferred.san;

    const pins = findPins(scene, mover).filter((p) => p.front.square === target);
    if (pins.length) {
      const p = pins[0];
      return {
        id: p.kind === 'skewer' ? 'skewer' : 'pin',
        evidence:
          'The ' + pieceName(p.front.type) + ' on ' + p.front.square + ' is ' +
          (p.kind === 'skewer' ? 'skewered' : 'pinned') + ' by the ' + pieceName(p.attacker.type) +
          ' on ' + p.attacker.square + ', with your ' + pieceName(p.back.type) + ' on ' + p.back.square + ' behind it.'
      };
    }

    // A capture landing where nothing defends is the plain loose-piece case.
    const defended = scene.attackers ? scene.attackers(target, mover).length : 0;
    if (!defended) {
      const piece = scene.get(target);
      return {
        id: 'hangingPiece',
        evidence: piece
          ? 'Your ' + pieceName(piece.type) + ' on ' + target + ' had no defender, and ' +
            takenBy + ' simply takes it.'
          : null
      };
    }

    // Defended, but by too little: a queen taken by a rook still loses material
    // even after the recapture.
    const victim = immediate ? outcome.reply.captured : deferred.captured;
    const taker = immediate ? outcome.reply.piece : deferred.by;
    if (victim && taker && PIECE_VALUE[victim] > PIECE_VALUE[taker]) {
      return {
        id: 'underDefended',
        evidence:
          'Your ' + pieceName(victim) + ' on ' + target + ' was defended, but only against an equal ' +
          'trade - ' + takenBy + ' takes it with a ' + pieceName(taker) + ', and winning the ' +
          pieceName(taker) + ' back still leaves you ' + materialPhrase(PIECE_VALUE[victim] - PIECE_VALUE[taker]) + ' down.'
      };
    }

    // Only an overload that involves this very square explains this loss; a defender
    // stretched somewhere else on the board is a different story.
    const overloads = overloadedDefenders(scene, mover)
      .filter((o) => o.duties.some((d) => d.square === target));
    if (overloads.length) {
      const o = overloads[0];
      return {
        id: 'overload',
        evidence:
          'Your ' + pieceName(o.type) + ' on ' + o.square + ' was defending ' +
          joinList(o.duties.map((d) => 'the ' + pieceName(d.type) + ' on ' + d.square)) +
          ' at the same time - one job too many.'
      };
    }

    return { id: 'hangingPiece', evidence: null };
  }

  // Nothing lost immediately: look for structural reasons.
  const backRank = backRankRisk(after, mover);
  if (backRank && (kind === 'allowsTactic' || move.winLoss >= 5)) {
    return {
      id: 'backRank',
      evidence:
        'Your king on ' + backRank.square + ' has no escape square - all the pawns in front of it ' +
        'are still on their starting squares, and the opponent still has ' +
        (backRank.heavy > 1 ? 'heavy pieces' : 'a heavy piece') + ' to invade with.'
    };
  }

  const trapped = trappedPieces(after, opponent === mover ? opponent : mover);
  if (trapped.length && move.winLoss >= 5) {
    return {
      id: 'trappedPiece',
      evidence: 'Your ' + pieceName(trapped[0].type) + ' on ' + trapped[0].square + ' has run out of safe squares.'
    };
  }

  if (kind === 'missedMaterial') return { id: 'missedMaterial', evidence: null };
  if (kind === 'missedWin') return { id: 'conversion', evidence: null };

  if (move.phase === 'opening') {
    const dev = developmentState(move.fenAfter, mover);
    if (dev.undeveloped >= 2) {
      return {
        id: 'development',
        evidence:
          'You still have ' + dev.undeveloped + ' minor pieces on their starting squares' +
          (dev.castled ? '' : ' and the king is not castled yet') + '.'
      };
    }
  }

  if (move.phase === 'endgame') return { id: 'endgameTechnique', evidence: null };
  if (kind === 'allowsTactic') return { id: 'prophylaxis', evidence: null };
  return { id: 'positional', evidence: null };
}

/* ------------------------------------------------------------- the coach -- */

/**
 * Build the full explanation for one move.
 *
 * @param {object} move      an entry from analysis.moves
 * @param {object} analysis  the whole analysis, for context around the move
 * @returns {{headline:string, sections:Array<{title:string, body:string, variation?:string}>}}
 */
export function coachMove(move, analysis) {
  const kind = move.isBest ? null : errorKind(move);
  const sections = [];
  const good = ['brilliant', 'great', 'best', 'excellent'].indexOf(move.label.key) !== -1;
  const played = describeMove(move.fenBefore, move.uci);
  const best = move.bestUci && move.bestUci !== move.uci ? describeMove(move.fenBefore, move.bestUci) : null;

  /* ---- headline ---- */

  const swing = Math.round(Math.abs(move.winAfter - move.winBefore));
  let headline;
  if (move.label.key === 'brilliant') {
    headline = 'A sacrifice that works — ' + moveLabel(move) + ' gives up material for something worth more.';
  } else if (move.label.key === 'great') {
    headline = moveLabel(move) + ' was the only move that held the position together.';
  } else if (good) {
    headline = moveLabel(move) + ' keeps everything on track.';
  } else if (move.label.key === 'forced') {
    headline = 'There was nothing to decide here — ' + move.san + ' was the only legal move.';
  } else if (move.label.key === 'missedWin') {
    headline =
      moveLabel(move) + ' lets a forced win slip' +
      (move.missedWin && move.missedWin.kind === 'mate' ? ' — there was mate in ' + move.missedWin.mateIn + '.' : '.');
  } else {
    const noun = move.label.key === 'blunder' ? 'a serious error'
      : move.label.key === 'mistake' ? 'a mistake' : 'an inaccuracy';
    headline = moveLabel(move) + ' is ' + noun + ', costing ' + swing + ' points of expected score.';
  }

  /* ---- what happened ---- */

  const whatParts = [];
  const outcome = consequence(move);

  if (good) {
    if (played && played.facts.length) {
      whatParts.push(move.san + ' ' + joinList(played.facts) + '.');
    } else {
      whatParts.push(move.san + ' is the move the engine plays here too.');
    }
    if (move.label.key === 'brilliant') {
      whatParts.push(
        'You gave up the ' + pieceName(move.piece) + ', and the engine still rates the position at ' +
        formatEval(move, move.evalAfterCp) + ' in your favour. The material comes back, or the attack is worth more than it.'
      );
    }
  } else if (move.label.key === 'missedWin' && move.missedWin && move.missedWin.kind === 'mate') {
    whatParts.push(
      'You had a forced mate in ' + move.missedWin.mateIn + '. After ' + move.san + ' it is gone - the engine still ' +
      'has you winning at ' + formatEval(move, move.evalAfterCp) + ', so the game is far from thrown away, but a win that was ' +
      'forced now has to be earned again, and every extra move is a chance for something to go wrong.'
    );
  } else if (move.label.key === 'missedWin') {
    whatParts.push(
      'The position was crushing at ' + formatEval(move, move.evalBeforeCp) + '. After ' + move.san + ' you keep a clear edge ' +
      'at ' + formatEval(move, move.evalAfterCp) + ', but the decisive continuation has been passed up.'
    );
  } else if (kind === 'allowsMate' && move.afterScore) {
    whatParts.push(
      'After ' + move.san + ' there is a forced mate in ' + move.afterScore.mate + '. Once a mating net closes ' +
      'it does not matter what else is on the board.'
    );
  } else if (outcome.replySan && outcome.material >= 1) {
    whatParts.push(
      move.san + ' allows ' + outcome.replySan + ', which wins ' + materialPhrase(outcome.material) + '.'
    );
  } else if (outcome.replySan) {
    const later = materialLossInLine(move);
    if (later) {
      // The reply itself is quiet, but the line ends with material changing hands.
      whatParts.push(
        move.san + ' allows ' + outcome.replySan + '. It looks quiet, but the line runs on: after ' +
        later.san + ' you are ' + materialPhrase(later.loss) + ' down.'
      );
    } else {
      whatParts.push(
        move.san + ' hands the initiative over. The engine answers ' + outcome.replySan + '.'
      );
    }
  }

  if (!good && move.label.key !== 'forced') {
    // Numbers are from White's side, like everywhere else on the page, so the same
    // figure appears here as in the move list.
    whatParts.push(
      'The evaluation went from ' + formatEval(move, move.evalBeforeCp) + ' to ' +
      formatEval(move, move.evalAfterCp) + ' — ' +
      advantagePhrase(move.color === 'w' ? move.evalAfterCp : -move.evalAfterCp) + '.'
    );
  }

  if (whatParts.length) {
    // Show the continuation of what was actually played, unless the move was the
    // engine's own choice - only then is the "best line" the same line.
    const showBest = move.isBest || move.label.key === 'missedWin';
    sections.push({
      title: 'What happened',
      body: whatParts.join(' '),
      variation: showBest ? bestLine(move) : refutation(move),
      variationFrom: showBest ? move.fenBefore : move.fenAfter
    });
  }

  /* ---- the concept ---- */

  const picked = pickConcept(move, kind);
  const concept = CONCEPTS[picked.id] || CONCEPTS.positional;

  if (!good && move.label.key !== 'forced') {
    sections.push({
      title: 'The idea behind it: ' + concept.name,
      body: [picked.evidence, concept.idea].filter(Boolean).join(' ')
    });
  }

  /* ---- what to play instead ---- */

  if (best) {
    const parts = [];
    if (kind === 'missedMate' && move.bestScore && move.bestScore.mate) {
      parts.push(move.bestSan + ' forces mate in ' + move.bestScore.mate + '.');
    } else if (best.facts.length) {
      parts.push(move.bestSan + ' ' + joinList(best.facts) + '.');
    } else {
      parts.push(move.bestSan + ' was the engine\'s choice.');
    }
    parts.push(
      'It holds the evaluation at ' + formatEval(move, move.evalBeforeCp) + ' instead of ' + formatEval(move, move.evalAfterCp) + '.'
    );

    // A runner-up is worth naming when it is nearly as good - it widens the lesson
    // from "find this move" to "here is the kind of move that works".
    if (move.secondScore && move.bestScore) {
      const gap = Math.abs((move.bestScore.cp || 0) - (move.secondScore.cp || 0));
      if (move.bestScore.mate === null && move.secondScore.mate === null && gap <= 40) {
        parts.push('It was not the only way — the engine\'s second choice was close behind.');
      }
    }

    sections.push({
      title: 'What to play instead',
      body: parts.join(' '),
      variation: bestLine(move),
      variationFrom: move.fenBefore
    });
  }

  /* ---- what to work on ---- */

  if (!good && move.label.key !== 'forced') {
    let body = concept.practise;
    const timeNote = rushNote(move, analysis);
    if (timeNote) body += ' ' + timeNote;
    sections.push({ title: 'Work on this', body: body });
  } else if (good) {
    // A strong move still deserves a reason - otherwise the panel says nothing at all
    // on the moves you got right, which is half the game.
    const body = played && played.facts.length
      ? 'Moves like this are pattern recognition, not calculation. The more positions you see where ' +
        joinList(played.facts) + ' is the point, the faster you will spot the next one.'
      : 'Nothing to fix here. ' + (move.isBest
          ? 'This was the top engine choice, and it keeps the position at ' + formatEval(move, move.evalAfterCp) + '.'
          : 'It gives away nothing measurable — the engine would have played ' + (move.bestSan || 'something similar') +
            ', which comes to much the same thing.') +
        ' Quiet accurate moves are what hold a game together between the sharp ones.';
    sections.push({ title: 'Why this works', body: body });
  }

  return { headline: headline, sections: sections, concept: picked.id, label: move.label.key };
}

/** If the move was rushed relative to the rest of the game, say so - it is often the cause. */
function rushNote(move, analysis) {
  if (!analysis || move.timeSpent === null || move.timeSpent === undefined) return null;
  const stats = analysis.stats[move.color];
  if (!stats || !stats.averageTime || !stats.hasClocks) return null;
  if (move.timeSpent > stats.averageTime * 0.5) return null;
  return (
    'You spent ' + move.timeSpent.toFixed(1) + 's on this move against an average of ' +
    stats.averageTime.toFixed(1) + 's — this one was played quickly, and that is often the real cause.'
  );
}
