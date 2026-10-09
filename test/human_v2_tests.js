const assert = require('node:assert/strict');
const { ChessRules } = require('../vendor/chess.js');
const Profiles = require('../engine/player_profile.js');
const Candidates = require('../engine/human_candidates.js');
const Perception = require('../engine/human_perception.js');
const { HumanSelector } = require('../engine/human_selector.js');
const { PlanTracker } = require('../engine/plan_tracker.js');
const { GameSession, transitionBetween } = require('../engine/game_session.js');
const { EngineController } = require('../engine/engine_controller.js');
const Adapter = require('../engine/strength_adapter.js');
const Settings = require('../engine/play_settings.js');
let checks = 0;
async function check(name, fn) { await fn(); checks++; console.log('PASS human v2:', name); }
async function main() {
  const fen = new ChessRules().fen(), generated = Candidates.generate(fen);
  const lines = [['e2e4', 100], ['g1f3', 60], ['d2d4', 0], ['a2a3', -300]].map(([uci, value], i) =>
    ({ uci, score: { unit: 'cp', value }, depth: 12, rank: i + 1, pv: [uci] }));
  await check('candidate motives include legal development and quiet moves outside engine roots', () => {
    assert.ok(generated.candidates.some(c => c.features.isMinorDev));
    assert.ok(generated.candidates.some(c => !lines.some(l => l.uci === c.uci)));
    assert.equal(new Set(generated.candidates.map(c => c.uci)).size, generated.candidates.length);
    for (const c of generated.candidates) assert.ok(new ChessRules(fen).move(c.move));
  });
  await check('perceived judgment and engine truth are separate; no hard cp exclusion', () => {
    const result = new HumanSelector(Profiles.create({ targetElo: 1000 }, 'v2')).select(lines, { fen });
    assert.equal(result.humanPolicyVersion, 2);
    assert.equal(result.allCandidates.find(c => c.uci === 'a2a3').isAllowedByProfile, true);
    assert.equal(result.allCandidates.find(c => c.uci === 'a2a3').engineEvaluation.score.value, -300);
    assert.ok(Math.abs(result.allCandidates.reduce((sum, c) => sum + c.probability, 0) - 1) < 1e-9);
    assert.ok(result.allCandidates.some(c => c.engineEvaluation === null && c.lossCp === null));
  });
  await check('poisoned capture is recognised by short reply scan', () => {
    const position = '4k3/8/8/2p5/3p4/4Q3/8/4K3 w - - 0 18';
    const c = Candidates.generate(position).all.find(c => c.uci === 'e3d4');
    let noticed = 0;
    for (let seed = 0; seed < 50; seed++) {
      const p = Perception.inspect(c, null, Profiles.create({ targetElo: 1200 }, seed), { fen: position });
      if (p.shallowValue < c.staticCp - 500) noticed++;
    }
    assert.ok(noticed >= 45, noticed);
  });
  await check('visible mate in one wins over quiet plans', () => {
    const position = '7k/5Q2/6K1/8/8/8/8/8 w - - 0 40';
    const board = new ChessRules(position), mating = board.moves({ verbose: true }).filter(move => move.san.includes('#'));
    assert.ok(mating.length);
    const roots = mating.slice(0, 4).map(move => ({ uci: Candidates.uci(move), score: { unit: 'mate', value: 1 }, depth: 8, pv: [Candidates.uci(move)] }));
    const result = new HumanSelector(Profiles.create({ targetElo: 1000 }, 'mate')).select(roots, { fen: position });
    const chosen = board.move({ from: result.move.slice(0, 2), to: result.move.slice(2, 4) });
    assert.ok(chosen.san.includes('#')); assert.equal(result.reason, 'Мат в один');
  });
  await check('strength improves choices on independent seeds without forbidding errors', () => {
    const candidates = generated.all.filter(c => lines.some(l => l.uci === c.uci));
    let low = 0, high = 0;
    for (let seed = 0; seed < 120; seed++) {
      for (const level of [800, 2800]) {
        const r = new HumanSelector(Profiles.create({ targetElo: level }, 'strength-' + seed)).select(lines, { fen, generated, candidates });
        const loss = r.allCandidates.find(c => c.uci === r.move).lossCp;
        if (level === 800) low += loss; else high += loss;
      }
    }
    assert.ok(low > high * 2, `${low} vs ${high}`);
  });
  await check('time trouble reduces recognition and increases uncertainty', () => {
    const c = generated.all.find(c => c.uci === 'e2e4'), profile = Profiles.create({ targetElo: 1800 }, 'clock');
    const normal = Perception.inspect(c, lines[0], profile, { fen, remainingSeconds: 180 });
    const trouble = Perception.inspect(c, lines[0], profile, { fen, remainingSeconds: 5 });
    assert.ok(trouble.clockFactor < normal.clockFactor);
    assert.ok(trouble.uncertainty > normal.uncertainty);
  });
  await check('same history and seed reproduce a decision without advancing state', () => {
    const selector = new HumanSelector(Profiles.create({ targetElo: 1200 }, 'stable'));
    const a = selector.select(lines, { fen, decisionKey: 'turn-1' });
    const b = selector.select(lines, { fen, decisionKey: 'turn-1' });
    assert.deepEqual(a, b); assert.equal(selector.planState, null);
  });
  await check('analysis only prepares state; actual own move commits it exactly once', () => {
    const session = new GameSession(); session.begin({ mode: 'human', playerColor: 'w' }, { targetElo: 1200 }, 0, fen);
    const decision = new HumanSelector(session.data.profileSnapshot).select(lines, { fen, decisionKey: session.decisionKey(fen) });
    session.remember(fen, decision); assert.equal(session.data.planState, null);
    const board = new ChessRules(fen); board.move({ from: decision.move.slice(0, 2), to: decision.move.slice(2, 4) });
    const transition = transitionBetween(fen, board.fen()); session.observe(transition);
    const saved = structuredClone(session.data); session.observe(transition); assert.deepEqual(session.data, saved);
    assert.deepEqual(session.data.planState, decision.pendingState.planState);
    assert.ok(session.data.perceptionState.attention > 0);
  });
  await check('reload preserves current choice; repeated position with new history bypasses cache', () => {
    const session = new GameSession(); session.begin({ mode: 'human', playerColor: 'w' }, { targetElo: 1200 }, 0, fen);
    const decision = new HumanSelector(session.data.profileSnapshot).select(lines, { fen }); session.remember(fen, decision);
    const restored = new GameSession(JSON.parse(JSON.stringify(session.data)));
    assert.equal(restored.decision(fen).move, decision.move);
    restored.data.completedMoves += 4; restored.data.historyHash += 1; assert.equal(restored.decision(fen), null);
  });
  await check('long-game decision cache fits durable session storage', () => {
    const session = new GameSession(); session.begin({ mode: 'human', playerColor: 'w' }, { targetElo: 1200 }, 0, fen);
    const decision = new HumanSelector(session.data.profileSnapshot).select(lines, { fen });
    for (let ply = 0; ply < 180; ply++) session.remember(fen.replace(' 0 1', ` 0 ${ply+1}`), {
      ...decision, lines: Array.from({ length: 12 }, (_,i) => ({ ...lines[i%4], pv: Array(40).fill('e2e4') })) });
    assert.equal(Object.keys(session.data.decisions).length, 24);
    assert.ok(JSON.stringify(session.data).length < 500000);
  });
  await check('different executed move invalidates pending plan and calibration sample', () => {
    const session = new GameSession(); session.begin({ mode: 'human', playerColor: 'w' }, { targetElo: 1200 }, 0, fen);
    session.remember(fen, { humanPolicyVersion: 2, move: 'd2d4', pendingState: { planState: { type: 'develop' } } });
    const board = new ChessRules(); board.move('e4'); session.observe(transitionBetween(fen, board.fen()));
    assert.equal(session.data.planState, null); assert.equal(session.data.manualOverride, true);
  });
  await check('concrete goal persists across unrelated moves and is reconsidered after completion', () => {
    const tracker = new PlanTracker(), plan = tracker.update(fen, 0, {}, 'balanced');
    const board = new ChessRules(); board.move('e4'); board.move('e5');
    assert.equal(tracker.update(board.fen(), 0, {}, 'balanced').goal, plan.goal);
    board.move('Nf3'); board.move('Nc6'); board.move('Bc4'); board.move('a6');
    assert.equal(tracker.update(board.fen(), 0, {}, 'balanced').nextMove, 'e1g1');
    board.move('O-O'); board.move('d6');
    assert.equal(tracker.update(board.fen(), 0, {}, 'balanced').changeReason, 'цель достигнута');
    assert.ok(plan.pieceSquare && plan.targetSquare);
  });
  await check('mode migration preserves choices and separates wins from score targets', () => {
    const defaults = Settings.normalize({}); assert.equal(defaults.humanTargetWinRate, 0.65); assert.equal(defaults.ratedTargetScore, 0.55);
    const legacy = Settings.normalize({ playMode: 'human', adaptiveStrength: true, targetWinRate: 0.7 });
    assert.equal(legacy.playMode, 'human'); assert.equal(legacy.adaptiveStrength, true); assert.equal(legacy.humanTargetWinRate, 0.7);
    assert.equal(Settings.target(legacy, 'rated'), 0.55);
    const current = Settings.normalize({ ...legacy, playMode: 'rated' }); assert.equal(current.humanTargetWinRate, 0.7);
  });
  await check('human advantage is independent of rated mode and bounded at profile limits', () => {
    assert.equal(Profiles.create({ targetElo: 1000, playMode: 'human', adaptiveStrength: true }).level, 1170);
    assert.equal(Profiles.create({ targetElo: 1000, playMode: 'rated', adaptiveStrength: true }).level, 1000);
    assert.equal(Profiles.create({ targetElo: 2800, playMode: 'human', adaptiveStrength: true }).level, 2800);
    assert.equal(Profiles.create({ targetElo: 1400, playMode: 'human', adaptiveStrength: true }).modelLevel, 1370);
    for (let level = 800; level < 2800; level += 25) assert.ok(
      Profiles.create({ targetElo: level + 25, playMode: 'human' }).modelLevel >= Profiles.create({ targetElo: level, playMode: 'human' }).modelLevel);
  });
  await check('new version, calibration, target and bias isolate adaptive groups', () => {
    const meta = { mode: 'human', humanPolicyVersion: 2, baseLevel: 1200, target: 0.65 };
    for (const patch of [{ humanPolicyVersion: 1 }, { calibrationVersion: 2 }, { target: 0.7 }, { strengthBias: 170 }])
      assert.notEqual(Adapter.group(meta), Adapter.group({ ...meta, ...patch }));
  });
  await check('operational window and stable-strength validation remain distinct', () => {
    const state = Adapter.empty(), meta = { mode: 'human', baseLevel: 1400, humanPolicyVersion: 2, target: 0.65 };
    for (let i = 0; i < 400; i++) Adapter.record(state, { ...meta, id: 'result-' + i, result: i % 20 < 13 ? 'win' : i % 20 < 16 ? 'draw' : 'loss', resultSource: 'test' });
    const stats = Adapter.current(state, Adapter.group(meta)); assert.equal(stats.winRate, 0.65); assert.equal(stats.scoreRate, 0.725);
    assert.equal(stats.games, 100); assert.equal(stats.validation.games, 400); assert.equal(stats.offset, 0);
    assert.ok(stats.validation.low > stats.low && stats.validation.high < stats.high);
  });
  await check('uncalibrated manual results do not adjust strength', () => {
    const state = Adapter.empty(); Adapter.record(state, { id: 'manual', result: 'win', resultSource: 'test', manualOverride: true });
    assert.equal(state.history.length, 1); assert.equal(Object.keys(state.groups).length, 0);
  });
  await check('persistent bias accumulates evidence beyond 100 games at the frozen strength', () => {
    const state = Adapter.empty(), meta = { mode: 'human', baseLevel: 1400, humanPolicyVersion: 2, target: 0.65 };
    for (let i = 0; i < 400; i++) Adapter.record(state, { ...meta, id: 'bias-' + i,
      profileSnapshot: { modelLevel: 1400, modelCorrection: 0 }, result: i % 4 < 3 ? 'win' : 'loss', resultSource: 'test' });
    const group = state.groups[Adapter.group(meta)]; assert.ok(group.offset < 0);
    // Old-strength results can remain in history, but cannot keep reducing the new strength.
    assert.equal(group.offset, -40);
  });
  await check('between-game feedback converges in a seeded simulation and only updates every ten results', () => {
    const state = Adapter.empty(), meta = { mode: 'human', baseLevel: 1400, humanPolicyVersion: 2, target: 0.65 };
    const random = Profiles.random('feedback-validation'); let changes = 0;
    for (let i = 0; i < 1200; i++) {
      const before = state.groups[Adapter.group(meta)]?.offset || 0;
      const probability = 1 / (1 + 10 ** (-(382 + before) / 400));
      Adapter.record(state, { ...meta, id: 'feedback-' + i, profileSnapshot: { modelLevel: 1400 + before, modelCorrection: 0 },
        result: random() < probability ? 'win' : 'loss', resultSource: 'test' });
      const after = state.groups[Adapter.group(meta)].offset;
      if (after !== before) { assert.equal((i + 1) % 10, 0); assert.ok(Math.abs(after-before) <= 40); changes++; }
    }
    const offset = state.groups[Adapter.group(meta)].offset, probability = 1 / (1 + 10 ** (-(382 + offset) / 400));
    assert.ok(changes > 0); assert.ok(probability >= 0.58 && probability <= 0.72, probability);
  });
  await check('controller scores natural roots within one shared budget and freezes cached decisions', async () => {
    const session = new GameSession(); session.begin({ mode: 'human', playerColor: 'w' }, { targetElo: 1400 }, 0, fen);
    const controller = new EngineController({ playMode: 'human' }); controller.setSession(session);
    controller.init = async () => true; controller.openingsBook.db = {};
    const requests = [];
    controller.requestAnalysis = async (_, options) => { requests.push(options); return { success: true,
      engineSource: 'nnue', lines: options.searchmoves ? options.searchmoves.map(uci => ({ uci, score: { unit: 'cp', value: 0 }, depth: 8, pv: [uci] })) : lines }; };
    const first = await controller.analyzePosition(fen, { movetime: 300 }); const second = await controller.analyzePosition(fen);
    assert.equal(first.move, second.move); assert.equal(requests.length, 2);
    assert.ok(requests[1].searchmoves.some(uci => !lines.some(line => line.uci === uci)));
    assert.equal(session.data.planState, null); assert.equal(first.humanPolicyVersion, 2);
    assert.ok(first.allCandidates.every(c => c.engineEvaluation));
  });
  await check('very low clocks skip extra search; incomplete roots stay explicitly unscored', async () => {
    const controller = new EngineController({ playMode: 'human' }); controller.init = async () => true; controller.openingsBook.db = {};
    let count = 0; controller.requestAnalysis = async () => { count++; return { success: true, lines: [lines[0]] }; };
    const result = await controller.analyzePosition(fen, { remainingSeconds: 5, movetime: 30 });
    assert.equal(count, 1); assert.ok(result.allCandidates.some(c => c.engineEvaluation === null && c.lossCp === null));
    assert.ok(new ChessRules(fen).move({ from: result.move.slice(0, 2), to: result.move.slice(2, 4) }));
  });
  await check('late v2 analysis cannot cache under a different observed history', async () => {
    const session = new GameSession(); session.begin({ mode: 'human', playerColor: 'w' }, { targetElo: 1200 }, 0, fen);
    const controller = new EngineController({ playMode: 'human' }); controller.setSession(session);
    controller.init = async () => true; controller.openingsBook.db = {};
    let release; controller.requestAnalysis = () => new Promise(resolve => { release = resolve; });
    const pending = controller.analyzePosition(fen, { remainingSeconds: 5 });
    await new Promise(resolve => setImmediate(resolve)); session.data.completedMoves++;
    release({ success: true, lines }); await pending;
    assert.equal(session.data.decisions[fen], undefined);
  });
  console.log(`Human v2 checks passed: ${checks}`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
