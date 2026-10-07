/**
 * VisualOverlay - Отрисовка цветных неоновых стрелок и подсветки клеток поверх шахматной доски.
 * Поддерживает одновременную отрисовку Топ 1–3 лучших ходов (MultiPV) с цветовым кодированием
 * и подсветкой хода, рекомендованного под выбранный ELO.
 * Крепится через fixed SVG-слой поверх доски, защищен от сбоев DOM и скролла.
 */

class VisualOverlay {
  constructor() {
    this.svg = null;
    this.boardElement = null;
    this.isVisible = true;
    this.showAllTopMoves = true; // Показывать все 3 стрелки или только 1 лучший
    this.currentMove = null;
    this.currentMultiData = null;

    // Автоматическая корректировка координат при скролле и ресайзе
    if (typeof window !== 'undefined') {
      window.addEventListener('resize', () => this.syncBounds());
      window.addEventListener('scroll', () => this.syncBounds());
    }
  }

  ensureSvg(boardElement) {
    this.boardElement = boardElement;

    if (this.svg && document.body.contains(this.svg)) {
      this.syncBounds();
      return this.svg;
    }

    if (this.svg && this.svg.parentNode) {
      this.svg.parentNode.removeChild(this.svg);
    }

    this.svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    this.svg.setAttribute('class', 'chess-sensei-overlay');
    this.svg.style.position = 'fixed';
    this.svg.style.pointerEvents = 'none';
    this.svg.style.zIndex = '999999';
    this.svg.style.overflow = 'visible';

    this.svg.innerHTML = `
      <defs>
        <!-- Неоновое свечение для линий -->
        <filter id="cs-glow-green" x="-40%" y="-40%" width="180%" height="180%">
          <feDropShadow dx="0" dy="0" stdDeviation="5" flood-color="#00f59b" flood-opacity="0.95"/>
        </filter>
        <filter id="cs-glow-blue" x="-40%" y="-40%" width="180%" height="180%">
          <feDropShadow dx="0" dy="0" stdDeviation="4" flood-color="#00c2ff" flood-opacity="0.90"/>
        </filter>
        <filter id="cs-glow-amber" x="-40%" y="-40%" width="180%" height="180%">
          <feDropShadow dx="0" dy="0" stdDeviation="4" flood-color="#ffb800" flood-opacity="0.85"/>
        </filter>
        <filter id="cs-glow-purple" x="-40%" y="-40%" width="180%" height="180%">
          <feDropShadow dx="0" dy="0" stdDeviation="5" flood-color="#c084fc" flood-opacity="0.95"/>
        </filter>
        <filter id="cs-glow-gold" x="-50%" y="-50%" width="200%" height="200%">
          <feDropShadow dx="0" dy="0" stdDeviation="6" flood-color="#ffd700" flood-opacity="0.95"/>
        </filter>

        <!-- Наконечники стрелок -->
        <marker id="cs-arrow-green" viewBox="0 0 10 10" refX="6" refY="5" markerWidth="6.5" markerHeight="6.5" orient="auto">
          <path d="M 0 1.2 L 9.5 5 L 0 8.8 z" fill="#00f59b" />
        </marker>
        <marker id="cs-arrow-blue" viewBox="0 0 10 10" refX="6" refY="5" markerWidth="6.0" markerHeight="6.0" orient="auto">
          <path d="M 0 1.2 L 9.5 5 L 0 8.8 z" fill="#00c2ff" />
        </marker>
        <marker id="cs-arrow-amber" viewBox="0 0 10 10" refX="6" refY="5" markerWidth="5.5" markerHeight="5.5" orient="auto">
          <path d="M 0 1.2 L 9.5 5 L 0 8.8 z" fill="#ffb800" />
        </marker>
        <marker id="cs-arrow-purple" viewBox="0 0 10 10" refX="6" refY="5" markerWidth="6.5" markerHeight="6.5" orient="auto">
          <path d="M 0 1.2 L 9.5 5 L 0 8.8 z" fill="#c084fc" />
        </marker>
      </defs>
      <g class="cs-draw-layer"></g>
    `;

    document.body.appendChild(this.svg);
    this.syncBounds();
    return this.svg;
  }

