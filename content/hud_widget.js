/**
 * HudWidget - Компактный тактический HUD-виджет Chess Sensei.
 * Отображает:
 * 1. Рекомендованный ход с рейтингом качества (Топ-1..3 / Книга / Человеческая игра) и кнопкой Re-roll
 * 2. Детальный список линий MultiPV со скроллом и оценками позиций (cp / mate)
 * 3. Таймер человеческой задержки хода («ХОДИ СЕЙЧАС»)
 * 4. Индикатор движка (NNUE WASM / JS / Native Python Bridge)
 * 5. Контроль точности игры (Live Accuracy), статистику сессии и быстрый выбор ELO / цвета / персоны
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
    this.engineSource = 'wasm'; // 'wasm' | 'native' | 'nnue'

    this.init();
  }

  setMoveActionStatus(message) {
    if (!this.container) return;
    const el = this.container.querySelector('#cs-move-action');
    if (el) el.textContent = message;
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
      <!-- Header -->
      <header class="cs-hud-header" id="cs-hud-drag-handle">
        <div class="cs-hud-brand">
          <span class="cs-hud-title">
            <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.2">
              <path d="M19 21H5M12 3v3M8 6h8M9 9h6l1 5H8l1-5zM9 14l-2 7h10l-2-7" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
            <span>Sensei</span>
            <span id="cs-version" style="font-size:9.5px;color:#64748b;font-weight:500;">1.4.0</span>
          </span>
          <span class="cs-engine-badge" id="cs-engine-badge">⏳ Движок</span>
        </div>
        <div class="cs-hud-controls cs-hud-actions">
          <button type="button" class="cs-btn-icon active" id="cs-btn-multi" title="Показывать 3 стрелки или 1 (клик для переключения)">3x</button>
          <button type="button" class="cs-btn-icon active" id="cs-btn-vis" title="Скрыть/показать стрелки на доске (H)">👁️</button>
          <button type="button" class="cs-btn-icon" id="cs-btn-min" title="Свернуть/развернуть виджет">—</button>
        </div>
      </header>

      <!-- Body -->
      <div class="cs-hud-body" id="cs-hud-body">
        <!-- Top Toolbar: Persona & Color -->
        <div class="cs-hud-toolbar">
          <div class="cs-persona-wrap">
            <span id="cs-persona-badge" class="cs-persona-badge"></span>
            <select id="cs-persona-select" aria-label="Стиль игры">
              ${Object.entries(HudPersonas.PERSONAS).map(([id, persona]) => `<option value="${id}">${persona.icon} ${persona.name}</option>`).join('')}
            </select>
          </div>
          <div class="cs-color-switcher" role="group" aria-label="Мой цвет">
            <button type="button" class="cs-color-btn ${this.currentColorMode === 'auto' ? 'active' : ''}" data-color="auto" id="cs-col-auto" title="Автоопределение цвета">Auto</button>
            <button type="button" class="cs-color-btn ${this.currentColorMode === 'w' ? 'active' : ''}" data-color="w" id="cs-col-white" title="Играю белыми">W</button>
            <button type="button" class="cs-color-btn ${this.currentColorMode === 'b' ? 'active' : ''}" data-color="b" id="cs-col-black" title="Играю черными">B</button>
          </div>
        </div>

        <!-- Hero Move Card -->
        <div class="cs-hero-move-card cs-move-section">
          <div class="cs-hero-top">
            <span class="cs-rank-pill" id="cs-rank-pill">Ожидание...</span>
            <span class="cs-eval-text" id="cs-eval-text">Оценка: 0.0</span>
          </div>
          <div class="cs-hero-main cs-move-main">
            <span class="cs-move-badge" id="cs-move-text">—</span>
            <button type="button" class="cs-btn-reroll" id="cs-btn-reroll" title="Случайно выбрать другой допустимый ход (Re-roll)">🎲</button>
          </div>
          <div class="cs-hero-meta cs-meta-row">
            <span class="cs-opening-text" id="cs-opening-text"></span>
            <div id="cs-move-action" class="cs-move-action" role="status" aria-live="polite">Пробел — выполнить выбранный ход</div>
          </div>
        </div>

        <!-- Timer / Human Delay Bar -->
        <div class="cs-timer-section">
          <div class="cs-timer-header">
            <span class="cs-timer-label" id="cs-timer-status">⏳ Расчет времени...</span>
            <span class="cs-timer-sec" id="cs-timer-val">0.0s</span>
          </div>
          <div class="cs-timer-bar-wrap cs-progress-bar-bg">
            <div class="cs-progress-bar-fill" id="cs-timer-progress"></div>
          </div>
        </div>

        <!-- MultiPV Candidates List -->
        <div class="cs-multipv-block" id="cs-multipv-block">
          <div class="cs-multipv-list" id="cs-multipv-list">
            <div class="cs-multipv-empty">Ожидание позиции...</div>
          </div>
        </div>

        <!-- Secondary Controls: Quick ELO & Accuracy -->
        <div class="cs-hud-subgrid">
          <div class="cs-elo-buttons" id="cs-elo-buttons">
            <button type="button" class="cs-elo-btn" data-elo="1000">1000</button>
            <button type="button" class="cs-elo-btn" data-elo="1400">1400</button>
            <button type="button" class="cs-elo-btn" data-elo="1800">1800</button>
            <button type="button" class="cs-elo-btn" data-elo="2200">2200</button>
            <button type="button" class="cs-elo-btn" data-elo="2600">2600</button>
          </div>
          <div class="cs-accuracy-section">
            <span class="cs-acc-val" id="cs-acc-val">—</span>
            <span class="cs-acc-badge safe" id="cs-acc-badge">Норма</span>
          </div>
        </div>

        <!-- Game Session Stats -->
        <div id="cs-game-stats" role="status">Нет завершённых партий</div>
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
        visBtn.classList.toggle('active', isVis);
        visBtn.style.opacity = isVis ? '1' : '0.4';
      }
    });

    // Переключение режима 3 стрелки / 1 стрелка
    const multiBtn = this.container.querySelector('#cs-btn-multi');
    multiBtn.addEventListener('click', () => {
      this.showMultiArrows = !this.showMultiArrows;
      multiBtn.classList.toggle('active', this.showMultiArrows);
      multiBtn.textContent = this.showMultiArrows ? '3x' : '1x';
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
    if (!this.container) return;
    const eloBtns = this.container.querySelectorAll('.cs-elo-btn');
    eloBtns.forEach(btn => {
      const elo = parseInt(btn.dataset.elo, 10);
      btn.classList.toggle('active', elo === this.currentElo);
    });
  }

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
    if (!this.container) return;
    const badge = this.container.querySelector('#cs-engine-badge');
    if (!badge) return;

    badge.className = 'cs-engine-badge';
    if (source === 'unavailable') {
      badge.classList.add('fallback');
      badge.textContent = '⚠️ Недоступен';
      badge.title = 'Расчёт не выполнен; нажмите Re-roll для повторного запуска';
    } else if (source === 'book') {
      badge.textContent = '📖 Книга';
      badge.title = 'Ход из дебютной книги';
    } else if (source === 'nnue') {
      badge.classList.add('nnue');
      badge.textContent = '🧠 NNUE';
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

  showOpponentThinking(turnColor) {
    if (!this.container) return;
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

  showCalculating() {
    if (!this.container) return;
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

  formatScore(score) {
    if (!score) return '+0.0';
    if (score.unit === 'mate') {
      return score.value > 0 ? `#M${score.value}` : `#-M${Math.abs(score.value)}`;
    }
    const val = (score.value / 100).toFixed(2);
    return score.value > 0 ? `+${val}` : `${val}`;
  }

  updateMultiMoves(lines = [], selectedMoveUci = null, meta = {}) {
    if (!this.container) return;
    const listEl = this.container.querySelector('#cs-multipv-list');
    if (!listEl) return;

    if (!lines || lines.length === 0) {
      if (meta.isBook && selectedMoveUci) {
        listEl.innerHTML = `
          <div class="cs-multipv-item selected" style="border-left-color: #c084fc;">
            <div class="cs-mp-rank" style="color: #c084fc;">📖</div>
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
      item.title = unsafe ? 'Ход исключён выбранным профилем' : candidate?.lossCp === null ? 'Оценка ограничена; причина выбора: ' + (candidate.originReasons?.[0] || 'манёвр') : candidate?.isWithinStrictSafety === false ?
        `Допустимая неточность профиля: потеря ${(candidate.lossCp / 100).toFixed(2)} пешки` : 'Выбрать этот ход';

      const moveFormatted = line.uci && line.uci.length >= 4
        ? `${line.uci.slice(0, 2)} → ${line.uci.slice(2, 4)}`
        : line.uci;

      const scoreFormatted = this.formatScore(line.score);

      item.innerHTML = `
        <span class="cs-mp-rank rank-${rank}">#${rank}</span>
        <span class="cs-mp-move">${moveFormatted}</span>
        <span class="cs-mp-score">${scoreFormatted}</span>
        ${isSelected ? '<span class="cs-mp-tag">★ Ход</span>' : ''}
      `;

      item.addEventListener('click', () => {
        if (!unsafe && this.onSelectLine) {
          this.onSelectLine(line.uci, rank);
        }
      });
      item.addEventListener('keydown', event => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          item.click();
        }
      });

      listEl.appendChild(item);
    });
  }

  updateMove(moveData) {
    if (!moveData || !this.container) return;
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

  updateGameStats(summary, adaptive = false, pending = false, profile = null) {
    if (!this.container) return;
    let element = this.container.querySelector('#cs-game-stats');
    if (!element) {
      element = document.createElement('div');
      element.id = 'cs-game-stats';
      element.setAttribute('role', 'status');
      this.container.querySelector('#cs-hud-body').appendChild(element);
    }
    const n = summary.total || summary.games;
    const rate = summary.games ? summary.metric === 'score' ? `${Math.round(summary.scoreRate * 100)}% очков · ${summary.wins}/${summary.games} побед` : `${summary.wins}/${summary.games} побед (${Math.round(summary.winRate * 100)}%)` : 'нет завершённых партий';
    element.textContent = `${adaptive ? `Цель ${Math.round(summary.target * 100)}% · ` : ''}${rate}` +
      (adaptive && (n < 20 || summary.status === 'collecting') ? ' · собираем данные' : adaptive && summary.status === 'limit' ? ' · предел силы' : '') +
      (adaptive && summary.status === 'target' ? summary.confirmed ? ' · диапазон подтверждён' : ' · предварительно в диапазоне' : '') +
      (profile?.humanPolicyVersion === 2 ? ` · сила ${profile.baseLevel} → ${profile.level}` : '') +
      (pending ? ' · новый профиль со следующей партии' : '');
    element.title = summary.games ? `Ничьи: ${summary.draws}; поражения: ${summary.losses}. Интервал ${summary.metric === 'score' ? 'доли очков' : 'доли побед'}: ${Math.round(summary.low * 100)}–${Math.round(summary.high * 100)}%.` : 'Результаты учитываются только после подтверждения окончания партии.';
  }

  updateTimerProgress({ remainingSec, progressPercent, isReady, reason = 'Обдумывание' }) {
    if (!this.container) return;
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
    if (!accData || !this.container) return;
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
