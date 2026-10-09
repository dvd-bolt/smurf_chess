/* Transparent, bounded style biases applied after the safety filter. */
(function (root) {
  const Rules = root.ChessRules || (typeof require === 'function' ? require('../vendor/chess.js').ChessRules : null);
  const PERSONAS = Object.freeze({
    balanced: { name: 'Баланс', icon: '⚡', description: 'Сбалансированная игра с учётом силы и понимания позиции.' },
    tal: { name: 'Таль', icon: '⚔️', description: 'Предпочитает инициативу, атаки и активные продолжения.' },
    karpov: { name: 'Карпов', icon: '🛡️', description: 'Развитие, крепкая пешечная структура и профилактика.' },
    capablanca: { name: 'Капабланка', icon: '👑', description: 'Размен ферзей при перевесе, активный король и проходные.' }
  });
  function normalizePersona(value) { return Object.hasOwn(PERSONAS, value) ? value : 'balanced'; }
  function attacked(game, target, color) {
    const tx = target.charCodeAt(0) - 97, ty = Number(target[1]);
    return game.board().flat().some(piece => {
      if (!piece || piece.color !== color) return false;
      const x = piece.square.charCodeAt(0) - 97, y = Number(piece.square[1]);
      const dx = tx - x, dy = ty - y;
      if (!dx && !dy) return false;
      if (piece.type === 'p') return Math.abs(dx) === 1 && dy === (color === 'w' ? 1 : -1);
      if (piece.type === 'n') return Math.abs(dx) * Math.abs(dy) === 2;
      if (piece.type === 'k') return Math.max(Math.abs(dx), Math.abs(dy)) === 1;
      const diagonal = Math.abs(dx) === Math.abs(dy), straight = dx === 0 || dy === 0;
      if (!(piece.type === 'b' ? diagonal : piece.type === 'r' ? straight : diagonal || straight)) return false;
      const length = Math.max(Math.abs(dx), Math.abs(dy));
      for (let step = 1; step < length; step++) {
        if (game.get(String.fromCharCode(97 + x + Math.sign(dx) * step) + (y + Math.sign(dy) * step))) return false;
      }
      return true;
    });
  }
  function exposedMaterial(game, color) {
    const values = { n: 320, b: 330, r: 500, q: 900 };
    const enemy = color === 'w' ? 'b' : 'w';
    return game.board().flat().reduce((sum, p) => sum + (p && p.color === color && values[p.type] && attacked(game, p.square, enemy) && !attacked(game, p.square, color) ? values[p.type] : 0), 0);
  }
  function features(fen, uci, pv = []) {
    const result = { isCheck: false, isCapture: false, isQueenTrade: false, isMinorDev: false,
      isKingActive: false, isStructure: false, isEarlyQueen: false, isPassedPawn: false, isCentral: false,
      isProphylaxis: false, isPawnSacrifice: false };
    if (!fen || !uci || !Rules) return result;
    const game = new Rules();
    if (!game.load(fen)) return result;
    const before = game.board().flat().filter(Boolean);
    const values = { n: 320, b: 330, r: 500, q: 900 };
    const material = before.reduce((sum, p) => sum + (values[p.type] || 0), 0);
    const endgame = material <= 2600;
    const queenCount = before.filter(p => p.type === 'q').length;
    const color = game.turn();
    const exposedBefore = exposedMaterial(game, color);
    const move = game.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
    if (!move) return result;
    const centerDistance = square => Math.abs(square.charCodeAt(0) - 97 - 3.5) + Math.abs(Number(square[1]) - 4.5);
    const home = move.color === 'w' ? '1' : '8';
    result.isCheck = game.in_check();
    result.isCapture = !!move.captured;
    result.isCentral = centerDistance(move.to) < centerDistance(move.from);
    result.isMinorDev = ['n', 'b'].includes(move.piece) && move.from[1] === home && move.to[1] !== home;
    result.isKingActive = endgame && move.piece === 'k' && result.isCentral;
    result.isEarlyQueen = move.piece === 'q' && Number(fen.split(' ')[5]) <= 10 && !result.isCapture && !result.isCheck;
    result.isProphylaxis = exposedMaterial(game, color) < exposedBefore;
    if (move.piece === 'p') {
      const friendlyPawns = game.board().flat().filter(p => p && p.type === 'p' && p.color === move.color);
      const file = move.to.charCodeAt(0);
      result.isStructure = friendlyPawns.some(p => p.square !== move.to && Math.abs(p.square.charCodeAt(0) - file) === 1 && Math.abs(Number(p.square[1]) - Number(move.to[1])) <= 1);
      const enemy = game.board().flat().filter(p => p && p.type === 'p' && p.color !== move.color);
      result.isPassedPawn = endgame && !enemy.some(p => Math.abs(p.square.charCodeAt(0) - file) <= 1 && (move.color === 'w' ? Number(p.square[1]) > Number(move.to[1]) : Number(p.square[1]) < Number(move.to[1])));
    }
    // A queen capture alone is not a queen trade. Verify the legal PV reply.
    if (pv[0] === uci && pv[1]) {
      const reply = pv[1];
      const response = game.move({ from: reply.slice(0, 2), to: reply.slice(2, 4), promotion: reply[4] });
      if (response) {
        result.isQueenTrade = queenCount === 2 && game.board().flat().filter(p => p && p.type === 'q').length === 0;
        if (response.captured === 'p' && !move.captured && pv[2]) {
          const next = pv[2];
          const continuation = game.move({ from: next.slice(0, 2), to: next.slice(2, 4), promotion: next[4] });
          result.isPawnSacrifice = !!continuation && (game.in_check() || (!!continuation.captured && continuation.to !== response.to));
        }
      }
    }
    return result;
  }
  function modifier(persona, f, evalCp) {
    switch (normalizePersona(persona)) {
      case 'tal': return f.isCheck || f.isCapture || f.isPawnSacrifice ? 1.35 : 1;
      case 'karpov': return f.isEarlyQueen ? 0.75 : (f.isMinorDev || f.isStructure || f.isCentral || f.isProphylaxis ? 1.30 : 1);
      case 'capablanca': return (f.isQueenTrade && evalCp >= 100 ? 1.40 : 1) * (f.isKingActive || f.isPassedPawn ? 1.30 : 1);
      default: return 1;
    }
  }
  const api = { PERSONAS, normalizePersona, features, modifier, attacked, exposedMaterial };
  root.PersonaStyles = api;
  if (typeof module !== 'undefined') module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
