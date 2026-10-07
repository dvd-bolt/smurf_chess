/**
 * HudWidget - Плавающий неоновый HUD-виджет для обучения на Chess.com.
 * Отображает:
 * 1. Рекомендованный ход с рейтингом качества (Топ-1..3)
 * 2. Детальный список линий MultiPV (Топ 1–3) с оценками позиций (cp / mate)
 * 3. Таймер обучающей задержки хода («ХОДИ СЕЙЧАС»)
 * 4. Индикатор движка (⚡ JS в браузере или 🚀 Native Python Bridge)
 * 5. Контроль точности игры (Live Accuracy) и переключатель ELO
 * 6. Переключатель режима стрелок (3 стрелки ⇄ 1 стрелка)
 */

const HudPersonas = typeof PersonaStyles !== 'undefined' ? PersonaStyles : (typeof require === 'function' ? require('../engine/personas.js') : null);
class HudWidget {
  constructor(options = {}) {
    this.container = null;
    this.onReroll = options.onReroll || null;
    this.onEloChange = options.onEloChange || null;
    this.onColorChange = options.onColorChange || null;
    this.onToggleOverlay = options.onToggleOverlay || null;
    this.onToggleMulti = options.onToggleMulti || null;
    this.onSelectLine = options.onSelectLine || null;
    this.onPersonaChange = options.onPersonaChange || null;
    this.aiPersona = HudPersonas.normalizePersona(options.aiPersona);

    this.currentElo = options.currentElo || 1500;
    this.currentColorMode = options.currentColorMode || 'auto';
    this.isMinimized = false;
    this.showMultiArrows = true;
    this.engineSource = 'wasm'; // 'wasm' | 'native'

    this.init();
  }

  setMoveActionStatus(message) {
    this.container.querySelector('#cs-move-action').textContent = message;
  }

