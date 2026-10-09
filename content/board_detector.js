/**
 * BoardDetector - Модуль обнаружения шахматной доски, парсинга фигур и генерации FEN.
 * Восстановление полной позиции по FEN, истории и легальным переходам,
 * ориентации (Flipped) и поддержка всех типов страниц Chess.com (боты, партии, анализ).
 */

const DetectorPositionState = typeof PositionState !== 'undefined' ? PositionState : (typeof require === 'function' ? require('../engine/position_state.js').PositionState : null);
class BoardDetector {
  constructor(options = {}) {
    this.onPositionChange = options.onPositionChange || null;
    this.boardElement = null;
    this.siteType = null; // 'chesscom' | 'lichess' | 'test'
    this.observer = null;
    this.lastFen = null;
    this.debounceTimer = null;
    this.userColorOverride = null; // 'w' | 'b' | null (авто)
    this.positionState = new DetectorPositionState();
    this.onUnavailable = options.onUnavailable || null;
    this.pollId = null;
    this.retryId = null;
    this.running = false;
    this.lastView = null;
    this.unavailable = false;
  }

  findBoard() {
    // 1. Chess.com (все варианты селекторов)
    const chessComBoard = document.querySelector('wc-chess-board, #board-layout-chessboard .board, .board-layout-main .board, chess-board, #board-single');
    if (chessComBoard) {
      this.siteType = 'chesscom';
      return chessComBoard;
    }

    // 2. Lichess
    const lichessBoard = document.querySelector('cg-board');
    if (lichessBoard) {
      this.siteType = 'lichess';
      return lichessBoard;
    }

    // 3. Локальный тестовый стенд
    const testBoard = document.querySelector('#test-board, .test-board, [data-board="chess"]');
    if (testBoard) {
      this.siteType = 'test';
      return testBoard;
    }

    return null;
  }

  /**
   * Определение ориентации доски (белые или черные снизу)
   */
  isFlipped() {
    if (!this.boardElement) return false;

    if (this.siteType === 'chesscom') {
      // 1. Явные атрибуты
      if (this.boardElement.classList.contains('flipped') || 
          this.boardElement.hasAttribute('flipped') ||
          this.boardElement.closest('.flipped')) {
        return true;
      }

      // 2. Координаты слева: на нормальной доске сверху цифра 8, снизу 1.
      // Если сверху цифра 1 — доска перевернута!
      const coords = this.boardElement.querySelectorAll('.coordinate-light, .coordinate-dark, text');
      for (const c of coords) {
        const txt = c.textContent.trim();
        if (txt === '1' || txt === '8') {
          const cRect = c.getBoundingClientRect();
          const bRect = this.boardElement.getBoundingClientRect();
          if (bRect.height > 0) {
            const isTopHalf = (cRect.top - bRect.top) < (bRect.height * 0.4);
            if (txt === '1' && isTopHalf) return true;  // '1' вверху -> перевернута
            if (txt === '8' && isTopHalf) return false; // '8' вверху -> нормальная
          }
        }
      }

      // 3. Физическое положение черного короля: если черный король в нижней половине экрана
      const bk = this.boardElement.querySelector('.piece.bk, .piece[class*="bk"]');
      if (bk) {
        const bRect = this.boardElement.getBoundingClientRect();
        const kRect = bk.getBoundingClientRect();
        if (bRect.height > 0 && (kRect.top - bRect.top) > bRect.height * 0.6) {
          return true; // Черный король внизу -> играем за черных
        }
      }

      return false;
    }

    if (this.siteType === 'lichess') {
      return !!this.boardElement.closest('.orientation-black');
    }

    if (this.siteType === 'test') {
      return this.boardElement.classList.contains('flipped');
    }

    return false;
  }

  /**
   * Цвет игрока (кто сидит снизу доски)
   * Если доска нормальная — игрок белые ('w'). Если перевернута — черные ('b').
   */
  getUserColor() {
    if (this.userColorOverride) return this.userColorOverride;
    return this.isFlipped() ? 'b' : 'w';
  }