  syncBounds() {
    if (!this.boardElement || !this.svg) return;
    const rect = this.boardElement.getBoundingClientRect();
    this.svg.style.top = `${rect.top}px`;
    this.svg.style.left = `${rect.left}px`;
    this.svg.style.width = `${rect.width}px`;
    this.svg.style.height = `${rect.height}px`;
    this.svg.setAttribute('viewBox', `0 0 ${rect.width} ${rect.height}`);
  }

  squareToCoords(sq, isFlipped, rect) {
    if (!sq || sq.length < 2) return null;
    let col = sq.charCodeAt(0) - 97; // a = 0 ... h = 7
    let row = 8 - parseInt(sq[1], 10); // 8 = 0 ... 1 = 7

    if (isFlipped) {
      col = 7 - col;
      row = 7 - row;
    }

    const sqW = rect.width / 8;
    const sqH = rect.height / 8;

    return {
      x: (col + 0.5) * sqW,
      y: (row + 0.5) * sqH,
      left: col * sqW,
      top: row * sqH,
      w: sqW,
      h: sqH
    };
  }

  /**
   * Отрисовка стрелки хода со стилем
   */
  drawSingleArrow(layer, uciMove, style, rect, isFlipped) {
    if (!uciMove || uciMove.length < 4) return;
    const fromSq = uciMove.slice(0, 2);
    const toSq = uciMove.slice(2, 4);

    const from = this.squareToCoords(fromSq, isFlipped, rect);
    const to = this.squareToCoords(toSq, isFlipped, rect);
    if (!from || !to) return;

    // 1. Подсветка клетки "откуда"
    if (style.drawRects) {
      const fromRect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      fromRect.setAttribute('x', from.left + 3);
      fromRect.setAttribute('y', from.top + 3);
      fromRect.setAttribute('width', from.w - 6);
      fromRect.setAttribute('height', from.h - 6);
      fromRect.setAttribute('rx', '8');
      fromRect.setAttribute('fill', style.color);
      fromRect.setAttribute('fill-opacity', style.fromOpacity || '0.20');
      fromRect.setAttribute('stroke', style.color);
      fromRect.setAttribute('stroke-width', style.isSelected ? '3' : '2');
      if (style.isSelected) {
        fromRect.setAttribute('filter', 'url(#cs-glow-gold)');
      }
      layer.appendChild(fromRect);

      // 2. Подсветка целевой клетки "куда"
      const toRect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      toRect.setAttribute('x', to.left + 3);
      toRect.setAttribute('y', to.top + 3);
      toRect.setAttribute('width', to.w - 6);
      toRect.setAttribute('height', to.h - 6);
      toRect.setAttribute('rx', '8');
      toRect.setAttribute('fill', style.color);
      toRect.setAttribute('fill-opacity', style.toOpacity || '0.35');
      toRect.setAttribute('stroke', style.color);
      toRect.setAttribute('stroke-width', style.isSelected ? '3.5' : '2.5');
      layer.appendChild(toRect);
    }

    // 3. Линия стрелки с расчетом точки под наконечник
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const shorten = Math.min(28, dist * 0.28);
    const targetX = to.x - (dx / dist) * shorten;
    const targetY = to.y - (dy / dist) * shorten;

    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line.setAttribute('x1', from.x);
    line.setAttribute('y1', from.y);
    line.setAttribute('x2', targetX);
    line.setAttribute('y2', targetY);
    line.setAttribute('stroke', style.color);
    line.setAttribute('stroke-width', style.strokeWidth || '7');
    line.setAttribute('stroke-linecap', 'round');
    line.setAttribute('stroke-opacity', style.opacity || '1.0');
    if (style.filterId) {
      line.setAttribute('filter', `url(#${style.filterId})`);
    }
    line.setAttribute('marker-end', `url(#${style.markerId})`);
    layer.appendChild(line);

    // 4. Если этот ход выбран селектором ELO, добавляем акцентное кольцо цели
    if (style.isSelected && style.rank > 1) {
      const ring = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      ring.setAttribute('cx', to.x);
      ring.setAttribute('cy', to.y);
      ring.setAttribute('r', (from.w / 2) - 8);
      ring.setAttribute('fill', 'none');
      ring.setAttribute('stroke', '#ffd700');
      ring.setAttribute('stroke-width', '2.5');
      ring.setAttribute('stroke-dasharray', '4,3');
      ring.setAttribute('filter', 'url(#cs-glow-gold)');
      layer.appendChild(ring);
    }
  }