  init() {
    if (typeof document === 'undefined') return;
    if (document.getElementById('chess-sensei-hud')) return;

    this.container = document.createElement('div');
    this.container.id = 'chess-sensei-hud';
    this.container.className = 'cs-hud-container';

    // Восстанавливаем позицию из localStorage
    const savedPos = localStorage.getItem('cs_hud_pos');
    if (savedPos) {
      try {
        const { x, y } = JSON.parse(savedPos);
        this.container.style.left = `${Math.max(10, Math.min(window.innerWidth - 300, x))}px`;
        this.container.style.top = `${Math.max(10, Math.min(window.innerHeight - 200, y))}px`;
        this.container.style.right = 'auto';
      } catch (e) {}
    }

    this.container.innerHTML = `
      <div class="cs-hud-header" id="cs-hud-drag-handle">
        <div class="cs-hud-title">
          <span class="cs-hud-icon">👑</span>
          <span class="cs-hud-name">Chess Sensei</span>
          <span id="cs-version" style="font-size:10px;color:#94a3b8">1.3.0</span>
          <span class="cs-engine-badge" id="cs-engine-badge">⏳ Движок</span>
        </div>
        <div class="cs-hud-actions">
          <button class="cs-btn-icon active" id="cs-btn-multi" title="Показывать 3 стрелки или 1 (клик для переключения)">🎯 3</button>
          <button class="cs-btn-icon" id="cs-btn-vis" title="Скрыть/показать стрелки на доске (H)">👁️</button>
          <button class="cs-btn-icon" id="cs-btn-min" title="Свернуть/развернуть виджет">—</button>
        </div>
      </div>

      <div class="cs-hud-body" id="cs-hud-body">
        <div class="cs-persona-row">
          <span id="cs-persona-badge" class="cs-persona-badge"></span>
          <select id="cs-persona-select" aria-label="Стиль игры">
            ${Object.entries(HudPersonas.PERSONAS).map(([id, persona]) => `<option value="${id}">${persona.icon} ${persona.name}</option>`).join('')}
          </select>
        </div>
        <!-- Переключатель цвета игрока -->
        <div class="cs-color-section">
          <span class="cs-section-label">Мой цвет:</span>
          <div class="cs-color-buttons">
            <button class="cs-color-btn active" data-color="auto" id="cs-col-auto">🔄 Авто</button>
            <button class="cs-color-btn" data-color="w" id="cs-col-white">⚪ Белые</button>
            <button class="cs-color-btn" data-color="b" id="cs-col-black">⚫ Черные</button>
          </div>
        </div>

        <!-- Блок рекомендованного хода -->
        <div class="cs-move-section">
          <div class="cs-move-main">
            <span class="cs-move-badge" id="cs-move-text">—</span>
            <span class="cs-rank-pill" id="cs-rank-pill">Ожидание...</span>
          </div>
          <div class="cs-meta-row">
            <span class="cs-eval-text" id="cs-eval-text">Оценка: 0.0</span>
            <span class="cs-opening-text" id="cs-opening-text"></span>
          </div>

          <div id="cs-move-action" class="cs-move-action" role="status" aria-live="polite">Пробел — выполнить выбранный ход</div>
          <!-- Список линий анализа MultiPV (Топ 1-3) -->
          <div class="cs-multipv-block" id="cs-multipv-block">
            <div class="cs-multipv-list" id="cs-multipv-list">
              <div class="cs-multipv-empty">Ожидание позиции...</div>
            </div>
          </div>
        </div>

        <!-- Таймер обдумывания хода (Человеческая задержка) -->
        <div class="cs-timer-section">
          <div class="cs-timer-header">
            <span class="cs-timer-label" id="cs-timer-status">⏳ Расчет времени...</span>
            <span class="cs-timer-sec" id="cs-timer-val">0.0s</span>
          </div>
          <div class="cs-progress-bar-bg">
            <div class="cs-progress-bar-fill" id="cs-timer-progress"></div>
          </div>
        </div>

        <!-- Контроль точности игры (Live Accuracy) -->
        <div class="cs-accuracy-section">
          <div class="cs-accuracy-row">
            <span class="cs-acc-title">🎯 Точность:</span>
            <span class="cs-acc-val" id="cs-acc-val">—</span>
            <span class="cs-acc-badge" id="cs-acc-badge">Норма</span>
          </div>
        </div>

        <!-- Селектор ELO -->
        <div class="cs-elo-section">
          <span class="cs-section-label">Рейтинг ELO:</span>
          <div class="cs-elo-buttons" id="cs-elo-buttons">
            <button class="cs-elo-btn" data-elo="1000">1000</button>
            <button class="cs-elo-btn" data-elo="1400">1400</button>
            <button class="cs-elo-btn" data-elo="1800">1800</button>
            <button class="cs-elo-btn" data-elo="2200">2200</button>
            <button class="cs-elo-btn" data-elo="2600">2600</button>
          </div>
        </div>

        <!-- Кнопка Re-roll -->
        <div class="cs-controls-row">
          <button class="cs-btn-reroll" id="cs-btn-reroll" title="Случайно выбрать другой допустимый ход из Топ-3">
            <span>🎲</span> Перебросить ход (Re-roll)
          </button>
        </div>
      </div>
    `;

    document.body.appendChild(this.container);
    this.setupEvents();
    this.updateEloActiveButton();
    this.setPersona(this.aiPersona);
  }