  /**
   * Подсчет количества сыгранных полуходов (плеев) на Chess.com
   */
  getChessComMoveCount() {
    const moveList = document.querySelector('wc-move-list, .move-list-container, .vertical-move-list, .move-list');
    if (!moveList) return null;

    // 1. Поиск элементов .white-node и .black-node
    const colorNodes = moveList.querySelectorAll('.white-node, .black-node');
    if (colorNodes && colorNodes.length > 0) {
      return colorNodes.length;
    }

    // 2. Поиск по строкам (.row, .main-line-row)
    const rows = moveList.querySelectorAll('.row, .main-line-row, div[class*="row"]');
    if (rows && rows.length > 0) {
      let totalMoves = 0;
      rows.forEach(r => {
        const rowMoves = Array.from(r.querySelectorAll('.node, [data-whole-move-number], span[class*="node"], div[class*="node"]'))
          .filter(el => {
            const txt = el.textContent.trim();
            return txt && !/^\d+\.?$/.test(txt) && !/^[+\-]\d/.test(txt);
          });
        totalMoves += rowMoves.length;
      });
      if (totalMoves > 0) return totalMoves;
    }

    // 3. Поиск элементов с классами .node или data-whole-move-number с универсальной очисткой символов
    const allNodes = moveList.querySelectorAll('.node, [data-whole-move-number]');
    if (allNodes && allNodes.length > 0) {
      let count = 0;
      allNodes.forEach(el => {
        const raw = el.textContent.trim();
        if (!raw || /^\d+\.?$/.test(raw) || /^[+\-]\d/.test(raw)) return;
        // Удаляем любые шахматные фигурки Юникода (U+2654-U+265F) и иконки PUA
        const clean = raw.replace(/[\u2654-\u265F\uE000-\uF8FF]/g, '').trim();
        // Рокировки: O-O, O-O-O, 0-0, 0-0-0, любые тире (дефис, en-dash, em-dash)
        const isCastling = /^[o0][\-_–—][o0](?:[\-_–—][o0])?[+#]?$/i.test(clean);
        // Стандартные ходы: pawn e4, exd5, knight Nf3, captured bishop Bxc6, bishop d2
        const isStdMove = /^(?:[kqrbn]?[a-h]?[1-8]?x?[a-h][1-8](?:=[kqrbn])?)[+#]?$/i.test(clean);
        if (isCastling || isStdMove) {
          count++;
        }
      });
      if (count > 0) return count;
    }
    return null;
  }

  /**
   * Определение очереди хода из списка ходов wc-move-list (парсинг строк снизу вверх)
   */
  getTurnFromMoveList() {
    const moveList = typeof document !== 'undefined'
      ? document.querySelector('wc-move-list, .move-list-container, .vertical-move-list, .move-list')
      : null;
    if (!moveList) return null;

    // 1. Поиск строк с ходами (.row, .main-line-row)
    const rows = moveList.querySelectorAll('.row, .main-line-row, div[class*="row"]');
    if (rows && rows.length > 0) {
      // Идем снизу вверх и ищем последнюю строку, содержащую реальные ходы
      for (let i = rows.length - 1; i >= 0; i--) {
        const row = rows[i];

        // А. Прямая и точная проверка по классам .black-node и .white-node
        const blackNode = row.querySelector('.black-node');
        const whiteNode = row.querySelector('.white-node');
        if (blackNode && blackNode.textContent.trim()) {
          // В строке есть сыгранный ход черных -> ход завершен, очередь белых ('w')
          return 'w';
        }
        if (whiteNode && whiteNode.textContent.trim()) {
          // В строке есть только ход белых -> очередь черных ('b')
          return 'b';
        }

        // Б. Если классов white/black-node нет, ищем элементы .node (исключая иконки)
        const nodes = Array.from(row.querySelectorAll('.node, [data-whole-move-number]'))
          .filter(el => {
            // Исключаем иконки фигурок и декоративные элементы
            if (el.classList.contains('node-icon') || el.classList.contains('icon-font-chess') || el.tagName.toLowerCase() === 'svg') {
              return false;
            }
            const txt = el.textContent.trim();
            return txt && !/^\d+\.?$/.test(txt) && !/^[+\-]\d/.test(txt);
          });

        if (nodes.length >= 2) {
          // В строке есть оба хода (белые и черные) -> следующий ход Белых ('w')
          return 'w';
        }
        if (nodes.length === 1) {
          // В строке только один ход (ход белых) -> следующий ход Черных ('b')
          return 'b';
        }
      }
    }

    // 2. Fallback на общее количество ходов
    const moveCount = this.getChessComMoveCount();
    if (moveCount !== null && moveCount > 0) {
      return (moveCount % 2 === 0) ? 'w' : 'b';
    }

    return null;
  }

  /**
   * Резервное определение очереди хода (w или b)
   */
  determineActiveTurn() {
    if (this.siteType === 'chesscom') {
      // 1. ПРИОРИТЕТ 1: Физические клетки подсветки (.highlight) на доске
      // На Chess.com при любом ходе подсвечиваются 2 клетки: откуда пошли и куда пришли.
      // Клетка "куда пришли" занята фигурой, которая ТОЛЬКО ЧТО сделала ход!
      // Если на ней черная фигура (и нет белой) -> ход только что сделали черные -> сейчас ход БЕЛЫХ ('w')!
      // Если на ней белая фигура (и нет черной) -> ход только что сделали белые -> сейчас ход ЧЕРНЫХ ('b')!
      if (this.boardElement) {
        const highlights = this.boardElement.querySelectorAll('.highlight');
        if (highlights && highlights.length >= 2) {
          let whitePieceFound = false;
          let blackPieceFound = false;

          for (const hl of highlights) {
            const classList = Array.from(hl.classList || []);
            const sqClass = classList.find(c => /^(?:square|sq)-(\d\d|[a-h][1-8])$/i.test(c));
            if (!sqClass) continue;

            const piece = this.boardElement.querySelector(`.piece.${sqClass}`);
            if (piece) {
              const pClasses = Array.from(piece.classList || []);
              if (pClasses.some(c => /^w[prnbqk]$/i.test(c))) whitePieceFound = true;
              if (pClasses.some(c => /^b[prnbqk]$/i.test(c))) blackPieceFound = true;
            }
          }

          if (blackPieceFound && !whitePieceFound) {
            return 'w';
          }
          if (whitePieceFound && !blackPieceFound) {
            return 'b';
          }
        }
      }

      // 2. ПРИОРИТЕТ 2: Список ходов (wc-move-list)
      const listTurn = this.getTurnFromMoveList();
      if (listTurn !== null) {
        return listTurn;
      }

      // 3. ПРИОРИТЕТ 3: Проверка часов / индикатора активного хода
      const bottomTurn = typeof document !== 'undefined' 
        ? document.querySelector('.board-layout-bottom .clock-player-turn, .player-bottom .clock-player-turn') 
        : null;
      const topTurn = typeof document !== 'undefined' 
        ? document.querySelector('.board-layout-top .clock-player-turn, .player-top .clock-player-turn') 
        : null;
      if (bottomTurn || topTurn) {
        const userColor = this.getUserColor();
        const opponentColor = userColor === 'w' ? 'b' : 'w';
        if (bottomTurn) return userColor;
        if (topTurn) return opponentColor;
      }

      // 4. Проверка moveCount (для Node.js тестов и стенда)
      const moveCount = this.getChessComMoveCount();
      if (moveCount !== null) {
        return (moveCount % 2 === 0) ? 'w' : 'b';
      }

      // По умолчанию в начале партии
      return 'w';
    }

    if (this.siteType === 'test') {
      const fen = this.boardElement?.getAttribute?.('data-fen');
      if (fen) return fen.split(' ')[1];
      if (typeof document !== 'undefined') {
        if (document.querySelector('#clock-black.clock-player-turn')) return 'b';
        if (document.querySelector('#clock-white.clock-player-turn')) return 'w';
      }
    }
    // Lichess clocks use top/bottom orientation, not white/black classes.
    if (typeof document !== 'undefined') {
      if (document.querySelector('.rclock-bottom.running')) return this.getUserColor();
      if (document.querySelector('.rclock-top.running')) return this.getUserColor() === 'w' ? 'b' : 'w';
    }

    return 'w';
  }

  /**
   * Парсинг фигур на Chess.com
   */
  parseChessComBoard() {
    const grid = Array(8).fill(null).map(() => Array(8).fill(''));
    const pieceElements = this.boardElement.querySelectorAll('.piece');

    pieceElements.forEach(el => {
      if (el.classList.contains('ghost') || el.classList.contains('clone')) return;

      const classList = Array.from(el.classList);

      // Ищем тип фигуры: wp, bp, wn, bn, wb, bb, wr, br, wq, bq, wk, bk
      let pieceCode = '';
      for (const cls of classList) {
        if (/^[wb][prnbqk]$/i.test(cls)) {
          pieceCode = cls.toLowerCase();
          break;
        }
      }

      // Ищем координаты клетки: square-12 или sq-12 или square-e4
      let col = null, row = null;
      for (const cls of classList) {
        const sqMatch = cls.match(/^(?:square|sq)-(\d)(\d)$/);
        if (sqMatch) {
          col = parseInt(sqMatch[1], 10); // 1 = a ... 8 = h
          row = parseInt(sqMatch[2], 10); // 1 = 1 ... 8 = 8
          break;
        }
        const alphaMatch = cls.match(/^(?:square|sq)-([a-h])([1-8])$/i);
        if (alphaMatch) {
          col = alphaMatch[1].toLowerCase().charCodeAt(0) - 96;
          row = parseInt(alphaMatch[2], 10);
          break;
        }
      }

      if (pieceCode && col >= 1 && col <= 8 && row >= 1 && row <= 8) {
        const color = pieceCode[0];
        const type = pieceCode[1].toUpperCase();
        const char = color === 'w' ? type : type.toLowerCase();
        grid[8 - row][col - 1] = char;
      }
    });

    return this.buildFenFromGrid(grid);
  }

  parseLichessBoard() {
    // Chessground transforms describe animation frames, not always occupied squares.
    if (this.boardElement.querySelector('piece.anim, piece.fading, piece.dragging')) return null;
    const grid = Array(8).fill(null).map(() => Array(8).fill(''));
    const pieceElements = this.boardElement.querySelectorAll('piece');
    const flipped = this.isFlipped();
    const boardRect = this.boardElement.getBoundingClientRect();
    const squareSize = boardRect.width / 8;
    const squareHeight = boardRect.height / 8;

    pieceElements.forEach(el => {
      if (el.classList.contains('ghost') || el.classList.contains('dragging')) return;
      const classList = Array.from(el.classList);
      let color = classList.includes('white') ? 'w' : (classList.includes('black') ? 'b' : '');
      let type = '';

      if (classList.includes('pawn')) type = 'P';
      else if (classList.includes('knight')) type = 'N';
      else if (classList.includes('bishop')) type = 'B';
      else if (classList.includes('rook')) type = 'R';
      else if (classList.includes('queen')) type = 'Q';
      else if (classList.includes('king')) type = 'K';

      if (!color || !type) return;

      const style = el.getAttribute('style') || '';
      const match = style.match(/translate(?:3d)?\(\s*(-?\d+(?:\.\d+)?)px,\s*(-?\d+(?:\.\d+)?)px(?:,\s*0(?:px)?)?\)/);
      if (match && squareSize > 0 && squareHeight > 0) {
        let col = Math.round(parseFloat(match[1]) / squareSize);
        let row = Math.round(parseFloat(match[2]) / squareHeight);

        if (flipped) {
          col = 7 - col;
          row = 7 - row;
        }

        if (col >= 0 && col < 8 && row >= 0 && row < 8) {
          grid[row][col] = color === 'w' ? type : type.toLowerCase();
        }
      }
    });

    return this.buildFenFromGrid(grid);
  }

  buildFenFromGrid(grid) {
    const fenRanks = [];

    for (let r = 0; r < 8; r++) {
      let emptyCount = 0;
      let rankStr = '';

      for (let c = 0; c < 8; c++) {
        const piece = grid[r][c];
        if (!piece) {
          emptyCount++;
        } else {
          if (emptyCount > 0) {
            rankStr += emptyCount;
            emptyCount = 0;
          }
          rankStr += piece;
        }
      }

      if (emptyCount > 0) {
        rankStr += emptyCount;
      }
      fenRanks.push(rankStr);
    }

    const boardFen = fenRanks.join('/');
    const directFen = this.boardElement?.getAttribute?.('data-fen') || this.boardElement?.getAttribute?.('fen');
    return this.positionState.resolve(boardFen, directFen, this.readMoves());
  }

  readMoves() {
    if (typeof document === 'undefined' || this.siteType === 'test') return [];
    if (this.siteType === 'lichess') {
      const round = BoardDetector.lichessRoundHistory();
      if (round) return round.moves.slice(0, round.ply);
    }
    const list = document.querySelector(this.siteType === 'lichess'
      ? 'l4x, .analyse__moves, .round__app .moves, .moves'
      : 'wc-move-list, .move-list-container, .vertical-move-list, .move-list');
    if (!list) return [];
    let nodes = list.querySelectorAll(this.siteType === 'lichess' ? 'move, kwdb' : '.white-node, .black-node');
    if (!nodes.length) nodes = list.querySelectorAll('.node, [data-san]');
    const symbols = { '♔': 'K', '♚': 'K', '♕': 'Q', '♛': 'Q', '♖': 'R', '♜': 'R', '♗': 'B', '♝': 'B', '♘': 'N', '♞': 'N', '♙': '', '♟': '' };
    let ordered = Array.from(nodes).filter(node => !Array.from(nodes).some(other => other !== node && node.contains(other)));
    const selected = ordered.findIndex(node => node.matches('.selected, .active, [aria-current="true"]'));
    if (selected >= 0) ordered = ordered.slice(0, selected + 1);
    return ordered
      .map(node => {
        let san = node.getAttribute('data-san') || node.textContent;
        san = san.replace(/[♔-♟]/g, symbol => symbols[symbol]).replace(/[\uE000-\uF8FF]/g, '').trim();
        const icon = node.querySelector('[data-figurine], [data-piece], .icon-font-chess');
        const figure = icon?.getAttribute('data-figurine') || icon?.getAttribute('data-piece') || icon?.className?.match(/(?:^|\s)(?:icon-)?(?:white-|black-)?(king|queen|rook|bishop|knight|pawn)(?:-(?:white|black))?(?:\s|$)/)?.[1];
        const types = { king: 'K', queen: 'Q', rook: 'R', bishop: 'B', knight: 'N', pawn: '' };
        const prefix = types[figure] ?? (/^[kqrbn]$/i.test(figure || '') ? figure.toUpperCase() : '');
        if (prefix && !/^[KQRBN]/.test(san)) san = prefix + san;
        return san.replace(/^\d+\.(?:\.\.)?\s*/, '').replace(/[!?]/g, '').replace(/0/g, 'O');
      }).filter(san => /^(?:O-O(?:-O)?|[KQRBN]?[a-h]?[1-8]?x?[a-h][1-8](?:=[QRBN])?)[+#]?$/.test(san));
  }

  static lichessRoundHistory() {
    if (typeof document === 'undefined') return null;
    const buttons = Array.from(document.querySelectorAll('.round__app button[data-ply]'));
    if (buttons.length !== 4) return null;
    // Round uses generated tag/class names. Its navigation and adjacent move list
    // provide a structural anchor that survives those names changing.
    const list = buttons[0].parentElement?.nextElementSibling;
    if (!list) return null;
    const moves = Array.from(list.children).map(node => {
      // Draw offers are appended as child elements after the SAN text.
      const san = node.getAttribute('data-san') || Array.from(node.childNodes)
        .filter(child => child.nodeType === 3 || child.nodeName.toLowerCase() === 'san')
        .map(child => child.textContent).join('').trim();
      return san.replace(/[!?]/g, '').replace(/0/g, 'O');
    }).filter(san => /^(?:O-O(?:-O)?|[KQRBN]?[a-h]?[1-8]?x?[a-h][1-8](?:=[QRBN])?)[+#]?$/.test(san));
    const next = buttons[2].getAttribute('data-ply');
    const ply = /^\d+$/.test(next || '') ? Math.max(0, Math.min(moves.length, Number(next) - 1)) : moves.length;
    return { moves, ply };
  }

  detectCastlingRights(grid) {
    return this.positionState.fen?.split(' ')[2] || '-';
  }

  estimateMoveNumber() {
    const moveCount = this.getChessComMoveCount();
    if (moveCount !== null) {
      return Math.max(1, Math.floor(moveCount / 2) + 1);
    }
    if (this.positionState.fen) return Number(this.positionState.fen.split(' ')[5]);
    if (typeof document === 'undefined') return 1;
    const moveNodes = document.querySelectorAll('wc-move-list .node, .move-list-container .node, .move-list .node, .moves-list .node, .move-text-white, .move-text-black, cg-board ~ .moves index');
    if (moveNodes && moveNodes.length > 0) {
      return Math.max(1, Math.floor(moveNodes.length / 2) + 1);
    }
    const highlights = this.boardElement ? this.boardElement.querySelectorAll('.highlight') : [];
    if (highlights && highlights.length >= 2) {
      return 2;
    }
    return 1;
  }

  getCurrentFen() {
    if (!this.boardElement || !document.contains(this.boardElement)) {
      this.boardElement = this.findBoard();
    }
    if (!this.boardElement) return null;

    if (this.siteType === 'chesscom' || this.siteType === 'test') {
      return this.parseChessComBoard();
    } else if (this.siteType === 'lichess') {
      return this.parseLichessBoard();
    }
    return null;
  }

  startObserving() {
    this.running = true;
    clearTimeout(this.retryId);
    this.boardElement = this.findBoard();
    if (!this.boardElement) {
      this.retryId = setTimeout(() => { if (this.running) this.startObserving(); }, 400);
      return;
    }

    console.log(`[BoardDetector] Найдена доска (${this.siteType}), userColor = ${this.getUserColor()}, flipped = ${this.isFlipped()}`);
    this.triggerCheck();
    setTimeout(() => this.triggerCheck(), 300);
    setTimeout(() => this.triggerCheck(), 800);

    if (this.observer) this.observer.disconnect();

    this.observer = new MutationObserver(() => {
      if (this.debounceTimer) clearTimeout(this.debounceTimer);
      this.debounceTimer = setTimeout(() => {
        this.triggerCheck();
      }, 50);
    });

    this.observer.observe(this.boardElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class', 'style', 'flipped', 'data-fen', 'fen']
    });

    // Регулярный интервал на случай, если мутации не перехватились
    clearInterval(this.pollId);
    this.pollId = setInterval(() => {
      this.triggerCheck();
    }, 600);
  }

  triggerCheck() {
    if (!this.boardElement || !document.contains(this.boardElement)) {
      const newBoard = this.findBoard();
      if (newBoard) {
        this.boardElement = newBoard;
        this.startObserving();
        return;
      }
    }

    if (this.siteType === 'lichess' && this.boardElement?.querySelector('piece.anim, piece.fading, piece.dragging')) return;
    const fen = this.getCurrentFen();
    if (!fen) {
      if (!this.unavailable) {
        this.unavailable = true;
        this.lastFen = null;
        this.lastView = null;
        if (this.onUnavailable) this.onUnavailable();
      }
      return;
    }
    this.unavailable = false;
    const view = `${this.isFlipped()}:${this.getUserColor()}:${this.boardElement?.dataset.gameId || ''}`;
    if (fen !== this.lastFen || view !== this.lastView) {
      this.lastFen = fen;
      this.lastView = view;
      if (this.onPositionChange) {
        this.onPositionChange({
          fen,
          isFlipped: this.isFlipped(),
          turn: fen.split(' ')[1] || 'w',
          userColor: this.getUserColor(),
          moveNumber: Number(fen.split(' ')[5]),
          transition: this.positionState.transition,
          session: this.positionState.session
        });
      }
    }
  }

  stopObserving() {
    this.running = false;
    clearInterval(this.pollId);
    clearTimeout(this.retryId);
    clearTimeout(this.debounceTimer);
    if (this.observer) {
      this.observer.disconnect();
      this.observer = null;
    }
  }
}

if (typeof module !== 'undefined') {
  module.exports = { BoardDetector };
}
