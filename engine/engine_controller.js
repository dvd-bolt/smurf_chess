/** Coordinates opening suggestions and verified Stockfish analysis. */
const SenseiBook = typeof OpeningsBook !== 'undefined' ? OpeningsBook : (typeof require === 'function' ? require('./openings_book.js').OpeningsBook : null);
const SenseiSelector = typeof MoveSelector !== 'undefined' ? MoveSelector : (typeof require === 'function' ? require('./move_selector.js').MoveSelector : null);
const SenseiRules = typeof ChessRules !== 'undefined' ? ChessRules : (typeof require === 'function' ? require('../vendor/chess.js').ChessRules : null);
const SenseiPersonas = typeof PersonaStyles !== 'undefined' ? PersonaStyles : (typeof require === 'function' ? require('./personas.js') : null);
const ControllerProfiles = typeof PlayerProfiles !== 'undefined' ? PlayerProfiles : require('./player_profile.js');
const ControllerHuman = typeof HumanSelector !== 'undefined' ? HumanSelector : require('./human_selector.js').HumanSelector;
const ControllerRated = typeof RatedProfile !== 'undefined' ? RatedProfile : require('./rated_profile.js');
class EngineController {
  constructor(options = {}) {
    this.openingsBook = new SenseiBook();
    this.moveSelector = new SenseiSelector(options);
    this.localEngine = null;
    this.extensionContext = typeof chrome !== 'undefined' && !!chrome.runtime?.id;
    this.useLocalBridge = false;
    this.bridgeUrl = 'http://127.0.0.1:5000';
    this.playMode = 'strict';
    this.gameSession = null;
    this.humanSelector = null;
    this.setOptions(options);
  }
  async init() { return this.openingsBook.init(); }
  isContextAvailable() {
    if (!this.extensionContext) return true;
    try { return !!chrome.runtime?.id; } catch (_) { return false; }
  }
  setElo(elo) { this.moveSelector.setElo(elo); }
  setOptions(options) {
    if (options.playMode !== undefined) this.playMode = ['human', 'rated'].includes(options.playMode) ? options.playMode : 'strict';
    if (options.targetElo !== undefined) this.setElo(options.targetElo);
    if (options.aiPersona !== undefined) this.moveSelector.aiPersona = SenseiPersonas.normalizePersona(options.aiPersona);
    if (options.snowballMode !== undefined) this.moveSelector.snowballMode = options.snowballMode !== false;
    if (options.useLocalBridge !== undefined) this.useLocalBridge = !!options.useLocalBridge;
    if (options.bridgeUrl) this.bridgeUrl = options.bridgeUrl;
  }
  setSession(session) {
    this.gameSession = session;
    this.ratingSearchStarted = false;
    this.humanSelector = new ControllerHuman(session.data.profileSnapshot, session.data.planState);
  }
  async requestAnalysis(fen, options) {
    if (!this.isContextAvailable()) return { success: false, lines: [], error: 'Расширение обновилось. Полностью обновите страницу (F5).' };
    const message = { action: 'ANALYZE_POSITION', fen, depth: options.depth || this.moveSelector.getEloProfile().depth,
      movetime: options.movetime || 600, multipv: options.multipv || (options.analysisOnly ? 1 : 3),
      searchmoves: options.searchmoves,
      ratingElo: options.ratingElo,
      newGame: options.newGame,
      useLocalBridge: this.useLocalBridge, bridgeUrl: this.bridgeUrl };
    if (typeof chrome !== 'undefined' && chrome.runtime?.id && chrome.runtime.sendMessage) {
      return new Promise(resolve => {
        try {
          chrome.runtime.sendMessage(message, response => {
            if (chrome.runtime.lastError) resolve({ success: false, error: chrome.runtime.lastError.message, lines: [] });
            else resolve(response || { success: false, error: 'Фоновый движок не ответил', lines: [] });
          });
        } catch (error) { resolve({ success: false, error: error.message, lines: [] }); }
      });
    }
    if (typeof BrowserEngine !== 'undefined' && typeof Worker !== 'undefined') {
      if (!this.localEngine) this.localEngine = new BrowserEngine(new URL('../offscreen/stockfish-nnue.js', document.baseURI).href,
        new URL('../engine/stockfish.js', document.baseURI).href);
      return this.localEngine.analyze(message);
    }
    return { success: false, lines: [] };
  }
  async analyzePosition(fen, options = {}) {
    if (!this.isContextAvailable()) return { move: null, lines: [], engineSource: 'unavailable',
      error: 'Расширение обновилось. Полностью обновите страницу (F5).' };
    const game = new SenseiRules();
    if (!game.load(fen)) return null;
    const board = game.fen().split(' ')[0];
    if ((board.match(/K/g) || []).length !== 1 || (board.match(/k/g) || []).length !== 1) return null;
    const legalMoves = game.moves({ verbose: true });
    if (!legalMoves.length) return { terminal: true, move: null, lines: [] };
    const legal = new Set(legalMoves.map(move => move.from + move.to + (move.promotion || '')));
    if (this.playMode === 'rated' && !options.analysisOnly) return this.analyzeRated(fen, legalMoves, legal, options);
    const human = this.playMode === 'human' && !options.analysisOnly;
    const activeSession = this.gameSession;
    if (human && activeSession?.data?.decisions[fen]) {
      const saved = activeSession.data.decisions[fen];
      if (saved.strategy === 'human' || saved.strategy === 'human-book') return { ...saved };
    }
    if (human && !this.humanSelector) this.humanSelector = new ControllerHuman(ControllerProfiles.create({ targetElo: this.moveSelector.targetElo, aiPersona: this.moveSelector.aiPersona }));
    const humanSelector = this.humanSelector;
    let opening = null;
    if (!options.analysisOnly) {
      await this.init();
      opening = this.openingsBook.lookup(fen);
      if (opening?.moves?.length && (human ? ControllerProfiles.familiar(fen, humanSelector.profile) : this.moveSelector.aiPersona === 'balanced')) {
        const candidate = human ? ControllerProfiles.bookMove(opening, legal, humanSelector.profile) :
          this.openingsBook.pickMove({ ...opening, moves: opening.moves.filter(move => legal.has(move.uci)) });
        if (candidate) {
          const result = { ...this.moveSelector.selectMove([], candidate),
          lines: [{ uci: candidate.uci, multipv: 1, rank: 1, isBook: true }],
          openingName: opening.name, openingEco: opening.eco };
          if (human) {
            Object.assign(result, { strategy: 'human-book', reason: 'Знакомый дебют', scoreText: '—', scoreCp: undefined });
            activeSession?.remember(fen, result);
          }
          return result;
        }
      }
    }
    const start = Date.now();
    const budget = options.movetime || 600;
    const trouble = Number.isFinite(options.remainingSeconds) && options.remainingSeconds <= 30;
    const response = await this.requestAnalysis(fen, { ...options, multipv: human ? (trouble ? 3 : 8) : options.multipv,
      depth: human ? Math.max(10, this.moveSelector.getEloProfile().depth) : options.depth,
      movetime: human && !trouble ? Math.round(budget * 0.75) : budget });
    if (response.error) console.warn('[Stockfish]', response.error);
    const lines = (response.lines || []).filter(line => legal.has(line.uci) && line.score);
    if (!lines.length) return { move: null, lines: [], error: response.error || 'Движок не вернул допустимые ходы', engineSource: 'unavailable' };
    if (human && !trouble && lines.length < 4 && Date.now() - start < budget - 60) {
      const natural = legalMoves.map(move => ({ move, uci: move.from + move.to + (move.promotion || '') }))
        .filter(item => !lines.some(line => line.uci === item.uci))
        .sort((a, b) => Number(!!b.move.captured || ['n', 'b'].includes(b.move.piece)) - Number(!!a.move.captured || ['n', 'b'].includes(a.move.piece))).slice(0, 2);
      for (const item of natural) {
        const available = budget - (Date.now() - start);
        if (available < 60) break;
        const alternative = await this.requestAnalysis(fen, { analysisOnly: true, depth: 10, movetime: Math.min(100, available), searchmoves: [item.uci] });
        const checked = alternative.lines?.find(line => line.uci === item.uci && line.score);
        if (checked) lines.push(checked);
      }
    }
    const best = lines.reduce((a, b) => this.moveSelector.normalizeScore(a.score) >= this.moveSelector.normalizeScore(b.score) ? a : b);
    const engineInfo = { engineSource: response.engineSource || (response.isLocalNative ? 'native' : 'js'),
      engineName: response.engineName, nnueNetwork: response.nnueNetwork, elapsedMs: response.elapsedMs,
      engineTransport: response.engineTransport,
      fallbackReason: response.fallbackReason || null };
    if (options.analysisOnly) return { score: best.score, scoreCp: this.moveSelector.normalizeScore(best.score), lines, ...engineInfo };
    if (human) {
      lines.sort((a, b) => this.moveSelector.normalizeScore(b.score) - this.moveSelector.normalizeScore(a.score));
      lines.forEach((line, index) => { line.rank = index + 1; line.multipv = index + 1; });
    }
    const familiar = human && !!opening && ControllerProfiles.familiar(fen, humanSelector.profile);
    const selection = human ? humanSelector.select(lines, { fen, remainingSeconds: options.remainingSeconds, familiar }) :
      this.moveSelector.selectMove(lines, null, { fen });
    const result = { ...selection, lines, ...engineInfo, isFamiliarOpening: familiar,
      openingName: opening?.name || null, openingEco: opening?.eco || null,
      isLocalNative: !!response.isLocalNative, fallbackToWasm: !!response.fallbackToWasm };
    if (human) activeSession?.remember(fen, result);
    return result;
  }
  getFallbackMove() { return null; }
  async analyzeRated(fen, legalMoves, legal, options) {
    const activeSession = this.gameSession;
    const saved = activeSession?.data?.decisions[fen];
    if (saved?.strategy === 'rated' && saved.ratingProfile?.version === ControllerRated.VERSION && legal.has(saved.move)) return { ...saved };
    const snapshot = activeSession?.data?.profileSnapshot;
    const profile = ControllerRated.create(snapshot?.level || this.moveSelector.targetElo, snapshot?.gameSeed || 'rated');
    const started = Date.now();
    const budget = options.movetime || 600;
    const response = await this.requestAnalysis(fen, { ...options, depth: 24, multipv: 4,
      newGame: !this.ratingSearchStarted, ratingElo: profile.engineElo, movetime: Math.max(50, Math.round(budget * 0.8)) });
    if (this.gameSession === activeSession) this.ratingSearchStarted = true;
    if (!response.success || !response.ratingSupported || response.appliedElo !== profile.engineElo || !legal.has(response.bestmove)) return { move: null, lines: [],
      engineSource: 'unavailable', error: response.error || 'Движок не подтвердил ограничение ELO и допустимый ход' };
    let move = ControllerRated.alternative(profile, fen, legalMoves, response.bestmove) || response.bestmove;
    const byMove = new Map((response.lines || []).filter(line => legal.has(line.uci) && line.score).map(line => [line.uci, line]));
    if (!byMove.has(move)) {
      const checked = await this.requestAnalysis(fen, { analysisOnly: true, depth: 10, multipv: 1,
        movetime: Math.max(50, Math.min(120, budget - (Date.now() - started))), searchmoves: [move] });
      const line = checked.lines?.find(item => item.uci === move && item.score);
      if (!line) return { move: null, lines: [], engineSource: 'unavailable', error: 'Не удалось оценить выбранный ход' };
      byMove.set(move, line);
    }
    const lines = [...byMove.values()].sort((a, b) => this.moveSelector.normalizeScore(b.score) - this.moveSelector.normalizeScore(a.score));
    lines.forEach((line, index) => { line.rank = index + 1; line.multipv = index + 1; });
    const chosen = byMove.get(move);
    const bestCp = Math.max(...lines.map(line => this.moveSelector.normalizeScore(line.score)));
    const result = { move, rank: chosen.rank, rankLabel: `${profile.nominalElo} ELO`, strategy: 'rated', isBook: false,
      reason: 'Игра по рейтингу', scoreCp: this.moveSelector.normalizeScore(chosen.score),
      scoreText: chosen.score.unit === 'mate' ? `M${chosen.score.value}` : (chosen.score.value / 100).toFixed(1),
      ratingProfile: profile, appliedElo: response.appliedElo, lines,
      engineSource: response.engineSource || (response.isLocalNative ? 'native' : 'js'), engineName: response.engineName,
      isLocalNative: !!response.isLocalNative, fallbackToWasm: !!response.fallbackToWasm,
      nnueNetwork: response.nnueNetwork, engineTransport: response.engineTransport,
      elapsedMs: Date.now() - started, fallbackReason: response.fallbackReason,
      allCandidates: lines.map(line => ({ uci: line.uci, rank: line.rank,
        lossCp: Math.max(0, bestCp - this.moveSelector.normalizeScore(line.score)),
        isSafe: bestCp - this.moveSelector.normalizeScore(line.score) <= 160,
        isWithinStrictSafety: bestCp - this.moveSelector.normalizeScore(line.score) <= 160,
        isAllowedByProfile: line.uci === move, probability: line.uci === move ? 1 : 0 })) };
    activeSession?.remember(fen, result);
    return result;
  }
}
if (typeof module !== 'undefined') module.exports = { EngineController };
