/**
 * OpeningsBook - Модуль мгновенного распознавания дебютов и книжных ходов.
 * Содержит свыше 5,300 позиций гроссмейстерских дебютов с ECO-кодами и процентами побед.
 */
class OpeningsBook {
  constructor() {
    this.db = null;
    this.loaded = false;
    this.loadingPromise = null;

    const globalObj = typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : (typeof self !== 'undefined' ? self : {}));
    if (globalObj.CHESS_OPENINGS_DATA) {
      this.db = globalObj.CHESS_OPENINGS_DATA;
      this.loaded = true;
    }
  }

  async init(customPath = null) {
    if (this.loaded && this.db && Object.keys(this.db).length > 0) return true;

    const globalObj = typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : (typeof self !== 'undefined' ? self : {}));
    if (globalObj.CHESS_OPENINGS_DATA) {
      this.db = globalObj.CHESS_OPENINGS_DATA;
      this.loaded = true;
      return true;
    }

    if (this.loadingPromise) return this.loadingPromise;

    this.loadingPromise = (async () => {
      try {
        let url;
        if (customPath) {
          url = customPath;
        } else if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getURL) {
          url = chrome.runtime.getURL('engine/openings_data.json');
        } else if (typeof window !== 'undefined' && window.location && window.location.pathname.includes('/test/')) {
          url = '../engine/openings_data.json';
        } else {
          url = './engine/openings_data.json';
        }

        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        this.db = await res.json();
        this.loaded = true;
        console.log('[OpeningsBook] Загружено через fetch:', Object.keys(this.db).length);
        return true;
      } catch (err) {
        console.warn('[OpeningsBook] Предупреждение fetch базы дебютов:', err);
        this.db = this.db || {};
        this.loaded = true;
        return false;
      }
    })();

    return this.loadingPromise;
  }

  /**
   * Нормализует FEN для поиска в базе (доска, активный цвет, права на рокировку).
   * @param {string} fen 
   * @returns {string}
   */
  normalizeFen(fen) {
    if (!fen) return '';
    const parts = fen.trim().split(/\s+/);
    if (parts.length < 3) return '';
    return `${parts[0]} ${parts[1]} ${parts[2]}`;
  }

  /**
   * Ищет дебют по FEN.
   * @param {string} fen
   * @returns {{ name: string, eco: string, moves: Array<{ uci: string, pct: number }> } | null}
   */
  lookup(fen) {
    if (!this.db) return null;
    const key = this.normalizeFen(fen);
    return this.db[key] || null;
  }

  /**
   * Выбирает ход из книги с учетом весов популярности.
   * @param {object} opening
   * @param {boolean} randomize
   * @returns {{ uci: string, pct: number } | null}
   */
  pickMove(opening, randomize = true) {
    if (!opening || !opening.moves || !opening.moves.length) return null;
    if (!randomize || opening.moves.length === 1) {
      return opening.moves[0];
    }

    const totalWeight = opening.moves.reduce((sum, m) => sum + (m.pct || 1), 0);
    let rand = Math.random() * totalWeight;
    for (const m of opening.moves) {
      rand -= (m.pct || 1);
      if (rand <= 0) return m;
    }
    return opening.moves[0];
  }
}

if (typeof module !== 'undefined') {
  module.exports = { OpeningsBook };
}
