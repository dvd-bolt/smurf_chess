const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { ChessRules } = require('../vendor/chess.js');
const { PositionState, START } = require('../engine/position_state.js');
const { EngineController } = require('../engine/engine_controller.js');
const { MoveSelector } = require('../engine/move_selector.js');
const { BoardDetector } = require('../content/board_detector.js');
const { VisualOverlay } = require('../content/visual_overlay.js');
const { HudWidget } = require('../content/hud_widget.js');
let count = 0;
function check(name, fn) { fn(); count++; console.log('PASS:', name); }
async function main() {
  const state = new PositionState();
  const game = new ChessRules();
  state.resolve(game.fen().split(' ')[0]);
  for (const move of ['e4', 'a6', 'Ke2', 'a5', 'Ke1']) {
    game.move(move);
    check('Legal transition ' + move, () => assert.equal(state.resolve(game.fen().split(' ')[0]), game.fen()));
  }
  check('Returned king does not regain castling', () => assert.equal(state.fen.split(' ')[2], 'kq'));
  check('Played move recorded from verified transition', () => assert.equal(state.transition.move, 'e2e1'));
  const replay = new PositionState();
  check('History reconstructs full FEN after reload', () => assert.equal(replay.resolve(game.fen().split(' ')[0], null, ['e4', 'a6', 'Ke2', 'a5', 'Ke1']), game.fen()));
  const epGame = new ChessRules();
  const epState = new PositionState();
  epState.resolve(epGame.fen().split(' ')[0]);
  for (const san of ['e4', 'a6', 'e5', 'd5', 'exd6']) {
    epGame.move(san);
    check('En passant ' + san, () => assert.equal(epState.resolve(epGame.fen().split(' ')[0]), epGame.fen()));
  }
  const castleGame = new ChessRules('r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1');
  const castleState = new PositionState();
  castleState.resolve(castleGame.fen().split(' ')[0], castleGame.fen());
  castleGame.move('O-O');
  check('Castling moves both pieces', () => assert.equal(castleState.resolve(castleGame.fen().split(' ')[0]), castleGame.fen()));
  check('Unknown midgame is not invented', () => assert.equal(new PositionState().resolve(game.fen().split(' ')[0]), null));
  const repetition = new PositionState();
  repetition.resolve(START.split(' ')[0]);
  const repeated = new ChessRules();
  const cycle = ['Nf3', 'Nf6', 'Ng1', 'Ng8'];
  cycle.forEach(move => repeated.move(move));
  check('History preserves counters when placement repeats', () => assert.equal(repetition.resolve(repeated.fen().split(' ')[0], null, cycle), repeated.fen()));
  check('Malformed board without kings is rejected', () => assert.equal(new PositionState().resolve('8/8/8/8/8/8/8/8', '8/8/8/8/8/8/8/8 w - - 0 1'), null));
  const beforeSession = state.session;
  state.resolve(START.split(' ')[0], START);
  check('New game resets session', () => assert.equal(state.session, beforeSession + 1));
  const detector = new BoardDetector();
  detector.siteType = 'test';
  detector.boardElement = { getAttribute: () => epGame.fen() };
  check('Test board reads black turn', () => assert.equal(detector.determineActiveTurn(), 'b'));
  check('Waiting handler exists', () => assert.equal(typeof HudWidget.prototype.showWaiting, 'function'));
  const overlay = new VisualOverlay();
  overlay.currentMultiData = { lines: [{ uci: 'e2e4' }] };
  overlay.toggleVisible();
  check('Hidden arrows retain current position', () => assert.ok(overlay.currentMultiData));
  overlay.clear();
  check('Position change forgets hidden arrows', () => assert.equal(overlay.currentMultiData, null));
  const selector = new MoveSelector({ blunderFilter: false, snowballMode: false });
  const lines = [{ uci: 'e2e4', score: { unit: 'cp', value: 0 } }, { uci: 'd2d4', score: { unit: 'cp', value: -500 } }];
  check('Safety cannot be disabled for personas', () => assert.equal(selector.selectMove(lines).allCandidates[1].isSafe, false));
  const controller = new EngineController();
  controller.setOptions({ aiPersona: 'tal', blunderFilter: false, snowballMode: false, targetElo: 1800, useLocalBridge: true });
  check('Settings reach controller and selector', () => {
    assert.equal(controller.moveSelector.blunderFilter, true);
    assert.equal(controller.moveSelector.aiPersona, 'tal');
    assert.equal(controller.moveSelector.snowballMode, false);
    assert.equal(controller.moveSelector.targetElo, 1800);
    assert.equal(controller.useLocalBridge, true);
  });
  controller.openingsBook.loaded = true;
  controller.setOptions({ aiPersona: 'balanced' });
  controller.openingsBook.db = { [START.split(' ').slice(0, 3).join(' ')]: { moves: [{ uci: 'e2e5', pct: 1 }] } };
  controller.requestAnalysis = async () => ({ lines: [{ uci: 'e2e5', score: { unit: 'cp', value: 900 } }, { uci: 'e2e4', score: { unit: 'cp', value: 30 } }] });
  const valid = await controller.analyzePosition(START);
  check('Illegal book and engine moves are rejected', () => assert.equal(valid.move, 'e2e4'));
  const raw = await controller.analyzePosition(START, { analysisOnly: true });
  check('Accuracy bypasses book and randomized selection', () => assert.equal(raw.score.value, 30));
  controller.openingsBook.db = { [START.split(' ').slice(0, 3).join(' ')]: { moves: [{ uci: 'e2e4', pct: 1 }] } };
  controller.setOptions({ aiPersona: 'tal' });
  controller.requestAnalysis = async () => ({ lines: [{ uci: 'd2d4', score: { unit: 'cp', value: 20 } }] });
  const styledOpening = await controller.analyzePosition(START);
  check('Named persona analyzes openings instead of forcing a book move', () => { assert.equal(styledOpening.isBook, false); assert.equal(styledOpening.move, 'd2d4'); });
  controller.setOptions({ aiPersona: 'unknown' });
  check('Controller normalizes unknown persona from saved settings', () => assert.equal(controller.moveSelector.aiPersona, 'balanced'));

  // Model UCI timing, including a delayed bestmove after stop.
  let timers = new Map(), timerId = 0, workers = [];
  class FakeWorker {
    constructor(url) { this.url = url; this.commands = []; workers.push(this); }
    postMessage(command) { this.commands.push(command); }
    terminate() { this.terminated = true; }
    emit(line) { this.onmessage({ data: line }); }
  }
  const sandbox = { Worker: FakeWorker, console, URL, setTimeout: fn => { timers.set(++timerId, fn); return timerId; }, clearTimeout: id => timers.delete(id) };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../engine/uci_engine.js'), 'utf8'), sandbox);
  const engine = new sandbox.UciEngine('fake');
  const a = engine.analyze({ fen: START });
  const b = engine.analyze({ fen: game.fen() });
  const worker = workers[0];
  check('No search before UCI handshake', () => assert.deepEqual(worker.commands, ['uci']));
  worker.emit('uciok'); worker.emit('readyok');
  check('Concurrent requests are queued', () => assert.equal(worker.commands.filter(c => c.startsWith('go ')).length, 1));
  timers.get(engine.timer)();
  check('Stop waits for old bestmove', () => assert.equal(worker.commands.at(-1), 'stop'));
  worker.emit('info depth 8 score cp 20 pv e2e4');
  worker.emit('bestmove e2e4');
  const first = await a;
  worker.emit('info depth 9 score cp -30 pv a6a5');
  worker.emit('bestmove a6a5');
  const second = await b;
  check('Results cannot cross between searches', () => { assert.equal(first.lines[0].uci, 'e2e4'); assert.equal(second.lines[0].uci, 'a6a5'); });
  const c = engine.analyze({ fen: START });
  const d = engine.analyze({ fen: START });
  worker.onerror();
  check('Worker failure resolves active and queued requests', () => assert.ok(worker.terminated));
  assert.equal((await c).success, false); assert.equal((await d).success, false);
  const e = engine.analyze({ fen: START });
  const fresh = workers.at(-1);
  worker.emit('bestmove a1a8');
  fresh.emit('uciok'); fresh.emit('readyok'); fresh.emit('bestmove (none)');
  check('Late output from dead worker is ignored', () => assert.equal(workers.length, 2));
  assert.equal((await e).terminal, true);
  engine.destroy();
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../engine/browser_engine.js'), 'utf8'), sandbox);
  const disposed = new sandbox.BrowserEngine('nnue', 'js', { wasmSupported: true });
  const canceled = disposed.analyze({ fen: START });
  const beforeDestroy = workers.length;
  disposed.destroy();
  assert.equal((await canceled).success, false);
  check('Closing NNUE does not resurrect a fallback worker', () => assert.equal(workers.length, beforeDestroy));
  const unsupported = new sandbox.BrowserEngine('nnue', 'js', { wasmSupported: false });
  const jsResult = unsupported.analyze({ fen: START });
  const jsWorker = workers.at(-1);
  jsWorker.emit('uciok'); jsWorker.emit('readyok');
  jsWorker.emit('info depth 6 score cp 20 pv e2e4'); jsWorker.emit('bestmove e2e4');
  const jsResponse = await jsResult;
  check('Unsupported WebAssembly selects JS without starting NNUE', () => { assert.equal(jsWorker.url, 'js'); assert.equal(jsResponse.engineSource, 'js'); });
  unsupported.destroy();
  const diagnostic = new sandbox.UciEngine('https://test.local/stockfish-nnue.js',
    { workerWrapperUrl: 'https://test.local/engine_worker.js' });
  const diagnosis = diagnostic.analyze({ fen: START });
  const diagnosticWorker = workers.at(-1);
  check('Worker wrapper pins the correct engine and WASM URLs', () => {
    const url = new URL(diagnosticWorker.url);
    assert.equal(url.searchParams.get('engine'), 'https://test.local/stockfish-nnue.js');
    assert.equal(decodeURIComponent(url.hash.slice(1)), 'https://test.local/stockfish-nnue.wasm');
  });
  diagnosticWorker.onmessage({ data: { type: 'sensei-engine-error', error: 'WASM compilation blocked' } });
  check('Structured worker errors preserve their real cause', () => assert.ok(diagnosticWorker.terminated));
  assert.equal((await diagnosis).error, 'WASM compilation blocked');
  class FakeFrameWorker extends FakeWorker {}
  const resilient = new sandbox.BrowserEngine('nnue', 'js', { frameWorkerClass: FakeFrameWorker });
  const resilientA = resilient.analyze({ fen: START });
  const resilientB = resilient.analyze({ fen: START });
  workers.at(-1).onerror();
  await Promise.resolve(); await Promise.resolve();
  workers.at(-1).onerror();
  await Promise.resolve(); await Promise.resolve();
  const frameWorker = workers.at(-1);
  const afterRecovery = workers.length;
  frameWorker.emit('uciok'); frameWorker.emit('readyok');
  frameWorker.emit('info depth 6 score cp 20 pv e2e4'); frameWorker.emit('bestmove e2e4');
  frameWorker.emit('info depth 6 score cp 20 pv d2d4'); frameWorker.emit('bestmove d2d4');
  const frameResults = await Promise.all([resilientA, resilientB]);
  check('Concurrent worker failures share one frame and retain queued searches', () => {
    assert.ok(frameWorker instanceof FakeFrameWorker);
    assert.ok(frameResults.every(result => result.success && result.engineTransport === 'frame'));
    assert.equal(frameResults[0].lines[0].uci, 'e2e4'); assert.equal(frameResults[1].lines[0].uci, 'd2d4');
  });
  const continued = resilient.analyze({ fen: START });
  frameWorker.emit('info depth 6 score cp 20 pv e2e4'); frameWorker.emit('bestmove e2e4');
  assert.equal((await continued).success, true);
  check('Frame recovery persists without restarting failed workers', () => assert.equal(workers.length, afterRecovery));
  resilient.destroy();
  check('Destroying frame recovery releases its transport', () => assert.equal(frameWorker.terminated, true));

  let fetched = 0, created = 0;
  const background = { console, setTimeout, AbortSignal,
    fetch: async () => { fetched++; return { ok: false }; },
    chrome: { offscreen: { createDocument: async () => { created++; } }, runtime: {
      getContexts: async () => [], onInstalled: { addListener() {} }, onStartup: { addListener() {} }, onMessage: { addListener() {} },
      sendMessage: (message, callback) => callback({ success: true, lines: [{ uci: 'e2e4' }] }) } } };
  vm.createContext(background);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../background/service_worker.js'), 'utf8'), background);
  await Promise.all([background.setupOffscreenDocument(), background.setupOffscreenDocument()]);
  check('Concurrent offscreen creation shares a promise', () => assert.equal(created, 1));
  await background.handleAnalyze({ fen: START, useLocalBridge: false });
  check('Disabled bridge never fetches localhost', () => assert.equal(fetched, 0));
  const fallback = await background.handleAnalyze({ fen: START, useLocalBridge: true });
  check('HTTP bridge failure reports fallback', () => { assert.equal(fetched, 1); assert.equal(fallback.fallbackToWasm, true); });
  let bridgeRequest;
  background.fetch = async (url, options) => {
    bridgeRequest = JSON.parse(options.body);
    return { ok: true, json: async () => ({ lines: [{ uci: 'e2e4' }] }) };
  };
  const outdatedBridge = await background.handleAnalyze({ fen: START, useLocalBridge: true, ratingElo: 1535, newGame: true });
  check('Old bridge cannot silently bypass rating limits', () => {
    assert.equal(bridgeRequest.ratingElo, 1535); assert.equal(bridgeRequest.newGame, true);
    assert.equal(outdatedBridge.fallbackToWasm, true); assert.equal(outdatedBridge.isLocalNative, undefined);
  });
  background.fetch = async () => ({ ok: true, json: async () => ({ lines: [{ uci: 'e2e4' }],
    bestmove: 'a2a3', ratingSupported: true, appliedElo: 1535, engineName: 'Native test' }) });
  const ratedNative = await background.handleAnalyze({ fen: START, useLocalBridge: true, ratingElo: 1535 });
  check('Native rating and weakened bestmove reach the controller unchanged', () => {
    assert.equal(ratedNative.appliedElo, 1535); assert.equal(ratedNative.bestmove, 'a2a3');
    assert.equal(ratedNative.engineSource, 'native');
  });
  let closed = 0, present = true, attempts = 0;
  background.chrome.runtime.getContexts = async () => present ? [{}] : [];
  background.chrome.offscreen.closeDocument = async () => { closed++; present = false; };
  background.chrome.offscreen.createDocument = async () => { created++; present = true; };
  background.chrome.runtime.sendMessage = (message, callback) => {
    attempts++;
    callback(attempts <= 2 ? { success: false, error: 'Stockfish worker failed', lines: [] }
      : { success: true, lines: [{ uci: 'e2e4' }], engineSource: 'nnue' });
  };
  const recovered = await Promise.all([background.handleAnalyze({ fen: START }), background.handleAnalyze({ fen: START })]);
  check('Concurrent worker failures recreate offscreen only once', () => assert.equal(closed, 1));
  check('Searches resume after document recovery', () => assert.ok(recovered.every(result => result.success)));
  background.chrome.runtime.sendMessage = (message, callback) => callback({ success: false, error: 'Persistent worker failure', lines: [] });
  const broken = await background.handleAnalyze({ fen: START });
  check('Persistent failure has bounded recovery and preserves diagnosis', () => {
    assert.equal(closed, 2); assert.equal(broken.error, 'Persistent worker failure');
  });
  controller.setOptions({ aiPersona: 'tal' });
  controller.requestAnalysis = async () => ({ success: false, error: 'Stockfish worker failed: allocation failed', lines: [] });
  const unavailable = await controller.analyzePosition(START);
  check('Controller reports worker errors without inventing a move', () => {
    assert.equal(unavailable.move, null); assert.equal(unavailable.engineSource, 'unavailable');
    assert.match(unavailable.error, /allocation failed/);
  });
  global.chrome = { runtime: { id: 'test-extension', sendMessage() { throw new Error('Must not send'); } } };
  const invalidated = new EngineController({ aiPersona: 'balanced' });
  delete global.chrome.runtime.id;
  const invalidatedResult = await invalidated.analyzePosition(START);
  check('Reloaded extension cannot start site-origin workers or play stale book moves', () => {
    assert.equal(invalidatedResult.move, null);
    assert.match(invalidatedResult.error, /F5/);
    assert.equal(invalidated.localEngine, null);
  });
  delete global.chrome;
  await require('./nnue_tests.js').runNnueTests();
  count++;
  console.log(`Regression checks passed: ${count}`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
