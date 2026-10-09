/* Legal candidates proposed by visible chess motives, independently of engine rank. */
(function (root) {
  const Rules = root.ChessRules || require('../vendor/chess.js').ChessRules;
  const Styles = root.PersonaStyles || require('./personas.js');
  const values = { p: 100, n: 320, b: 330, r: 500, q: 900, k: 0 };
  const uci = move => move.from + move.to + (move.promotion || '');
  const central = square => 7 - Math.abs(square.charCodeAt(0) - 100.5) - Math.abs(Number(square[1]) - 4.5);
  function evaluate(game, color) {
    const pieces = game.board().flat().filter(Boolean);
    const endgame = pieces.reduce((sum, p) => sum + values[p.type], 0) < 2600;
    return pieces.reduce((sum, p) => {
      const advance = p.color === 'w' ? Number(p.square[1]) - 2 : 7 - Number(p.square[1]);
      const activity = p.type === 'p' ? advance * 7 + central(p.square) * 3 :
        p.type === 'n' ? central(p.square) * 12 : p.type === 'b' ? central(p.square) * 7 :
          p.type === 'r' ? advance * 2 : p.type === 'q' ? central(p.square) * 2 : endgame ? central(p.square) * 12 : -central(p.square) * 8;
      return sum + (p.color === color ? 1 : -1) * (values[p.type] + activity);
    }, 0);
  }
  function generate(fen, { limit = 12, plan = null } = {}) {
    const game = new Rules(fen), color = game.turn(), inCheck = game.in_check();
    const material = game.board().flat().filter(Boolean).reduce((sum, p) => sum + values[p.type], 0);
    const before = evaluate(game, color), fullmove = Number(fen.split(' ')[5]);
    const exposedBefore = Styles.exposedMaterial(game, color);
    const candidates = game.moves({ verbose: true }).map(move => {
      const reasons = [], features = {}, key = uci(move);
      const home = color === 'w' ? '1' : '8';
      const endangered = move.piece !== 'k' && Styles.attacked(game, move.from, color === 'w' ? 'b' : 'w');
      features.isCapture = !!move.captured;
      features.isMinorDev = ['n', 'b'].includes(move.piece) && move.from[1] === home && move.to[1] !== home;
      features.isEarlyQueen = move.piece === 'q' && fullmove <= 10 && !move.captured;
      features.isCentral = central(move.to) > central(move.from);
      features.isKingActive = material < 2600 && move.piece === 'k' && features.isCentral;
      features.isCastle = /[kq]/.test(move.flags);
      game.move(move);
      features.isCheck = game.in_check();
      features.isProphylaxis = endangered && !Styles.attacked(game, move.to, game.turn());
      features.isPassedPawn = move.piece === 'p' && material < 2600 && !game.board().flat().some(p => p && p.type === 'p' && p.color !== color &&
        Math.abs(p.square.charCodeAt(0) - move.to.charCodeAt(0)) <= 1 && (color === 'w' ? p.square[1] > move.to[1] : p.square[1] < move.to[1]));
      features.isStructure = move.piece === 'p' && ['c', 'd', 'e', 'f'].includes(move.to[0]);
      const staticCp = evaluate(game, color);
      game.undo();
      let priority = (staticCp - before) * 0.3;
      if (inCheck) { reasons.push('защита от шаха'); priority += 35; }
      if (features.isCapture) { reasons.push('взятие или размен'); priority += 35 + values[move.captured] * 0.08; }
      if (features.isMinorDev) { reasons.push('развитие фигуры'); priority += 35; }
      if (features.isCastle) { reasons.push('рокировка'); priority += 65; }
      if (features.isProphylaxis) { reasons.push('спасти атакованную фигуру'); priority += 60; }
      if (features.isPassedPawn) { reasons.push('продвижение проходной'); priority += 35; }
      if (features.isCheck) { reasons.push('шах'); priority += 25; }
      if (features.isCentral || features.isKingActive) { reasons.push('улучшение фигуры'); priority += 15; }
      if (features.isStructure) { reasons.push('пешечный центр'); priority += 15; }
      if (features.isEarlyQueen && !features.isCheck) priority -= 45;
      if (plan?.nextMove === key || (plan?.pieceSquare === move.from && (move.to === plan.targetSquare || features.isCentral))) { reasons.push('продолжение плана'); priority += 45; }
      if (move.promotion) { reasons.push('превращение пешки'); priority += 100; }
      if (!reasons.length) reasons.push('манёвр');
      return { uci: key, move, features, originReasons: reasons, staticCp, priority };
    }).sort((a, b) => b.priority - a.priority || a.uci.localeCompare(b.uci));
    // Reserve quiet alternatives: captures alone must not fill the whole candidate set.
    const chosen = candidates.slice(0, Math.max(1, limit - 2));
    for (const item of candidates.filter(c => !c.features.isCapture && !c.features.isCheck).slice(0, 2)) {
      if (!chosen.some(c => c.uci === item.uci)) chosen.push(item);
    }
    for (const item of candidates) { if (chosen.length >= limit) break; if (!chosen.some(c => c.uci === item.uci)) chosen.push(item); }
    return { candidates: chosen.slice(0, limit), all: candidates, color, inCheck, endgame: material < 2600, beforeCp: before, exposedBefore };
  }
  const api = { generate, evaluate, values, uci };
  root.HumanCandidates = api;
  if (typeof module !== 'undefined') module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
