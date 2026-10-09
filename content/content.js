/** UI coordinator. Every response is tied to the complete position and request generation. */
(function () {
  if (document.getElementById('chess-sensei-hud')) return;
  let engine, detector, timeMgr, overlay, hud, executor;
  let autoAttemptGeneration = null;
  let currentAnalysisResult = null;
  let generation = 0;
  let session = 0;
  let accuracyQueue = Promise.resolve();
  let recordedMoves = new Set();
  let gameSession = new GameSession();
  let statsGroups = {};
  let saveTimer = null;
  let resultPoll = null;
  let reviewing = false;
  let savingResult = false;
  let memoryState = StrengthAdapter.empty();
  const pageKey = location.origin + location.pathname;
  const defaults = { targetElo: 1500, aiPersona: 'balanced', useLocalBridge: false, blunderFilter: true, snowballMode: true, humanDelay: true, autoPlay: false,
    playMode: 'rated', adaptiveStrength: false, targetWinRate: 0.55, humanTargetWinRate: 0.65, ratedTargetScore: 0.55,
    settingsVersion: 2, humanStrengthBias: 170, lichessInputEnabled: false };
  const settings = { ...defaults };
  async function stateMessage(action, extra = {}) {
    const target = extra.target ?? extra.record?.target ?? PlaySettings.target(settings, gameSession.data?.mode || settings.playMode);
    const message = { action, pageKey, target, ...extra };
    if (typeof chrome !== 'undefined' && chrome.runtime?.id) {
      try {
        return await new Promise(resolve => chrome.runtime.sendMessage(message, response => {
          if (chrome.runtime.lastError) resolve({ success: false });
          else resolve(response || { success: false });
        }));
      } catch (_) { return { success: false }; }
    }
    // The standalone board uses the same model without extension APIs.
    try { memoryState = JSON.parse(sessionStorage.getItem('sensei-human-state')) || memoryState; } catch (_) {}
    if (action === 'HUMAN_SESSION_SAVE') memoryState.sessions[pageKey] = extra.session;
    if (action === 'HUMAN_GAME_RECORD') StrengthAdapter.record(memoryState, extra.record, target);
    if (action === 'HUMAN_STATS_RESET') memoryState.groups = {};
    try { sessionStorage.setItem('sensei-human-state', JSON.stringify(memoryState)); } catch (_) {}
    return { success: true, session: memoryState.sessions[pageKey] || null, groups: memoryState.groups,
      summary: StrengthAdapter.current(memoryState, extra.group, target) };
  }
  function saveSession(immediate = false) {
    clearTimeout(saveTimer);
    const save = () => {
      if (gameSession.data) stateMessage('HUMAN_SESSION_SAVE', { session: JSON.parse(JSON.stringify(gameSession.data)) });
    };
    if (immediate) save(); else saveTimer = setTimeout(save, 150);
  }
  function showGameStats() {
    if (!gameSession.data) return;
    const personaSelect = hud.container.querySelector('#cs-persona-select');
    hud.setPersona(settings.playMode === 'rated' ? 'balanced' : settings.aiPersona);
    personaSelect.disabled = settings.playMode === 'rated';
    personaSelect.title = settings.playMode === 'rated' ? 'В рейтинговом режиме ход выбирает ограниченный по ELO Stockfish' : 'Стиль игры';
    const data = gameSession.data;
    const summary = StrengthAdapter.current({ groups: statsGroups }, StrengthAdapter.group(data), data.target ?? PlaySettings.target(settings, data.mode));
    const pending = (settings.playMode !== 'rated' && data.persona !== settings.aiPersona) || data.baseLevel !== settings.targetElo || data.mode !== settings.playMode;
    hud.updateGameStats(summary, data.adaptiveStrength ?? settings.adaptiveStrength, pending, data.profileSnapshot);
  }
  async function checkGameResult() {
    const data = gameSession.data;
    if (!data || savingResult) return;
    if (data.recordPending) { await persistGameResult(data, gameSession.record()); return; }
    if (data.result !== 'unknown' || reviewing || !detector.boardElement || !document.contains(detector.boardElement)) return;
    if (data.site !== 'test' && data.opponentCategory === 'unknown') return;
    const fen = detector.lastFen;
    if (!fen || fen !== data.lastFen) return;
    const record = gameSession.finish(GameContext.result(fen, data.playerColor, detector.boardElement));
    if (!record) return;
    generation++;
    currentAnalysisResult = null;
    timeMgr.stopTimer();
    overlay.clear();
    hud.showWaiting('Партия завершена. Результат сохранён.');
    data.recordPending = true;
    saveSession(true);
    await persistGameResult(data, record);
  }
  async function persistGameResult(data, record) {
    savingResult = true;
    try {
      const response = await stateMessage('HUMAN_GAME_RECORD', { record, group: StrengthAdapter.group(record) });
      if (response.groups) statsGroups = response.groups;
      if (response.success) {
        data.recordPending = false;
        if (gameSession.data === data) {
          saveSession(true);
          if (hud) hud.showWaiting('Партия завершена. Результат сохранён.');
        }
      } else if (hud && gameSession.data === data) hud.showWaiting('Партия завершена. Статистика пока не сохранена.');
      if (hud) showGameStats();
    } finally { savingResult = false; }
  }
  async function ensureGame(fen, transition, userColor, request) {
    const meta = GameContext.read(detector, settings);
    const old = gameSession.data;
    const initial = fen.split(' ')[0] === 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR' && fen.split(' ')[5] === '1';
    const changed = !old || old.route !== meta.route || old.sourceId !== meta.sourceId || old.playerColor !== userColor ||
      (initial && old.lastFen !== fen && !transition && !document.querySelector('wc-move-list .node, .move-list .node, .moves-list .node'));
    if (changed) {
      const response = await stateMessage('HUMAN_STATE_GET', { group: StrengthAdapter.group(meta), target: PlaySettings.target(settings) });
      if (request !== generation) return false;
      if (response.groups) statsGroups = response.groups;
      const offset = settings.adaptiveStrength && ['human', 'rated'].includes(settings.playMode) ? response.summary?.offset || 0 : 0;
      gameSession = new GameSession();
      gameSession.begin(meta, settings, offset, fen);
      engine.setSession(gameSession);
      resetAccuracy();
    }
    if (!changed && !transition) transition = GameOutcomes.transitionBetween(old.lastFen, fen);
    reviewing = GameContext.isHistory(detector.boardElement) || (!changed && !transition && old.lastFen !== fen);
    if (!changed && !reviewing) gameSession.observe(transition);
    if (!reviewing && (changed || transition || gameSession.data.lastFen === fen)) gameSession.data.lastFen = fen;
    saveSession();
    showGameStats();
    await checkGameResult();
    return request === generation ? { transition } : false;
  }

  async function startApp() {
    if (document.getElementById('chess-sensei-hud')) return;
    if (typeof chrome !== 'undefined' && chrome.storage?.sync) {
      try {
        const stored = await chrome.storage.sync.get([...Object.keys(settings), 'ratingPolicyVersion']);
        Object.assign(settings, PlaySettings.normalize(stored));
        if (stored.settingsVersion !== 2) await chrome.storage.sync.set({ settingsVersion: 2,
          humanTargetWinRate: settings.humanTargetWinRate, ratedTargetScore: settings.ratedTargetScore,
          ratingPolicyVersion: RatedProfile.VERSION });
      } catch (error) { console.warn(error); }
    }
    timeMgr = new TimeManager();
    overlay = new VisualOverlay();
    engine = new EngineController(settings);
    const restored = await stateMessage('HUMAN_STATE_GET');
    if (restored.session?.schemaVersion === 1 && (settings.playMode !== 'rated' || restored.session.mode === 'rated')) {
      gameSession = new GameSession(restored.session); engine.setSession(gameSession);
    }
    if (restored.groups) statsGroups = restored.groups;
    if (gameSession.data?.recordPending) await persistGameResult(gameSession.data, gameSession.record());
    hud = new HudWidget({
      currentElo: settings.targetElo,
      aiPersona: settings.aiPersona,
      onPersonaChange: aiPersona => applySettings({ aiPersona }, true),
      onReroll: handleReroll,
      onEloChange: elo => applySettings({ targetElo: elo }, true),
      onColorChange: color => {
        detector.userColorOverride = color === 'auto' ? null : color;
        resetAccuracy();
        refresh();
      },
      onToggleOverlay: () => overlay.toggleVisible(),
      onToggleMulti: showMulti => {
        overlay.showAllTopMoves = showMulti;
        drawCurrent();
      },
      onSelectLine: selectLine
    });
    hud.updateAccuracy(engine.moveSelector.getLiveAccuracy());
    detector = new BoardDetector({ onPositionChange: handlePositionChange, onUnavailable: () => {
      generation++;
      currentAnalysisResult = null;
      timeMgr.stopTimer();
      overlay.clear();
      hud.showWaiting('Полная позиция недоступна. Откройте историю ходов или начните новую партию.');
    } });
    if (typeof chrome !== 'undefined' && chrome.storage?.onChanged) {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area === 'local' && changes.humanPlayState) {
          statsGroups = changes.humanPlayState.newValue?.groups || {};
          showGameStats();
          return;
        }
        if (area !== 'sync') return;
        const update = {};
        for (const key of Object.keys(settings)) if (changes[key]) update[key] = changes[key].newValue ?? defaults[key];
        if (Object.keys(update).length) applySettings(update);
      });
    }
    executor = new MoveExecutor(detector);
    detector.startObserving();
    resultPoll = setInterval(checkGameResult, 1000);
    const playSelected = async event => {
      if (!MoveExecutor.acceptsKey(event) || !currentAnalysisResult || !engine.isContextAvailable()) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      const { move, fen } = currentAnalysisResult;
      try {
        if (await executor.execute(move, fen)) hud.setMoveActionStatus('Ход выполнен');
      } catch (error) {
        hud.setMoveActionStatus(error.message);
      } finally {
        tryAutoPlay(generation);
      }
    };
    window.addEventListener('keydown', playSelected, true);
    window.addEventListener('pagehide', () => {
      window.removeEventListener('keydown', playSelected, true);
      generation++;
      clearInterval(resultPoll);
      saveSession(true);
      detector.stopObserving();
      timeMgr.stopTimer();
      engine.localEngine?.destroy();
    });
  }
  async function tryAutoPlay(request) {
    if (request !== generation || !settings.autoPlay || !currentAnalysisResult || !engine.isContextAvailable() || executor.busy ||
        (settings.humanDelay && !timeMgr.isReady) || autoAttemptGeneration === request) return;
    autoAttemptGeneration = request;
    const { move, fen } = currentAnalysisResult;
    try {
      const played = await executor.execute(move, fen, () => settings.autoPlay && request === generation);
      if (played) hud.setMoveActionStatus('Автоход выполнен');
      else if (request === generation) hud.setMoveActionStatus('Автоход отменён: позиция изменилась.');
    } catch (error) {
      if (request === generation) hud.setMoveActionStatus(error.message);
    } finally {
      // A fast reply can finish its analysis while the previous interaction is still awaiting confirmation.
      if (request !== generation) tryAutoPlay(generation);
    }
  }
  function refresh() {
    generation++;
    detector.lastFen = null;
    detector.triggerCheck();
  }
  function resetAccuracy() {
    session++;
    timeMgr.reset();
    recordedMoves = new Set();
    engine.moveSelector.resetHistory();
    hud.updateAccuracy(engine.moveSelector.getLiveAccuracy());
  }
  function applySettings(update, save = false) {
    if (Object.hasOwn(update, 'targetWinRate') && !Object.hasOwn(update, 'humanTargetWinRate') && !Object.hasOwn(update, 'ratedTargetScore')) {
      update[(update.playMode || settings.playMode) === 'human' ? 'humanTargetWinRate' : 'ratedTargetScore'] = update.targetWinRate;
    }
    Object.assign(settings, update);
    Object.assign(settings, PlaySettings.normalize(settings));
    settings.aiPersona = PersonaStyles.normalizePersona(settings.aiPersona);
    settings.playMode = ['human', 'rated'].includes(settings.playMode) ? settings.playMode : 'strict';
    settings.targetWinRate = Math.max(0.5, Math.min(0.8, Number(settings.targetWinRate) || 0.55));
    engine.setOptions(settings);
    hud.currentElo = settings.targetElo;
    hud.updateEloActiveButton();
    hud.setPersona(settings.aiPersona);
    if (gameSession.data && ['playMode', 'targetElo', 'aiPersona', 'adaptiveStrength', 'humanTargetWinRate', 'ratedTargetScore'].some(key => Object.hasOwn(update, key))) {
      if (gameSession.data.mode !== settings.playMode || gameSession.data.baseLevel !== settings.targetElo ||
          gameSession.data.target !== PlaySettings.target(settings) || gameSession.data.adaptiveStrength !== settings.adaptiveStrength ||
          (settings.playMode !== 'rated' && gameSession.data.persona !== settings.aiPersona)) {
        gameSession.data.mixedSettings = true;
        saveSession();
      }
    }
    showGameStats();
    if (save && typeof chrome !== 'undefined' && chrome.storage?.sync) chrome.storage.sync.set(update);
    if (Object.keys(update).every(key => key === 'autoPlay' || key === 'humanDelay')) {
      hud.setMoveActionStatus(settings.autoPlay ? 'Автоходы включены' : 'Пробел — выполнить выбранный ход');
      if (settings.humanDelay) scheduleTiming(generation, !!currentAnalysisResult);
      else { timeMgr.stopTimer(); hud.setTimerEnabled(false); }
      tryAutoPlay(generation);
      return;
    }
    refresh();
  }
  function trackPlayedMove(transition, userColor) {
    if (!transition || transition.color !== userColor) return;
    const key = transition.before + ':' + transition.after;
    if (recordedMoves.has(key)) return;
    recordedMoves.add(key);
    const epoch = session;
    accuracyQueue = accuracyQueue.then(async () => {
      if (epoch !== session) return;
      const clock = readOwnClock();
      if (clock !== null && clock <= 30) return;
      // Compare optimal evaluations immediately before and after the player's actual move.
      const before = await engine.analyzePosition(transition.before, { analysisOnly: true, depth: 12 });
      if (epoch !== session) return;
      const afterClock = readOwnClock();
      if (afterClock !== null && afterClock <= 30) return;
      const after = await engine.analyzePosition(transition.after, { analysisOnly: true, depth: 12 });
      if (epoch !== session) return;
      if (before?.score?.unit === 'cp' && after?.score?.unit === 'cp') {
        engine.moveSelector.recordMoveLoss(Math.max(0, before.score.value + after.score.value));
        hud.updateAccuracy(engine.moveSelector.getLiveAccuracy());
      }
    }).catch(error => console.warn('[Accuracy]', error));
  }
  let detectorSession = null;
  let lastUserColor = null;
  function readOwnClock() {
    return timeMgr.readClockFromDom(lastUserColor === 'w' ? 'white' : 'black', detector.isFlipped());
  }
  function scheduleTiming(request, allowAuto = true) {
    if (!settings.humanDelay || !timeMgr.turn) return;
    const result = currentAnalysisResult;
    const context = timeMgr.turn;
    const knownBook = result?.strategy === 'human' ? result.isFamiliarOpening :
      result && engine.openingsBook.lookup(context.fen)?.moves?.some(item => item.uci === result.move);
    const plan = timeMgr.plan({ ...result, fen: context.fen, moveNumber: context.moveNumber,
      lastMove: context.lastMove, isBook: !!knownBook || !!result?.isBook,
      remainingSeconds: context.remainingSeconds, incrementSeconds: context.incrementSeconds });
    timeMgr.startTimer(plan.seconds, tick => {
      if (request === generation) hud.updateTimerProgress(tick);
    }, allowAuto ? () => tryAutoPlay(request) : null,
    { startedAt: context.startedAt, reason: plan.reason, readRemainingSeconds: readOwnClock });
  }
  async function handlePositionChange({ fen, turn, userColor, moveNumber, transition, session: stateSession }) {
    const request = ++generation;
    if (detectorSession !== stateSession || lastUserColor !== userColor) {
      detectorSession = stateSession;
      lastUserColor = userColor;
      resetAccuracy();
    }
    const observed = await ensureGame(fen, transition, userColor, request);
    if (!observed) return;
    transition = observed.transition;
    trackPlayedMove(transition, userColor);
    timeMgr.stopTimer();
    currentAnalysisResult = null;
    overlay.clear();
    hud.setMoveActionStatus(settings.autoPlay ? 'Автоходы включены' : 'Пробел — выполнить выбранный ход');
    if (turn !== userColor || gameSession.data.result !== 'unknown' || reviewing) {
      timeMgr.turn = null;
      if (gameSession.data.result !== 'unknown') hud.showWaiting('Партия завершена. Результат сохранён.');
      else if (reviewing) hud.showWaiting('Просмотр истории: автоходы приостановлены.');
      else hud.showOpponentThinking(turn);
      return;
    }
    const timing = timeMgr.beginTurn(fen, transition?.move);
    if (timing.remainingSeconds === undefined) {
      timing.remainingSeconds = readOwnClock();
      timing.moveNumber = moveNumber;
      // Only explicit clock metadata is accepted; a clock label may contain unrelated numbers.
      const increment = document.querySelector('[data-increment-seconds]')?.getAttribute('data-increment-seconds');
      timing.incrementSeconds = increment === null || increment === undefined ? 0 : Number(increment);
    }
    hud.showCalculating();
    if (settings.humanDelay) {
      scheduleTiming(request, false);
    } else hud.setTimerEnabled(false);
    try {
      const clock = readOwnClock();
      const result = await engine.analyzePosition(fen, { moveNumber,
        remainingSeconds: clock,
        movetime: clock !== null && clock <= 15 ? Math.max(30, Math.min(200, clock * 20)) : 600 });
      if (request !== generation || detector.lastFen !== fen) return;
      if (!result?.move) {
        timeMgr.stopTimer();
        if (!result?.terminal) hud.setEngineSource('unavailable');
        hud.showWaiting(result?.terminal ? 'Партия завершена: допустимых ходов нет.' :
          result?.error ? 'Ошибка движка: ' + result.error : undefined);
        return;
      }
      currentAnalysisResult = { ...result, fen };
      saveSession();
      hud.updateMove(result);
      hud.updateMultiMoves(result.lines, result.move, { isBook: result.isBook, candidates: result.allCandidates, human: ['human', 'rated'].includes(result.strategy) });
      hud.setEngineSource(result.isBook ? 'book' : result.engineSource, result.fallbackToWasm || !!result.fallbackReason, result);
      drawCurrent();
      scheduleTiming(request);
      tryAutoPlay(request);
    } catch (error) {
      if (request !== generation) return;
      console.warn('[Chess Sensei]', error);
      timeMgr.stopTimer();
      currentAnalysisResult = null;
      overlay.clear();
      hud.setEngineSource('unavailable');
      hud.showWaiting('Ошибка расчёта: ' + (error?.message || String(error)));
    }
  }
  function drawCurrent() {
    if (!currentAnalysisResult || detector.lastFen !== currentAnalysisResult.fen) return;
    // Rated alternatives are visible analysis; only the frozen profile move is executable.
    const safeLines = currentAnalysisResult.isBook || currentAnalysisResult.strategy === 'rated' ? currentAnalysisResult.lines : currentAnalysisResult.lines.filter(line => currentAnalysisResult.allCandidates?.some(candidate => candidate.uci === line.uci && (candidate.isAllowedByProfile ?? candidate.isSafe)));
    overlay.renderMultiMoves(safeLines, currentAnalysisResult.move, {
      rank: currentAnalysisResult.rank, isBook: currentAnalysisResult.isBook, isFlipped: detector.isFlipped()
    });
  }
  function selectLine(uci, rank) {
    if (!currentAnalysisResult || detector.lastFen !== currentAnalysisResult.fen) return;
    const line = currentAnalysisResult.lines.find(candidate => candidate.uci === uci);
    if (!line) return;
    if (!currentAnalysisResult.isBook && !currentAnalysisResult.allCandidates?.find(candidate => candidate.uci === uci && (candidate.isAllowedByProfile ?? candidate.isSafe))) return;
    Object.assign(currentAnalysisResult, { move: uci, rank,
      rankLabel: currentAnalysisResult.isBook ? 'Дебютная книга' : `Топ-${rank}`,
      scoreText: line.score ? hud.formatScore(line.score) : '—',
      scoreCp: line.score ? engine.moveSelector.normalizeScore(line.score) : undefined });
    if (currentAnalysisResult.strategy === 'human') {
      const details = PositionComplexity.inspect(currentAnalysisResult.fen, currentAnalysisResult.lines, readOwnClock());
      currentAnalysisResult.complexity = details;
      currentAnalysisResult.isTactical = !!details.candidates[uci]?.isTactical;
      currentAnalysisResult.reason = details.candidates[uci]?.mateOne ? 'Мат в один' : details.candidates[uci]?.obviousCapture ? 'Очевидное взятие' : currentAnalysisResult.planState?.label;
      if (currentAnalysisResult.humanPolicyVersion === 2) {
        currentAnalysisResult.pendingState = { planState: PlanTracker.advance(currentAnalysisResult.planState, uci),
          perceptionState: currentAnalysisResult.pendingState?.perceptionState };
        gameSession.data.manualOverride = true;
      }
    }
    hud.updateMove(currentAnalysisResult);
    hud.updateMultiMoves(currentAnalysisResult.lines, uci, { isBook: currentAnalysisResult.isBook, candidates: currentAnalysisResult.allCandidates, human: ['human', 'rated'].includes(currentAnalysisResult.strategy) });
    gameSession.remember(currentAnalysisResult.fen, currentAnalysisResult);
    saveSession();
    drawCurrent();
    scheduleTiming(generation);
  }
  function handleReroll() {
    if (!currentAnalysisResult) { refresh(); return; }
    const others = currentAnalysisResult.allCandidates?.filter(candidate => (candidate.isAllowedByProfile ?? candidate.isSafe) && candidate.uci !== currentAnalysisResult.move) || [];
    if (!others.length) return;
    const chosen = others[Math.floor(Math.random() * others.length)];
    selectLine(chosen.uci, chosen.rank);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', startApp, { once: true });
  else startApp();
})();