  /**
   * Отрисовка всех ходов Топ 1–3 одновременно (Multi-PV)
   * @param {Array} lines - массив объектов [{ uci, multipv, score, rank }]
   * @param {string} selectedMoveUci - ход, выбранный ELO-селектором
   * @param {object} meta - { isFlipped, isBook }
   */
  renderMultiMoves(lines = [], selectedMoveUci = null, meta = {}) {
    this.currentMultiData = { lines, selectedMoveUci, meta };
    if (!this.isVisible) {
      this.clear(false);
      return;
    }

    if (!lines || lines.length === 0) {
      if (selectedMoveUci) {
        this.renderMove(selectedMoveUci, meta);
      } else {
        this.clear();
      }
      return;
    }

    // Если пользователь переключил режим на "Только 1 стрелка"
    if (!this.showAllTopMoves) {
      const bestMove = selectedMoveUci || (lines[0] && lines[0].uci);
      this.renderMove(bestMove, meta);
      return;
    }

    if (!this.boardElement || !document.contains(this.boardElement)) {
      this.boardElement = document.querySelector('wc-chess-board, #board-layout-chessboard .board, .board-layout-main .board, chess-board, #board-single, cg-board, #test-board');
    }
    if (!this.boardElement) {
      console.warn('[VisualOverlay] Доска не найдена для отрисовки мульти-стрелок');
      return;
    }

    const svg = this.ensureSvg(this.boardElement);
    const rect = this.boardElement.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;

    const layer = svg.querySelector('.cs-draw-layer');
    if (!layer) return;
    layer.innerHTML = '';

    // Подготовка стилей ходов Топ 1-3
    const styleMap = {
      1: {
        rank: 1,
        color: '#00f59b',
        strokeWidth: '7.5',
        opacity: '1.0',
        filterId: 'cs-glow-green',
        markerId: 'cs-arrow-green',
        fromOpacity: '0.24',
        toOpacity: '0.40',
        drawRects: true
      },
      2: {
        rank: 2,
        color: '#00c2ff',
        strokeWidth: '5.5',
        opacity: '0.85',
        filterId: 'cs-glow-blue',
        markerId: 'cs-arrow-blue',
        fromOpacity: '0.14',
        toOpacity: '0.25',
        drawRects: true
      },
      3: {
        rank: 3,
        color: '#ffb800',
        strokeWidth: '4.2',
        opacity: '0.75',
        filterId: 'cs-glow-amber',
        markerId: 'cs-arrow-amber',
        fromOpacity: '0.10',
        toOpacity: '0.18',
        drawRects: true
      }
    };

    // Если дебютная книга
    if (meta.isBook) {
      const bookStyle = {
        rank: 1,
        color: '#c084fc',
        strokeWidth: '7.5',
        opacity: '1.0',
        filterId: 'cs-glow-purple',
        markerId: 'cs-arrow-purple',
        fromOpacity: '0.25',
        toOpacity: '0.42',
        drawRects: true,
        isSelected: true
      };
      this.drawSingleArrow(layer, selectedMoveUci || lines[0].uci, bookStyle, rect, meta.isFlipped);
      return;
    }

    // Отрисовываем в обратном порядке: сначала Топ-3, затем Топ-2, а в конце Топ-1 поверх всех
    const sortedLines = [...lines].sort((a, b) => {
      const rankA = a.multipv || a.rank || 1;
      const rankB = b.multipv || b.rank || 1;
      return rankB - rankA; // 3, потом 2, потом 1
    });

    const displayed = sortedLines.filter(item => (item.multipv || item.rank || 1) <= 3 || item.uci === selectedMoveUci);
    displayed.forEach((item) => {
      const rank = item.multipv || item.rank || 1;
      const baseStyle = styleMap[rank] || styleMap[3];
      const isSelected = item.uci === selectedMoveUci;

      const style = {
        ...baseStyle,
        isSelected
      };

      this.drawSingleArrow(layer, item.uci, style, rect, meta.isFlipped);
    });

    console.log(`[VisualOverlay] 🎯 Отрисованы мульти-стрелки Top 1–${lines.length} (Выбран: ${selectedMoveUci || lines[0]?.uci})`);
  }