  setupEvents() {
    this.container.querySelector('#cs-persona-select').addEventListener('change', event => {
      this.setPersona(event.target.value);
      if (this.onPersonaChange) this.onPersonaChange(this.aiPersona);
    });
    // Перетаскивание
    const handle = this.container.querySelector('#cs-hud-drag-handle');
    let isDragging = false, startX, startY, initialX, initialY;

    handle.addEventListener('mousedown', (e) => {
      if (e.target.closest('.cs-btn-icon')) return;
      isDragging = true;
      startX = e.clientX;
      startY = e.clientY;
      const rect = this.container.getBoundingClientRect();
      initialX = rect.left;
      initialY = rect.top;
      document.body.style.userSelect = 'none';
    });

    window.addEventListener('mousemove', (e) => {
      if (!isDragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      const newX = initialX + dx;
      const newY = initialY + dy;
      this.container.style.left = `${newX}px`;
      this.container.style.top = `${newY}px`;
      this.container.style.right = 'auto';
    });

    window.addEventListener('mouseup', () => {
      if (isDragging) {
        isDragging = false;
        document.body.style.userSelect = '';
        const rect = this.container.getBoundingClientRect();
        localStorage.setItem('cs_hud_pos', JSON.stringify({ x: rect.left, y: rect.top }));
      }
    });

    // Сворачивание
    const minBtn = this.container.querySelector('#cs-btn-min');
    minBtn.addEventListener('click', () => {
      this.isMinimized = !this.isMinimized;
      this.container.classList.toggle('cs-minimized', this.isMinimized);
      minBtn.textContent = this.isMinimized ? '+' : '—';
    });

    // Видимость стрелок (H)
    const visBtn = this.container.querySelector('#cs-btn-vis');
    visBtn.addEventListener('click', () => {
      if (this.onToggleOverlay) {
        const isVis = this.onToggleOverlay();
        visBtn.style.opacity = isVis ? '1' : '0.4';
      }
    });

    // Переключение режима 3 стрелки / 1 стрелка
    const multiBtn = this.container.querySelector('#cs-btn-multi');
    multiBtn.addEventListener('click', () => {
      this.showMultiArrows = !this.showMultiArrows;
      multiBtn.classList.toggle('active', this.showMultiArrows);
      multiBtn.textContent = this.showMultiArrows ? '🎯 3' : '🎯 1';
      multiBtn.title = this.showMultiArrows ? 'Показываются 3 стрелки (клик для 1)' : 'Показывается 1 стрелка (клик для 3)';
      if (this.onToggleMulti) {
        this.onToggleMulti(this.showMultiArrows);
      }
    });

    // Re-roll
    const rerollBtn = this.container.querySelector('#cs-btn-reroll');
    rerollBtn.addEventListener('click', () => {
      if (this.onReroll) this.onReroll();
    });

    // Выбор цвета игрока
    const colorBtns = this.container.querySelectorAll('.cs-color-btn');
    colorBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        colorBtns.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const color = btn.dataset.color;
        this.currentColorMode = color;
        if (this.onColorChange) this.onColorChange(color);
      });
    });

    // Выбор ELO
    const eloBtns = this.container.querySelectorAll('.cs-elo-btn');
    eloBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        const elo = parseInt(btn.dataset.elo, 10);
        this.currentElo = elo;
        this.updateEloActiveButton();
        if (this.onEloChange) this.onEloChange(elo);
      });
    });

    // Горячая клавиша H
    window.addEventListener('keydown', (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
      if (e.key === 'h' || e.key === 'H' || e.code === 'KeyH') {
        visBtn.click();
      }
    });
  }

  updateEloActiveButton() {
    const eloBtns = this.container.querySelectorAll('.cs-elo-btn');
    eloBtns.forEach(btn => {
      const elo = parseInt(btn.dataset.elo, 10);
      btn.classList.toggle('active', elo === this.currentElo);
    });
  }

  /**
   * Установка бейджа движка (JS или Native Python Bridge)
   */
  setPersona(value) {
    this.aiPersona = HudPersonas.normalizePersona(value);
    if (!this.container) return;
    const persona = HudPersonas.PERSONAS[this.aiPersona];
    const badge = this.container.querySelector('#cs-persona-badge');
    badge.textContent = `${persona.icon} ${persona.name}`;
    badge.title = persona.description;
    this.container.querySelector('#cs-persona-select').value = this.aiPersona;
  }

  setEngineSource(source, isFallback = false, metadata = {}) {
    this.engineSource = source;
    const badge = this.container.querySelector('#cs-engine-badge');
    if (!badge) return;

    badge.className = 'cs-engine-badge';
    if (source === 'unavailable') {
      badge.classList.add('fallback');
      badge.textContent = '⚠️ Движок недоступен';
      badge.title = 'Расчёт не выполнен; нажмите Re-roll для повторного запуска';
    } else if (source === 'book') {
      badge.textContent = '📖 Книга';
      badge.title = 'Ход из дебютной книги';
    } else if (source === 'nnue') {
      badge.classList.add('nnue');
      badge.textContent = '🧠 NNUE (WASM)';
      badge.title = `${metadata.engineName || 'Stockfish 19 Lite'}; ${metadata.nnueNetwork || 'Встроенная NNUE'}${metadata.elapsedMs != null ? `; ${metadata.elapsedMs} мс` : ''}${isFallback ? '; Python Bridge недоступен' : ''}`;
    } else if (source === 'native') {
      badge.classList.add('native');
      badge.textContent = '🚀 Native';
      badge.title = 'Используется мощный локальный Stockfish (Python Bridge)';
    } else if (isFallback) {
      badge.classList.add('fallback');
      badge.textContent = metadata.engineTransport === 'frame' ? '⚡ Stockfish JS (резерв)' : '⚡ JS (Auto)';
      badge.title = metadata.fallbackReason || 'Мост недоступен, автоматический переход на встроенный JS';
    } else {
      badge.classList.add('wasm');
      badge.textContent = '⚡ JS';
      badge.title = 'Используется автономный JavaScript Stockfish в браузере';
    }
  }

  /**
   * Отображение состояния, когда ходит соперник
   */
  showOpponentThinking(turnColor) {
    const moveTextEl = this.container.querySelector('#cs-move-text');
    const rankPillEl = this.container.querySelector('#cs-rank-pill');
    const evalTextEl = this.container.querySelector('#cs-eval-text');
    const openingTextEl = this.container.querySelector('#cs-opening-text');
    const statusEl = this.container.querySelector('#cs-timer-status');
    const valEl = this.container.querySelector('#cs-timer-val');
    const barEl = this.container.querySelector('#cs-timer-progress');
    const listEl = this.container.querySelector('#cs-multipv-list');

    moveTextEl.textContent = '⏳ Ожидание';
    rankPillEl.textContent = 'Ход соперника';
    rankPillEl.className = 'cs-rank-pill';
    evalTextEl.textContent = `Сейчас ходит ${turnColor === 'w' ? 'Белые' : 'Черные'}...`;
    openingTextEl.textContent = '';
    statusEl.textContent = '⏳ Соперник думает';
    statusEl.classList.remove('ready-pulse');
    valEl.textContent = '—';
    barEl.style.width = '0%';
    barEl.classList.remove('ready');

    if (listEl) {
      listEl.innerHTML = '<div class="cs-multipv-empty">Ожидание хода соперника...</div>';
    }
  }

  /**
   * Отображение состояния, когда движок рассчитывает позицию
   */
  showCalculating() {
    const moveTextEl = this.container.querySelector('#cs-move-text');
    const rankPillEl = this.container.querySelector('#cs-rank-pill');
    const evalTextEl = this.container.querySelector('#cs-eval-text');
    const listEl = this.container.querySelector('#cs-multipv-list');

    moveTextEl.textContent = '⏳ Расчет...';
    rankPillEl.textContent = 'Stockfish';
    rankPillEl.className = 'cs-rank-pill';
    evalTextEl.textContent = 'Поиск лучших линий...';
    if (listEl) {
      listEl.innerHTML = '<div class="cs-multipv-empty">Анализ вариантов MultiPV...</div>';
    }
  }

  showWaiting(message = 'Движок недоступен. Повторите анализ.') {
    if (!this.container) return;
    this.container.querySelector('#cs-move-text').textContent = '—';
    this.container.querySelector('#cs-rank-pill').textContent = 'Ожидание';
    this.container.querySelector('#cs-eval-text').textContent = message;
    this.container.querySelector('#cs-opening-text').textContent = '';
    this.container.querySelector('#cs-multipv-list').textContent = message;
    this.setTimerEnabled(false);
  }

  setTimerEnabled(enabled) {
    if (!this.container) return;
    if (!enabled) {
      const status = this.container.querySelector('#cs-timer-status');
      status.textContent = 'Таймер выключен';
      status.classList.remove('ready-pulse');
      this.container.querySelector('#cs-timer-val').textContent = '—';
      const bar = this.container.querySelector('#cs-timer-progress');
      bar.style.width = '0%';
      bar.classList.remove('ready');
    }
  }

  /**
   * Форматирование оценки хода
   */
  formatScore(score) {
    if (!score) return '+0.0';
    if (score.unit === 'mate') {
      return score.value > 0 ? `#M${score.value}` : `#-M${Math.abs(score.value)}`;
    }
    const val = (score.value / 100).toFixed(2);
    return score.value > 0 ? `+${val}` : `${val}`;
  }

  /**
   * Обновление списка Top 1–3 линий в HUD
   */
  updateMultiMoves(lines = [], selectedMoveUci = null, meta = {}) {
    const listEl = this.container.querySelector('#cs-multipv-list');
    if (!listEl) return;

    if (!lines || lines.length === 0) {
      if (meta.isBook && selectedMoveUci) {
        listEl.innerHTML = `
          <div class="cs-multipv-item selected" style="border-left-color: #c084fc;">
            <div class="cs-mp-rank" style="background: rgba(192, 132, 252, 0.2); color: #c084fc;">📖</div>
            <div class="cs-mp-move">${selectedMoveUci.slice(0, 2)} → ${selectedMoveUci.slice(2, 4)}</div>
            <div class="cs-mp-score">Дебют</div>
            <div class="cs-mp-tag">Книга</div>
          </div>
        `;
      } else {
        listEl.innerHTML = '<div class="cs-multipv-empty">Ожидание анализа...</div>';
      }
      return;
    }

    listEl.innerHTML = '';
    const sorted = [...lines].sort((a, b) => (a.multipv || a.rank || 1) - (b.multipv || b.rank || 1));

    const displayed = meta.human ? sorted.slice(0, 8) : sorted.slice(0, 3);
    if (!displayed.some(line => line.uci === selectedMoveUci)) {
      const selected = sorted.find(line => line.uci === selectedMoveUci);
      if (selected) displayed.push(selected);
    }
    displayed.forEach((line) => {
      const rank = line.multipv || line.rank || 1;
      const isSelected = line.uci === selectedMoveUci;
      const bestScore = lines.reduce((best, candidate) => Math.max(best, candidate.score?.unit === 'mate' ? (candidate.score.value > 0 ? 20000 - candidate.score.value * 100 : -20000 - candidate.score.value * 100) : candidate.score?.value || 0), -Infinity);
      const scoreCp = line.score?.unit === 'mate' ? (line.score.value > 0 ? 20000 - line.score.value * 100 : -20000 - line.score.value * 100) : line.score?.value || 0;
      const candidate = meta.candidates?.find(item => item.uci === line.uci);
      const unsafe = !meta.isBook && (candidate ? !(candidate.isAllowedByProfile ?? candidate.isSafe) : bestScore - scoreCp > 160);

      const item = document.createElement('div');
      item.className = `cs-multipv-item rank-${rank} ${isSelected ? 'selected' : ''} ${unsafe ? 'unsafe' : ''}`;
      item.tabIndex = unsafe ? -1 : 0;
      item.setAttribute('role', 'button');
      item.setAttribute('aria-disabled', String(unsafe));
      item.title = unsafe ? 'Ход исключён выбранным профилем' : candidate?.isWithinStrictSafety === false ?
        `Допустимая неточность профиля: потеря ${(candidate.lossCp / 100).toFixed(2)} пешки` : 'Выбрать этот ход';

      const moveFormatted = line.uci && line.uci.length >= 4
        ? `${line.uci.slice(0, 2)} → ${line.uci.slice(2, 4)}`
        : line.uci;

      const scoreFormatted = this.formatScore(line.score);

      item.innerHTML = `
        <div class="cs-mp-rank rank-${rank}">${rank}</div>
        <div class="cs-mp-move">${moveFormatted}</div>
        <div class="cs-mp-score">${scoreFormatted}</div>
        ${isSelected ? '<div class="cs-mp-tag">★ Рекомендован</div>' : ''}
      `;

      item.addEventListener('click', () => {
        if (!unsafe && this.onSelectLine) {
          this.onSelectLine(line.uci, rank);
        }
      });
      item.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); item.click(); } });

      listEl.appendChild(item);
    });
  }

  /**
   * Обновление информации о главном ходе
   */
  updateMove(moveData) {
    if (!moveData) return;
    const moveTextEl = this.container.querySelector('#cs-move-text');
    const rankPillEl = this.container.querySelector('#cs-rank-pill');
    const evalTextEl = this.container.querySelector('#cs-eval-text');
    const openingTextEl = this.container.querySelector('#cs-opening-text');

    let uci = moveData.move || '';
    if (uci.length >= 4) {
      moveTextEl.textContent = `${uci.slice(0, 2)} → ${uci.slice(2, 4)}`;
    } else {
      moveTextEl.textContent = uci || '—';
    }

    rankPillEl.textContent = moveData.rankLabel || 'Топ-1';
    rankPillEl.className = 'cs-rank-pill';
    if (moveData.rank === 1) rankPillEl.classList.add('rank-1');
    else if (moveData.rank === 2) rankPillEl.classList.add('rank-2');
    else if (moveData.rank === 3) rankPillEl.classList.add('rank-3');
    else if (moveData.isBook) rankPillEl.classList.add('rank-book');

    evalTextEl.textContent = `Оценка: ${moveData.scoreText || '+0.0'}`;
    openingTextEl.textContent = moveData.reason || (moveData.openingName ? `📖 ${moveData.openingName}` : '');
  }
  updateGameStats(summary, adaptive = false, pending = false) {
    let element = this.container.querySelector('#cs-game-stats');
    if (!element) {
      element = document.createElement('div');
      element.id = 'cs-game-stats';
      element.style.cssText = 'font-size:11px;color:#94a3b8;margin:8px 0;line-height:1.5';
      element.setAttribute('role', 'status');
      this.container.querySelector('.cs-timer-section').after(element);
    }
    const n = summary.total || summary.games;
    const rate = summary.games ? summary.metric === 'score' ? `${Math.round(summary.scoreRate * 100)}% очков · ${summary.wins}/${summary.games} побед` : `${summary.wins}/${summary.games} побед (${Math.round(summary.winRate * 100)}%)` : 'нет завершённых партий';
    element.textContent = `${adaptive ? `Цель ${Math.round(summary.target * 100)}% · ` : ''}${rate}` +
      (adaptive && n < 20 ? ' · собираем данные' : adaptive && summary.status === 'limit' ? ' · предел силы' : '') +
      (pending ? ' · новый профиль со следующей партии' : '');
    element.title = summary.games ? `Ничьи: ${summary.draws}; поражения: ${summary.losses}. Интервал ${summary.metric === 'score' ? 'доли очков' : 'доли побед'}: ${Math.round(summary.low * 100)}–${Math.round(summary.high * 100)}%.` : 'Результаты учитываются только после подтверждения окончания партии.';
  }

  updateTimerProgress({ remainingSec, progressPercent, isReady, reason = 'Обдумывание' }) {
    const statusEl = this.container.querySelector('#cs-timer-status');
    statusEl.title = reason;
    const valEl = this.container.querySelector('#cs-timer-val');
    const barEl = this.container.querySelector('#cs-timer-progress');

    if (isReady) {
      statusEl.textContent = '✅ ХОДИ СЕЙЧАС!';
      statusEl.classList.add('ready-pulse');
      valEl.textContent = 'Готово';
      barEl.style.width = '100%';
      barEl.classList.add('ready');
    } else {
      statusEl.textContent = `⏳ ${reason}:`;
      statusEl.classList.remove('ready-pulse');
      valEl.textContent = `${remainingSec}s`;
      barEl.style.width = `${progressPercent}%`;
      barEl.classList.remove('ready');
    }
  }

  updateAccuracy(accData) {
    if (!accData) return;
    const valEl = this.container.querySelector('#cs-acc-val');
    const badgeEl = this.container.querySelector('#cs-acc-badge');

    valEl.textContent = accData.movesAnalyzed ? `≈${accData.accuracy}%` : '—';
    valEl.title = `Оценка по ${accData.movesAnalyzed || 0} фактически сыгранным ходам; средняя потеря ${accData.avgCpl || 0} cp`;
    badgeEl.textContent = accData.statusLabel || 'Норма';
    badgeEl.className = 'cs-acc-badge';
    if (accData.warning) {
      badgeEl.classList.add('warning');
    } else {
      badgeEl.classList.add('safe');
    }
  }
}

if (typeof module !== 'undefined') {
  module.exports = { HudWidget };
}
