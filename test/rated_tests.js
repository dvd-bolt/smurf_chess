const assert = require('node:assert/strict');
const path = require('node:path');
const { ChessRules } = require('../vendor/chess.js');
const Rated = require('../engine/rated_profile.js');
const { EngineController } = require('../engine/engine_controller.js');
const { GameSession } = require('../engine/game_session.js');
const { UciEngine } = require('../engine/uci_engine.js');
const { NodeWorker } = require('./nnue_tests.js');
const Adapter = require('../engine/strength_adapter.js');
const START = new ChessRules().fen();
async function main() {
  const requests = [];
  const controller = new EngineController({ playMode: 'rated', targetElo: 1000 });
  controller.init = () => { throw new Error('Rated play must bypass the book'); };
  controller.requestAnalysis = async (fen, options) => {
    requests.push(options);
    return { success: true, ratingSupported: true, appliedElo: options.ratingElo, engineSource: 'nnue', bestmove: 'a2a3',
      lines: [{ uci: 'e2e4', score: { unit: 'cp', value: 90 }, depth: 12 },
        { uci: options.searchmoves?.[0] || 'a2a3', score: { unit: 'cp', value: -250 }, depth: 12 }] };
  };
  const session = new GameSession(); session.begin({ mode: 'rated', playerColor: 'w' }, { targetElo: 1000 }, 0, START);
  controller.setSession(session);
  const chosen = await controller.analyzePosition(START);
  assert.equal(chosen.strategy, 'rated');
  assert.equal(requests[0].ratingElo, 1320);
  assert.equal(chosen.move, 'a2a3'); // bestmove is the weakened choice; PV1 must never replace it.
  assert.equal(chosen.allCandidates.find(candidate => candidate.uci === 'a2a3').isAllowedByProfile, true);
  assert.equal(chosen.allCandidates.find(candidate => candidate.uci === 'a2a3').isWithinStrictSafety, false);
  controller.setOptions({ targetElo: 2200 });
  assert.equal((await controller.analyzePosition(START)).move, chosen.move);
  assert.equal(requests.length, 1);
  assert.equal(chosen.ratingProfile.nominalElo, 1000);
  console.log('PASS rated: weakened bestmove, no book/safety override, frozen profile and cached decision');
  const weak = Rated.create(1000), strong = Rated.create(2000);
  assert.equal(strong.engineElo, 2035); assert.equal(strong.errorProbability, 0);
  assert.ok(weak.errorProbability > Rated.create(1200).errorProbability);
  assert.ok(Rated.create(800).errorProbability > weak.errorProbability);
  assert.equal(Rated.ADVANTAGE, 35);
  assert.equal(Rated.create(2600).engineElo, 2610);
  for (let level = 800; level < 2800; level += 100) assert.ok(Rated.create(level + 100).engineElo >= Rated.create(level).engineElo);
  const moves = new ChessRules().moves({ verbose: true });
  let errors = 0;
  for (let seed = 0; seed < 1000; seed++) {
    const profile = Rated.create(1000, seed);
    const a = Rated.alternative(profile, START, moves, 'e2e4');
    assert.equal(a, Rated.alternative(profile, START, moves, 'e2e4'));
    if (a) { errors++; assert.ok(new ChessRules().move({ from: a.slice(0, 2), to: a.slice(2, 4), promotion: a[4] })); }
  }
  assert.ok(Math.abs(errors / 1000 - weak.errorProbability) < 0.035);
  console.log('PASS rated: monotonic low-level errors, deterministic legal moves and 55% score offset');
  const recordState = Adapter.empty();
  const meta = { mode: 'rated', baseLevel: 1500 };
  for (let i = 0; i < 100; i++) Adapter.record(recordState, { ...meta, id: String(i), result: i < 30 ? 'win' : i < 80 ? 'draw' : 'loss', resultSource: 'test' }, 0.55);
  const stats = Adapter.current(recordState, Adapter.group(meta), 0.55);
  assert.equal(stats.metric, 'score'); assert.equal(stats.scoreRate, 0.55); assert.equal(stats.winRate, 0.3);
  assert.equal(stats.status, 'target');
  controller.gameSession = null;
  controller.requestAnalysis = async () => ({ success: true, bestmove: 'e2e4', ratingSupported: false, lines: [] });
  assert.equal((await controller.analyzePosition(START)).move, null);
  controller.requestAnalysis = async () => ({ success: true, bestmove: 'e2e4', ratingSupported: true, appliedElo: 2200, lines: [] });
  assert.equal((await controller.analyzePosition(START)).move, null);
  console.log('PASS rated: draws count as half a point; unsupported engines cannot silently play at full strength');
  const workers = [];
  class FakeWorker {
    constructor() { this.commands = []; workers.push(this); }
    postMessage(command) { this.commands.push(command); }
    terminate() {}
    emit(line) { this.onmessage({ data: line }); }
  }
  const protocol = new UciEngine('fake', { WorkerClass: FakeWorker });
  const low = protocol.analyze({ fen: START, ratingElo: 1535 });
  const full = protocol.analyze({ fen: START, ratingElo: null });
  const worker = workers[0];
  worker.emit('option name UCI_Elo type spin default 1320 min 1320 max 3190');
  worker.emit('option name UCI_LimitStrength type check default false');
  worker.emit('option name Skill Level type spin default 20 min 0 max 20');
  worker.emit('uciok'); worker.emit('readyok');
  assert.ok(worker.commands.includes('setoption name UCI_Elo value 1535'));
  assert.ok(worker.commands.includes('setoption name UCI_LimitStrength value true'));
  worker.emit('info depth 12 multipv 1 score cp 90 pv e2e4');
  worker.emit('info depth 12 multipv 2 score cp -250 pv a2a3');
  worker.emit('bestmove a2a3');
  assert.equal((await low).bestmove, 'a2a3');
  assert.ok(worker.commands.includes('setoption name UCI_LimitStrength value false'));
  worker.emit('info depth 12 score cp 90 pv e2e4'); worker.emit('bestmove e2e4');
  assert.equal((await full).appliedElo, undefined);
  protocol.destroy();
  console.log('PASS rated: queued UCI requests preserve weakened bestmove and reset strength even for explicit null');
  const engine = new UciEngine(path.resolve(__dirname, '../offscreen/stockfish-nnue.js'), { WorkerClass: NodeWorker });
  try {
    const limited = await engine.analyze({ fen: START, depth: 12, movetime: 100, multipv: 4, ratingElo: 1535 });
    assert.equal(limited.ratingSupported, true); assert.equal(limited.appliedElo, 1535);
    assert.ok(new ChessRules().move({ from: limited.bestmove.slice(0, 2), to: limited.bestmove.slice(2, 4), promotion: limited.bestmove[4] }));
    const reset = await engine.analyze({ fen: START, depth: 10, movetime: 100, multipv: 1 });
    assert.equal(reset.appliedElo, undefined); assert.equal(reset.success, true);
    console.log('PASS rated: real NNUE limits ELO and restores full analysis on the next search');
  } finally { engine.destroy(); }
}
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { main };
