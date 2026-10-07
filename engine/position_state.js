/* Reconstruct complete positions only from a verified FEN or legal move history. */
(function (root) {
  const Rules = root.ChessRules || (typeof require === 'function' ? require('../vendor/chess.js').ChessRules : null);
  const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
  function createGame(fen = START) {
    const game = new Rules();
    if (!game.load(fen)) return null;
    const board = game.fen().split(' ')[0];
    return (board.match(/K/g) || []).length === 1 && (board.match(/k/g) || []).length === 1 ? game : null;
  }
  function uci(move) { return move.from + move.to + (move.promotion || ''); }
  class PositionState {
    constructor() { this.fen = null; this.transition = null; this.session = 0; }
    resolve(board, authoritativeFen = null, moves = []) {
      this.transition = null;
      let next = null;
      if (authoritativeFen) {
        const game = createGame(authoritativeFen);
        if (game && game.fen().split(' ')[0] === board) next = game.fen();
      }
      if (!next && moves.length) {
        const game = createGame();
        for (const san of moves) {
          if (!game.move(san, { sloppy: true })) break;
          if (game.fen().split(' ')[0] === board) next = game.fen();
        }
      }
      if (!next && this.fen) {
        const game = createGame(this.fen);
        if (game.fen().split(' ')[0] === board) return this.fen;
        for (const move of game.moves({ verbose: true })) {
          game.move(move);
          if (game.fen().split(' ')[0] === board) {
            next = game.fen();
            this.transition = { before: this.fen, after: next, move: uci(move), color: move.color };
            break;
          }
          game.undo();
        }
      }
      if (!next && board === START.split(' ')[0]) next = START;
      if (!next) return null;
      if (this.fen && next !== this.fen && !this.transition) {
        const previous = createGame(this.fen);
        for (const move of previous.moves({ verbose: true })) {
          previous.move(move);
          if (previous.fen() === next) {
            this.transition = { before: this.fen, after: next, move: uci(move), color: move.color };
            break;
          }
          previous.undo();
        }
        if (!this.transition) this.session++;
      }
      this.fen = next;
      return next;
    }
  }
  root.PositionState = PositionState;
  if (typeof module !== 'undefined') module.exports = { PositionState, createGame, START };
})(typeof globalThis !== 'undefined' ? globalThis : this);
