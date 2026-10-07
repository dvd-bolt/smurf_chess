(function (root) {
  const Rules = root.ChessRules || (typeof require === 'function' ? require('../vendor/chess.js').ChessRules : null);
  const Profiles = root.PlayerProfiles || (typeof require === 'function' ? require('./player_profile.js') : null);
  function id() { return root.crypto?.randomUUID?.() || `game-${Date.now()}-${Math.random().toString(36).slice(2)}`; }
  function outcome(fen, color) {
    const game = new Rules();
    if (!game.load(fen)) return null;
    if (game.in_checkmate()) return { result: game.turn() === color ? 'loss' : 'win', termination: 'mate', resultSource: 'verified-fen' };
    if (game.in_stalemate() || game.insufficient_material()) return { result: 'draw', termination: 'draw', resultSource: 'verified-fen' };
    return null;
  }
  function fromResult(result, color, termination = 'site-result') {
    const normalized = String(result || '').trim().replace(/½/g, '1/2');
    if (normalized === '1/2-1/2') return { result: 'draw', termination, resultSource: 'site-result' };
    if (!['1-0', '0-1'].includes(normalized)) return null;
    const winner = normalized === '1-0' ? 'w' : 'b';
    return { result: winner === color ? 'win' : 'loss', termination, resultSource: 'site-result' };
  }
  function transitionBetween(before, after) {
    if (!before || before === after) return null;
    const game = new Rules();
    if (!game.load(before)) return null;
    for (const move of game.moves({ verbose: true })) {
      game.move(move);
      const matches = game.fen() === after;
      game.undo();
      if (matches) return { before, after, move: move.from + move.to + (move.promotion || ''), color: move.color };
    }
    return null;
  }
  class GameSession {
    constructor(saved = null) { this.data = saved; }
    begin(meta, options, offset = 0, fen = null) {
      const gameId = meta.sourceId ? `${meta.site}:${meta.sourceId}:${meta.playerColor}` : id();
      this.data = { schemaVersion: 1, id: gameId, ...meta, startedAt: Date.now(), result: 'unknown',
        profileSnapshot: Profiles.create({ ...options, adaptationOffset: offset }, gameId),
        completedMoves: 0, moveKeys: [], decisions: {}, planState: null, lastFen: fen };
      return this.data;
    }
    observe(transition) {
      if (!this.data || !transition) return;
      const key = transition.before + ':' + transition.after;
      if (this.data.moveKeys.includes(key)) return;
      this.data.moveKeys.push(key); this.data.moveKeys = this.data.moveKeys.slice(-400);
      this.data.completedMoves++; this.data.lastFen = transition.after;
    }
    remember(fen, result) {
      if (!this.data || !result?.move) return;
      // Derived complexity is recomputed; preserve the actual decision and evaluated candidates.
      const { complexity, ...compact } = result;
      this.data.decisions[fen] = JSON.parse(JSON.stringify(compact));
      const keys = Object.keys(this.data.decisions);
      if (keys.length > 120) delete this.data.decisions[keys[0]];
      if (result.planState) this.data.planState = result.planState;
    }
    select(fen, move, rank) {
      const result = this.data?.decisions[fen];
      if (result) Object.assign(result, { move, rank });
    }
    finish(result) {
      if (!this.data || this.data.result !== 'unknown' || !result) return null;
      Object.assign(this.data, result, { finishedAt: Date.now(), confidence: 'confirmed' });
      return this.record();
    }
    record() {
      const { decisions, moveKeys, planState, ...record } = this.data;
      return record;
    }
  }
  root.GameSession = GameSession;
  root.GameOutcomes = { outcome, fromResult, transitionBetween };
  if (typeof module !== 'undefined') module.exports = { GameSession, outcome, fromResult, transitionBetween };
})(typeof globalThis !== 'undefined' ? globalThis : this);
