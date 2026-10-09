const assert = require('node:assert/strict');
const { ChessRules } = require('../vendor/chess.js');
const CurrentProfiles = require('../engine/player_profile.js');
// Compatibility coverage for already-started v1 sessions. V2 has its own behavioural suite.
const Profiles = { ...CurrentProfiles, create: (options = {}, seed) => CurrentProfiles.create({ ...options, humanPolicyVersion: 1 }, seed) };
const Complexity = require('../engine/position_complexity.js');
const { PlanTracker } = require('../engine/plan_tracker.js');
const { HumanSelector } = require('../engine/human_selector.js');
const Adapter = require('../engine/strength_adapter.js');
const { GameSession, outcome, fromResult, transitionBetween } = require('../engine/game_session.js');
const { StatsStore } = require('../background/stats_store.js');
const { EngineController } = require('../engine/engine_controller.js');
const { UciEngine } = require('../engine/uci_engine.js');
const { NodeWorker } = require('./nnue_tests.js');
const path = require('node:path');
let checks = 0;
function check(name, fn) { fn(); checks++; console.log('PASS human:', name); }
async function runHumanTests() {
  const initial = new ChessRules().fen();
  const lines = [ ['e2e4', 100], ['g1f3', 60], ['d2d4', 0], ['a2a3', -300] ]
    .map(([uci, value], index) => ({ uci, score: { unit: 'cp', value }, depth: 12, multipv: index + 1, pv: [uci] }));
  check('profiles clamp strength and retain independent skills', () => {
    const profile = Profiles.create({ targetElo: 9999, adaptationOffset: 9999, aiPersona: 'invalid' }, 'seed');
    assert.equal(profile.level, 2800); assert.equal(profile.persona, 'balanced');
    assert.notEqual(profile.skills.tactics, profile.skills.opening);
  });
  const weak = new HumanSelector(Profiles.create({ targetElo: 800 }, 'seed'));
  const selected = weak.select(lines, { fen: initial });
  check('legal probabilities normalize and extreme losses are excluded', () => {
    assert.ok(Math.abs(selected.allCandidates.reduce((s, item) => s + item.probability, 0) - 1) < 1e-9);
    assert.equal(selected.allCandidates[3].isAllowedByProfile, false);
    assert.equal(selected.allCandidates[3].isWithinStrictSafety, false);
    assert.ok(new ChessRules(initial).move({ from: selected.move.slice(0, 2), to: selected.move.slice(2, 4) }));
  });
  check('same seed and position keep the same decision', () => assert.equal(weak.select(lines, { fen: initial }).move, selected.move));
  check('repertoire is stable and opening knowledge has a depth limit', () => {
    const profile = Profiles.create({ targetElo: 1000 }, 'book');
    const legal = new Set(new ChessRules().moves({ verbose: true }).map(item => item.from + item.to));
    const opening = { moves: [{ uci: 'e2e4' }, { uci: 'd2d4' }, { uci: 'g1f3' }] };
    assert.equal(Profiles.bookMove(opening, legal, profile).uci, Profiles.bookMove(opening, legal, profile).uci);
    assert.equal(Profiles.familiar(initial, profile), true);
    assert.equal(Profiles.familiar(initial.replace(' 0 1', ' 0 20'), profile), false);
  });
  check('higher strength reduces average loss across fixed independent seeds', () => {
    let low = 0, high = 0;
    for (let seed = 0; seed < 400; seed++) {
      low += new HumanSelector(Profiles.create({ targetElo: 800 }, seed)).select(lines, { fen: initial }).allCandidates
        .find(item => item.uci === new HumanSelector(Profiles.create({ targetElo: 800 }, seed)).select(lines, { fen: initial }).move).lossCp;
      const result = new HumanSelector(Profiles.create({ targetElo: 2800 }, seed)).select(lines, { fen: initial });
      high += result.allCandidates.find(item => item.uci === result.move).lossCp;
    }
    assert.ok(low > high * 2, `${low} vs ${high}`);
  });
  check('mate, stalemate and color are correctly distinguished', () => {
    assert.equal(outcome(initial, 'w'), null);
    const mate = '7k/6Q1/6K1/8/8/8/8/8 b - - 0 40';
    assert.equal(outcome(mate, 'w').result, 'win'); assert.equal(outcome(mate, 'b').result, 'loss');
    assert.equal(outcome('7k/5Q2/6K1/8/8/8/8/8 b - - 0 40', 'w').result, 'draw');
    assert.equal(fromResult('½-½', 'b').result, 'draw'); assert.equal(fromResult('0-1', 'b').result, 'win');
    assert.equal(fromResult('board disappeared', 'w'), null);
  });
  check('free capture and sacrifice have different difficulty', () => {
    const free = Complexity.inspect('4k3/8/8/8/3p4/4P3/8/4K3 w - - 0 18', [{ uci: 'e3d4' }]);
    const sacrifice = Complexity.inspect('4k3/8/8/2p5/3p4/4Q3/8/4K3 w - - 0 18', [{ uci: 'e3d4' }]);
    assert.equal(free.candidates.e3d4.obviousCapture, true);
    assert.equal(sacrifice.candidates.e3d4.sacrifice, true);
  });
  check('new check overrides a previous development plan', () => {
    const plans = new PlanTracker();
    plans.update(initial, 0, Complexity.inspect(initial), 'balanced');
    assert.equal(plans.state.type, 'develop');
    const checkFen = '4k3/8/8/8/8/8/4r3/4K3 w - - 0 12';
    plans.update(checkFen, -200, Complexity.inspect(checkFen), 'balanced');
    assert.equal(plans.state.type, 'defend');
  });
  const session = new GameSession(); session.begin({ playerColor: 'w', mode: 'human' }, { targetElo: 1400, humanPolicyVersion: 1 }, 40, initial);
  const game = new ChessRules(); game.move('e4');
  const transition = transitionBetween(initial, game.fen());
  session.observe(transition); session.observe(transition); session.remember(initial, selected);
  const restored = new GameSession(JSON.parse(JSON.stringify(session.data)));
  check('reload preserves profile, decisions and deduplicated actual moves', () => {
    assert.equal(restored.data.completedMoves, 1);
    assert.equal(restored.data.decisions[initial].move, selected.move);
    assert.equal(restored.data.profileSnapshot.level, 1440);
    assert.equal(transition.move, 'e2e4');
    assert.equal(transitionBetween(initial, initial), null);
  });
  check('confirmed result can finish a session only once', () => {
    assert.ok(restored.finish({ result: 'win', resultSource: 'test' }));
    assert.equal(restored.finish({ result: 'loss', resultSource: 'test' }), null);
  });
  check('site identity deduplicates the same game opened in different tabs', () => {
    const a = new GameSession(), b = new GameSession();
    const meta = { site: 'chess.com', sourceId: '12345', playerColor: 'w' };
    assert.equal(a.begin(meta, {}).id, b.begin(meta, {}).id);
  });
  check('adaptation respects uncertainty, draws and win ratio', () => {
    const mixed = Array.from({ length: 100 }, (_, i) => ({ result: i < 65 ? 'win' : i < 80 ? 'draw' : 'loss' }));
    const summary = Adapter.summarize(mixed);
    assert.equal(summary.winRate, 0.65); assert.equal(summary.scoreRate, 0.725); assert.equal(summary.offset, 0);
    assert.equal(Adapter.summarize([{ result: 'win' }]).offset, 0);
    assert.equal(Adapter.summarize(Array(20).fill({ result: 'win' })).offset, -40);
    assert.equal(Adapter.summarize(Array(20).fill({ result: 'loss' })).offset, 40);
    assert.equal(Adapter.summarize([{ result: 'unknown' }, { result: 'aborted' }]).games, 0);
  });
  const state = Adapter.empty();
  const meta = { site: 'test', opponentCategory: 'bot', opponentLevelBucket: '1400', timeControl: '180+0', persona: 'balanced', mode: 'human', baseLevel: 1400 };
  for (let i = 0; i < 101; i++) Adapter.record(state, { ...meta, id: String(i), result: 'win', resultSource: 'test' });
  check('sliding-window adaptation happens once per ten new games', () => {
    assert.equal(state.groups[Adapter.group(meta)].offset, -360);
    assert.equal(Adapter.record(state, { ...meta, id: '100', result: 'win', resultSource: 'test' }), false);
    Adapter.record(state, { ...meta, id: 'mixed', mixedSettings: true, result: 'win', resultSource: 'test' });
    assert.equal(state.groups[Adapter.group(meta)].total, 101);
    assert.notEqual(Adapter.group(meta), Adapter.group({ ...meta, opponentCategory: 'human' }));
  });
  check('adaptation stops at the effective profile boundary', () => {
    const boundary = Adapter.empty();
    const metaLow = { ...meta, baseLevel: 800 };
    for (let i = 0; i < 20; i++) Adapter.record(boundary, { ...metaLow, id: 'low-' + i, result: 'win', resultSource: 'test' });
    assert.equal(boundary.groups[Adapter.group(metaLow)].offset, 0);
    assert.equal(Adapter.current(boundary, Adapter.group(metaLow)).status, 'limit');
  });
  let persisted = {};
  const store = new StatsStore({ get: async () => structuredClone(persisted), set: async value => { persisted = structuredClone(value); } });
  await Promise.all(Array.from({ length: 30 }, (_, i) => store.handle({ action: 'HUMAN_GAME_RECORD', record: { ...meta, id: 'tab-' + i, result: 'win', resultSource: 'test' } })));
  check('concurrent tabs cannot lose statistics updates', () => assert.equal(persisted.humanPlayState.groups[Adapter.group(meta)].total, 30));
  await store.handle({ action: 'HUMAN_SESSION_SAVE', pageKey: 'game', session: session.data }, { tab: { id: 1 } });
  const storeAfterRestart = new StatsStore(store.storage);
  check('worker restart recovers active session', () => assert.ok(persisted.humanPlayState.sessions['1:game']));
  await storeAfterRestart.handle({ action: 'HUMAN_STATS_RESET' });
  check('reset preserves active snapshots and avoids recounting old outcomes', () => {
    assert.equal(Object.keys(persisted.humanPlayState.groups).length, 0);
    assert.ok(persisted.humanPlayState.sessions['1:game']);
    assert.equal(persisted.humanPlayState.seen.length, 30);
  });
  const controller = new EngineController({ playMode: 'human' });
  controller.init = async () => true; controller.openingsBook.loaded = true; controller.openingsBook.db = {};
  controller.setSession(session);
  let searches = 0;
  controller.requestAnalysis = async () => { searches++; return { success: true, lines, engineSource: 'nnue' }; };
  const first = await controller.analyzePosition(initial);
  const second = await controller.analyzePosition(initial);
  check('controller uses frozen session and cached decision', () => { assert.equal(first.move, second.move); assert.equal(searches, 0); });
  controller.gameSession = null;
  await controller.analyzePosition(initial, { remainingSeconds: 8 });
  check('human controller can analyze while bypassing decision cache', () => assert.equal(searches, 1));
  const staleController = new EngineController({ playMode: 'human' });
  staleController.init = async () => true;
  staleController.openingsBook.db = {};
  const sessionA = new GameSession(), sessionB = new GameSession();
  sessionA.begin({ playerColor: 'w' }, { targetElo: 1000, humanPolicyVersion: 1 }, 0, initial);
  sessionB.begin({ playerColor: 'w' }, { targetElo: 1800, humanPolicyVersion: 1 }, 0, initial);
  staleController.setSession(sessionA);
  let release;
  staleController.requestAnalysis = () => new Promise(resolve => { release = resolve; });
  const pending = staleController.analyzePosition(initial, { remainingSeconds: 8 });
  await new Promise(resolve => setImmediate(resolve));
  staleController.setSession(sessionB);
  release({ success: true, lines, engineSource: 'nnue' });
  await pending;
  check('late analysis cannot write its decision into the next game', () => {
    assert.ok(sessionA.data.decisions[initial]);
    assert.equal(sessionB.data.decisions[initial], undefined);
  });
  const engine = new UciEngine(path.resolve(__dirname, '../offscreen/stockfish-nnue.js'), { WorkerClass: NodeWorker });
  try {
    const wide = await engine.analyze({ fen: initial, depth: 8, movetime: 150, multipv: 8 });
    check('real NNUE returns eight legal root candidates', () => {
      assert.equal(wide.success, true); assert.equal(wide.lines.length, 8);
      for (const line of wide.lines) assert.ok(new ChessRules(initial).move({ from: line.uci.slice(0, 2), to: line.uci.slice(2, 4), promotion: line.uci[4] }));
    });
    const restricted = await engine.analyze({ fen: initial, depth: 8, movetime: 100, multipv: 1, searchmoves: ['a2a3'] });
    check('real NNUE honors root move restriction', () => assert.equal(restricted.lines[0].uci, 'a2a3'));
  } finally { engine.destroy(); }
  console.log(`Human checks passed: ${checks}`);
}
if (require.main === module) runHumanTests().catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { runHumanTests };
