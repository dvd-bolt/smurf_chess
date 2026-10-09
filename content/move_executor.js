/** Executes one legal move against the position for which it was selected. */
class MoveExecutor {
  constructor(detector) { this.detector = detector; this.busy = false; }

  static acceptsKey(event) {
    if (!(event.code === 'Space' || event.key === ' ') || event.defaultPrevented || event.repeat ||
        event.ctrlKey || event.altKey || event.metaKey || event.shiftKey || event.isComposing) return false;
    const target = event.composedPath?.()[0] || event.target;
    return !target?.closest?.('input, textarea, select, button, a, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="combobox"], [role="button"]:not(.cs-multipv-item), [role="slider"]');
  }

  async execute(uci, fen, isAllowed = () => true) {
    if (this.busy || !isAllowed()) return false;
    const detector = this.detector;
    if (!/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(uci || '') || detector.getCurrentFen() !== fen ||
        fen.split(' ')[1] !== detector.getUserColor()) return false;
    const game = new ChessRules();
    if (!game.load(fen) || !game.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] })) return false;
    this.busy = true;
    try {
      const board = detector.boardElement;
      if (!board?.isConnected) return false;
      if (detector.siteType === 'test') {
        board.dispatchEvent(new CustomEvent('chess-sensei-play', { detail: JSON.stringify({ uci, fen }) }));
      } else {
        await this.clickSquare(uci.slice(0, 2));
        if (!isAllowed() || detector.getCurrentFen() !== fen) return false;
        await this.clickSquare(uci.slice(2, 4));
      }
      for (let attempt = 0; attempt < 20; attempt++) {
        if (detector.getCurrentFen() === game.fen()) { detector.triggerCheck(); return true; }
        if (!isAllowed()) return false;
        if (uci[4] && detector.siteType !== 'test') {
          const color = fen.split(' ')[1];
          const name = { q: 'queen', r: 'rook', b: 'bishop', n: 'knight' }[uci[4]];
          const choice = document.querySelector(detector.siteType === 'lichess'
            ? `#promotion-choice piece.${name}, .promotion-choice piece.${name}`
            : `.promotion-window .piece.${color}${uci[4]}, .promotion-window .${color}${uci[4]}`);
          if (choice) await this.clickAt(choice, choice.getBoundingClientRect());
        }
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      throw new Error('Доска не приняла ход. Сделайте его мышью.');
    } finally { this.busy = false; }
  }

  clickSquare(square) {
    const board = this.detector.boardElement;
    const rect = board.getBoundingClientRect();
    const file = square.charCodeAt(0) - 97, rank = Number(square[1]) - 1;
    const flipped = this.detector.isFlipped();
    const x = rect.left + ((flipped ? 7 - file : file) + 0.5) * rect.width / 8;
    const y = rect.top + ((flipped ? rank : 7 - rank) + 0.5) * rect.height / 8;
    const target = document.elementFromPoint(x, y);
    if (!target || !(target === board || board.contains(target) || board.shadowRoot?.contains(target))) {
      throw new Error('Доска перекрыта. Освободите её и нажмите пробел.');
    }
    return this.clickAt(target, { left: x, top: y, width: 0, height: 0 });
  }

  clickAt(target, rect) {
    if (this.detector.siteType === 'lichess' && typeof chrome !== 'undefined' && chrome.runtime?.id) {
      return new Promise((resolve, reject) => {
        try {
          chrome.runtime.sendMessage({ action: 'LICHESS_TRUSTED_CLICK',
            x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }, response => {
            const error = chrome.runtime.lastError?.message || (!response?.success && response?.error);
            if (error || !response?.success) reject(new Error(error || 'Ввод Lichess недоступен.'));
            else resolve();
          });
        } catch (error) { reject(error); }
      });
    }
    const options = { bubbles: true, cancelable: true, composed: true, view: window,
      clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2, button: 0 };
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
      const down = type.endsWith('down');
      const event = type.startsWith('pointer')
        ? new PointerEvent(type, { ...options, pointerId: 1, pointerType: 'mouse', isPrimary: true, buttons: down ? 1 : 0 })
        : new MouseEvent(type, { ...options, buttons: down ? 1 : 0, detail: 1 });
      target.dispatchEvent(event);
    }
  }
}
if (typeof module !== 'undefined') module.exports = { MoveExecutor };
