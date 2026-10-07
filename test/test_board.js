(function () {
// Шахматные символы Unicode
    const SYMBOLS = {
      'P': '♙', 'N': '♘', 'B': '♗', 'R': '♖', 'Q': '♕', 'K': '♔',
      'p': '♟', 'n': '♞', 'b': '♝', 'r': '♜', 'q': '♛', 'k': '♚'
    };

    const INITIAL_GRID = [
      ['r','n','b','q','k','b','n','r'],
      ['p','p','p','p','p','p','p','p'],
      ['','','','','','','',''],
      ['','','','','','','',''],
      ['','','','','','','',''],
      ['','','','','','','',''],
      ['P','P','P','P','P','P','P','P'],
      ['R','N','B','Q','K','B','N','R']
    ];

    const game = new ChessRules();
    let grid = JSON.parse(JSON.stringify(INITIAL_GRID));
    let turn = 'w';
    let isFlipped = false;
    let selectedSquare = null;
    let moveCount = 1;
    let history = [];

    let whiteSeconds = 180;
    let blackSeconds = 180;
    let timerRunning = true;

    const boardEl = document.getElementById('test-board');
    const newGameId = () => {
      const value = crypto.randomUUID();
      boardEl.dataset.gameId = value;
      boardEl.dataset.timeControl = '180+0';
      boardEl.removeAttribute('data-result');
      try { sessionStorage.setItem('sensei-test-game-id', value); } catch (_) {}
    };
    try { boardEl.dataset.gameId = sessionStorage.getItem('sensei-test-game-id') || ''; } catch (_) {}
    if (!boardEl.dataset.gameId) newGameId();
    const fenInput = document.getElementById('fen-input');
    const movesHistoryEl = document.getElementById('moves-history');
    const clockWhiteEl = document.getElementById('clock-white');
    const clockBlackEl = document.getElementById('clock-black');

    function renderBoard() {
      boardEl.innerHTML = '';
      boardEl.classList.toggle('flipped', isFlipped);

      for (let r = 0; r < 8; r++) {
        for (let c = 0; c < 8; c++) {
          const displayR = isFlipped ? 7 - r : r;
          const displayC = isFlipped ? 7 - c : c;

          const sq = document.createElement('div');
          const isLight = (displayR + displayC) % 2 === 0;
          sq.className = `square ${isLight ? 'light' : 'dark'}`;
          sq.dataset.row = displayR;
          sq.dataset.col = displayC;

          if (selectedSquare && selectedSquare.r === displayR && selectedSquare.c === displayC) {
            sq.classList.add('selected');
          }

          const pieceChar = grid[displayR][displayC];
          if (pieceChar) {
            const isWhite = pieceChar === pieceChar.toUpperCase();
            const pieceCode = (isWhite ? 'w' : 'b') + pieceChar.toLowerCase();
            const col1Idx = displayC + 1;
            const row1Idx = 8 - displayR;

            const pieceEl = document.createElement('div');
            // Добавляем классы как на Chess.com: piece wp square-12
            pieceEl.className = `piece ${isWhite ? 'white-piece' : 'black-piece'} ${pieceCode} square-${col1Idx}${row1Idx}`;
            pieceEl.textContent = SYMBOLS[pieceChar] || pieceChar;
            sq.appendChild(pieceEl);
          }

          sq.addEventListener('click', () => handleSquareClick(displayR, displayC));
          boardEl.appendChild(sq);
        }
      }

      updateFen();
    }

    function handleSquareClick(r, c) {
      const piece = grid[r][c];

      if (selectedSquare) {
        // Попытка сделать ход
        if (selectedSquare.r === r && selectedSquare.c === c) {
          selectedSquare = null;
          renderBoard();
          return;
        }

        const movedPiece = grid[selectedSquare.r][selectedSquare.c];
        const isWhite = movedPiece === movedPiece.toUpperCase();
        const movingTurn = isWhite ? 'w' : 'b';

        // Разрешаем ход
        const fromCol = String.fromCharCode(97 + selectedSquare.c);
        const fromRow = 8 - selectedSquare.r;
        const toCol = String.fromCharCode(97 + c);
        const toRow = 8 - r;
        const uci = `${fromCol}${fromRow}${toCol}${toRow}`;

        const promotion = movedPiece.toLowerCase() === 'p' && (r === 0 || r === 7)
          ? (prompt('Превращение: q, r, b или n', 'q') || 'q').toLowerCase() : undefined;
        if (!playMove(uci + (promotion || ''))) {
          selectedSquare = null;
          renderBoard();
          return;
        }
      } else {
        // Выбор фигуры
        if (piece) {
          selectedSquare = { r, c };
          renderBoard();
        }
      }
    }

    function playMove(uci) {
      if (!/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(uci) ||
          !game.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] })) return false;
      selectedSquare = null;
      syncGame();
      history.push(uci);
      updateHistoryDisplay();
      renderBoard();
      updateClocksHighlight();
      return true;
    }
    boardEl.addEventListener('chess-sensei-play', event => {
      try {
        const { uci, fen } = JSON.parse(event.detail);
        if (fen === game.fen()) playMove(uci);
      } catch (_) { /* Ignore malformed requests. */ }
    });

    function syncGame() {
      grid = game.board().map(row => row.map(piece => !piece ? '' : piece.color === 'w' ? piece.type.toUpperCase() : piece.type));
      turn = game.turn();
    }
    function generateFen() { return game.fen(); }

    function updateFen() {
      fenInput.value = generateFen();
      boardEl.setAttribute("data-fen", fenInput.value);
    }

    function updateHistoryDisplay() {
      let str = '';
      for (let i = 0; i < history.length; i += 2) {
        const moveNum = Math.floor(i / 2) + 1;
        str += `${moveNum}. ${history[i]} ${history[i+1] || ''}\n`;
      }
      movesHistoryEl.innerText = str || '1. —';
      movesHistoryEl.scrollTop = movesHistoryEl.scrollHeight;
    }

    function updateClocksHighlight() {
      if (turn === 'w') {
        clockWhiteEl.classList.add('clock-player-turn');
        clockBlackEl.classList.remove('clock-player-turn');
      } else {
        clockBlackEl.classList.add('clock-player-turn');
        clockWhiteEl.classList.remove('clock-player-turn');
      }
    }

    function formatTime(sec) {
      const m = Math.floor(sec / 60);
      const s = Math.floor(sec % 60);
      return `${m}:${s < 10 ? '0' : ''}${s}`;
    }

    // Таймер часов
    setInterval(() => {
      if (!timerRunning) return;
      if (turn === 'w' && whiteSeconds > 0) {
        whiteSeconds = Math.max(0, whiteSeconds - 1);
        clockWhiteEl.querySelector('.clock-time').textContent = formatTime(whiteSeconds);
      } else if (turn === 'b' && blackSeconds > 0) {
        blackSeconds = Math.max(0, blackSeconds - 1);
        clockBlackEl.querySelector('.clock-time').textContent = formatTime(blackSeconds);
      }
    }, 1000);

    // Кнопки управления
    document.getElementById('btn-new').addEventListener('click', () => {
      newGameId();
      game.reset();
      syncGame();
      selectedSquare = null;
      history = [];
      setTime(180);
      updateClocksHighlight();
      updateHistoryDisplay();
      renderBoard();
    });

    document.getElementById('btn-flip').addEventListener('click', () => {
      isFlipped = !isFlipped;
      renderBoard();
    });

    document.getElementById('btn-copy-fen').addEventListener('click', () => {
      navigator.clipboard.writeText(fenInput.value);
      alert('FEN скопирован в буфер обмена!');
    });

    function setTime(sec) {
      whiteSeconds = sec;
      blackSeconds = sec;
      clockWhiteEl.querySelector('.clock-time').textContent = formatTime(sec);
      clockBlackEl.querySelector('.clock-time').textContent = formatTime(sec);
    }

    document.getElementById('btn-t-1m').addEventListener('click', () => setTime(60));
    document.getElementById('btn-t-3m').addEventListener('click', () => setTime(180));
    document.getElementById('btn-t-10m').addEventListener('click', () => setTime(600));

    // Пресеты
    document.querySelectorAll('.preset-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        loadFen(btn.dataset.fen);
      });
    });

    function loadFen(fen) {
      if (!game.load(fen)) return;
      newGameId();
      syncGame();
      selectedSquare = null;
      history = [];
      updateHistoryDisplay();
      updateClocksHighlight();
      renderBoard();
    }

    renderBoard();
    updateClocksHighlight();

})();
