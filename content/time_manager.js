/** Position-aware clock budget. Re-analysis keeps the original turn start. */
const TimingChess = typeof ChessRules !== 'undefined' ? ChessRules :
  (typeof require === 'function' ? require('../vendor/chess.js').ChessRules : null);
class TimeManager {
  constructor({ random = Math.random, now = Date.now } = {}) {
    this.random = random; this.now = now; this.intervalId = null; this.isReady = false;
    this.turn = null; this.rhythm = 1;
  }
  reset() { this.stopTimer(); this.turn = null; this.rhythm = 1; }
  beginTurn(fen, lastMove = null) {
    if (this.turn?.fen === fen) {
      if (lastMove) this.turn.lastMove = lastMove;
      return this.turn;
    }
    this.rhythm = this.rhythm * 0.4 + (0.92 + this.random() * 0.16) * 0.6;
    this.turn = { fen, startedAt: this.now(), lastMove,
      jitter: (0.8 + (this.random() + this.random()) * 0.2) * this.rhythm,
      pause: this.random() < 0.08 };
    return this.turn;
  }
  parseClockText(text) {
    if (typeof text !== 'string') return null;
    const clean = text.trim().replace(/[^\d:.]/g, '');
    if (!clean) return null;
    const parts = clean.split(':').map(Number);
    if (parts.length > 3 || parts.some(value => !Number.isFinite(value))) return null;
    return parts.reduce((sum, value) => sum * 60 + value, 0);
  }
  readClockFromDom(playerColor = 'white', isFlipped = false) {
    const bottom = (playerColor === 'white') !== isFlipped;
    const side = bottom ? 'bottom' : 'top';
    // An active clock can belong to the opponent: prefer explicit color and board orientation.
    const selectors = [`[data-cy="${playerColor}-player-clock"] .clock-time`,
      `[data-cy="${playerColor}-player-clock"]`, `#clock-${playerColor}`, `.test-clock-${playerColor}`,
      `.player-component.${side} .clock-time`, `.player-tagline.${side} .clock-time`,
      `.player-${side} .clock-time`, `.clock-${side} .clock-time`, `.clock-${side}`,
      `.rclock-${side} .time`, `.rclock-${side}`];
    for (const selector of selectors) {
      const value = this.parseClockText(document.querySelector(selector)?.textContent);
      if (value !== null) return value;
    }
    const clocks = document.querySelectorAll('.clock-time');
    return clocks.length === 2 ? this.parseClockText(clocks[bottom ? 1 : 0].textContent) : null;
  }
  classify({ fen, move, isBook = false, isTactical = false, moveNumber = 1, lines = [], lastMove = null, complexity = null }) {
    if (!fen || !move || !TimingChess) return isBook ? 'book' : isTactical ? 'complex' : moveNumber <= 7 ? 'opening' : 'normal';
    const game = new TimingChess(fen);
    const legal = game.moves({ verbose: true });
    const selected = legal.find(item => item.from + item.to + (item.promotion || '') === move);
    if (!selected) return 'normal';
    if (legal.length === 1 || selected.san.includes('#')) return 'forced';
    if (isBook) return 'book';
    const shared = complexity?.candidates?.[move];
    if (shared?.obviousCapture) return 'capture';
    if (shared?.isTactical || complexity?.inCheck) return 'complex';
    const inCheck = game.in_check();
    game.move(selected);
    const recaptured = game.moves({ verbose: true }).some(reply => reply.to === selected.to && reply.captured);
    const values = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 100 };
    const previousTo = typeof lastMove === 'string' ? lastMove.slice(2, 4) : lastMove?.to;
    const favorable = selected.captured && values[selected.captured] >= values[selected.piece];
    const line = lines.find(item => item.uci === move);
    let sharpReplies = 0;
    // A sequence of checks/captures in the verified PV deserves time even if its first move is quiet.
    for (const uci of (line?.pv || []).slice(1, 5)) {
      const reply = game.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
      if (!reply) break;
      if (reply.captured || /[+#]/.test(reply.san)) sharpReplies++;
    }
    if (sharpReplies >= 3 || (line?.score?.unit === 'mate' && Math.abs(line.score.value) > 1)) return 'complex';
    if (!selected.promotion && selected.captured && (!recaptured || (previousTo === selected.to && favorable))) return 'capture';
    if (selected.promotion || inCheck || (selected.captured && recaptured) || isTactical) return 'complex';
    const scores = lines.filter(line => line.score?.unit === 'cp').map(line => line.score.value).sort((a, b) => b - a);
    if (moveNumber > 7 && scores.length > 1 && scores[0] - scores[1] < 35) return 'choice';
    return moveNumber <= 7 ? 'opening' : 'normal';
  }
  plan(params) {
    const phase = this.classify(params);
    const remaining = Number.isFinite(params.remainingSeconds) ? Math.max(0, params.remainingSeconds) : null;
    const increment = Number.isFinite(params.incrementSeconds) ? Math.max(0, params.incrementSeconds) : 0;
    const budget = remaining === null ? 3.2 : remaining * 0.75 / Math.max(16, 42 - (params.moveNumber || 1)) + increment * 0.65;
    const factors = { book: 0.27, forced: 0.14, capture: 0.28, opening: 0.6, normal: 1, choice: 1.3, complex: 1.65 };
    const jitter = this.turn?.jitter ?? (0.8 + (this.random() + this.random()) * 0.2);
    let seconds = budget * factors[phase] * jitter;
    if (phase === 'complex' && this.turn?.pause && (remaining === null || remaining > 60)) seconds *= 1.35;
    const minima = { book: 0.7, forced: 0.3, capture: 0.6, opening: 1.2, normal: 1.4, choice: 1.8, complex: 2 };
    seconds = Math.max(minima[phase], seconds);
    const cap = remaining === null ? 10 : Math.min(18, remaining * 0.07, Math.max(0, remaining - 0.2));
    seconds = Math.min(seconds, cap);
    const reason = remaining !== null && remaining <= 30 ? 'Цейтнот' :
      { book: 'Дебют', forced: 'Вынужденный ход', capture: 'Очевидное взятие', opening: 'Развитие фигур',
        normal: 'Обдумывание', choice: 'Сложный выбор', complex: 'Сложная позиция' }[phase];
    return { seconds: Math.round(seconds * 1000) / 1000, reason, phase };
  }
  calculateThinkTime(params) { return this.plan(params).seconds; }
  startTimer(targetSeconds, onTick = null, onReady = null, { startedAt = this.now(), reason = 'Обдумывание', readRemainingSeconds = null } = {}) {
    this.stopTimer(); this.isReady = false;
    let deadline = startedAt + Math.max(0, targetSeconds * 1000);
    const tick = () => {
      const now = this.now();
      const clock = readRemainingSeconds?.();
      if (Number.isFinite(clock) && clock <= 30) {
        // Only shorten the deadline, so repeated ticks cannot postpone the move indefinitely.
        deadline = Math.min(deadline, now + Math.max(0, Math.min(clock * 0.07, clock - 0.2)) * 1000);
        reason = 'Цейтнот';
      }
      const remainingMs = Math.max(0, deadline - now);
      const elapsedMs = Math.max(0, now - startedAt);
      const ready = remainingMs === 0;
      if (ready) { this.stopTimer(); this.isReady = true; }
      onTick?.({ remainingSec: (remainingMs / 1000).toFixed(1), elapsedSec: (elapsedMs / 1000).toFixed(1),
        progressPercent: ready ? 100 : Math.min(99, Math.round(elapsedMs / Math.max(1, deadline - startedAt) * 100)), isReady: ready, reason });
      if (ready) onReady?.();
    };
    this.intervalId = setInterval(tick, 50);
    tick();
  }
  stopTimer() {
    if (this.intervalId !== null) clearInterval(this.intervalId);
    this.intervalId = null; this.isReady = false;
  }
}
if (typeof module !== 'undefined') module.exports = { TimeManager };