  /**
   * Одиночная отрисовка стрелки хода (для совместимости)
   */
  renderMove(uciMove, meta = {}) {
    this.currentMove = { uciMove, meta };
    if (!this.isVisible || !uciMove || uciMove.length < 4) {
      this.clear(false);
      return;
    }

    if (!this.boardElement || !document.contains(this.boardElement)) {
      this.boardElement = document.querySelector('wc-chess-board, #board-layout-chessboard .board, .board-layout-main .board, chess-board, #board-single, cg-board, #test-board');
    }
    if (!this.boardElement) return;

    const svg = this.ensureSvg(this.boardElement);
    const rect = this.boardElement.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;

    const layer = svg.querySelector('.cs-draw-layer');
    if (!layer) return;
    layer.innerHTML = '';

    let color = '#00f59b';
    let filterId = 'cs-glow-green';
    let markerId = 'cs-arrow-green';

    if (meta.rank === 2) {
      color = '#00c2ff';
      filterId = 'cs-glow-blue';
      markerId = 'cs-arrow-blue';
    } else if (meta.rank === 3) {
      color = '#ffb800';
      filterId = 'cs-glow-amber';
      markerId = 'cs-arrow-amber';
    } else if (meta.isBook || meta.rank === 'book') {
      color = '#c084fc';
      filterId = 'cs-glow-purple';
      markerId = 'cs-arrow-purple';
    }

    this.drawSingleArrow(
      layer,
      uciMove,
      {
        rank: meta.rank || 1,
        color,
        filterId,
        markerId,
        strokeWidth: '7',
        opacity: '1.0',
        fromOpacity: '0.22',
        toOpacity: '0.38',
        drawRects: true,
        isSelected: true
      },
      rect,
      meta.isFlipped
    );
  }

  clear(reset = true) {
    if (reset) {
      this.currentMove = null;
      this.currentMultiData = null;
    }
    if (this.svg) {
      const layer = this.svg.querySelector('.cs-draw-layer');
      if (layer) layer.innerHTML = '';
    }
  }

  toggleVisible() {
    this.isVisible = !this.isVisible;
    if (!this.isVisible) {
      if (this.svg) this.svg.querySelector('.cs-draw-layer')?.replaceChildren();
    } else if (this.currentMultiData && this.currentMultiData.lines && this.currentMultiData.lines.length > 0) {
      this.renderMultiMoves(this.currentMultiData.lines, this.currentMultiData.selectedMoveUci, this.currentMultiData.meta);
    } else if (this.currentMove) {
      this.renderMove(this.currentMove.uciMove, this.currentMove.meta);
    }
    return this.isVisible;
  }

  toggleMultiArrows() {
    this.showAllTopMoves = !this.showAllTopMoves;
    if (this.currentMultiData) {
      this.renderMultiMoves(this.currentMultiData.lines, this.currentMultiData.selectedMoveUci, this.currentMultiData.meta);
    }
    return this.showAllTopMoves;
  }
}

if (typeof module !== 'undefined') {
  module.exports = { VisualOverlay };
}

