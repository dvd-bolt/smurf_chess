(function (root) {
  const Rules = root.ChessRules || (typeof require === 'function' ? require('../vendor/chess.js').ChessRules : null);
  const values = { p: 100, n: 320, b: 330, r: 500, q: 900, k: 20000 };
  function score(value) {
    if (value?.unit === 'mate') return value.value > 0 ? 20000 - value.value * 100 : value.value < 0 ? -20000 - value.value * 100 : 0;
    return Number(value?.value) || 0;
  }
  function inspect(fen, lines = [], remainingSeconds = null, familiar = false) {
    const game = new Rules();
    if (!game.load(fen)) return { level: 1, legalMoves: [], candidates: {}, inCheck: false };
    const legalMoves = game.moves({ verbose: true });
    const candidates = {};
    for (const line of lines) {
      const move = legalMoves.find(item => item.from + item.to + (item.promotion || '') === line.uci);
      if (!move) continue;
      game.move(move);
      const replies = game.moves({ verbose: true });
      const recapture = replies.some(reply => reply.to === move.to && reply.captured);
      const givesCheck = game.in_check();
      const mateOne = game.in_checkmate();
      let sharp = 0, length = 0;
      for (const uci of (line.pv || []).slice(1, 7)) {
        const reply = game.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
        if (!reply) break;
        length++;
        if (reply.captured || /[+#]/.test(reply.san)) sharp++;
      }
      game.load(fen);
      const obviousCapture = !!move.captured && !recapture && !move.promotion && !replies.some(reply => reply.san.includes('#'));
      const sacrifice = recapture && (!move.captured || values[move.piece] > values[move.captured]);
      const quiet = !move.captured && !givesCheck;
      candidates[line.uci] = { mateOne, obviousCapture, sacrifice, givesCheck, promotion: !!move.promotion,
        recognizability: mateOne || obviousCapture ? 3 : sacrifice ? 0.45 : quiet && sharp >= 3 ? 0.6 : 1,
        difficulty: Math.min(1, (sacrifice ? 0.4 : 0) + sharp * 0.12 + (quiet && length >= 4 ? 0.15 : 0)),
        immediateRisk: replies.some(reply => reply.san.includes('#')),
        isTactical: sacrifice || sharp >= 3 || !!move.promotion };
    }
    const sorted = lines.slice().sort((a, b) => score(b.score) - score(a.score));
    const gap = sorted.length > 1 ? score(sorted[0].score) - score(sorted[1].score) : 0;
    const inCheck = game.in_check();
    const material = game.board().flat().filter(Boolean).reduce((sum, item) => sum + (item.type === 'k' ? 0 : values[item.type]), 0);
    const level = Math.min(1, (inCheck ? 0.35 : 0) + (gap < 35 && sorted.length > 1 ? 0.25 : 0) +
      Math.max(0, ...Object.values(candidates).map(item => item.difficulty)));
    return { level, inCheck, legalMoves, candidates, gap, endgame: material < 2600, familiar,
      timeTrouble: Number.isFinite(remainingSeconds) && remainingSeconds <= 30 };
  }
  root.PositionComplexity = { inspect, score, values };
  if (typeof module !== 'undefined') module.exports = root.PositionComplexity;
})(typeof globalThis !== 'undefined' ? globalThis : this);
