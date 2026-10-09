/* Full production human pipeline vs independently stateful UCI_Elo opponents.
 * MATCH_LEVELS=1400 MATCH_PAIRS=8 MATCH_MS=100 MATCH_PHASE=validation npm run test:human-matches
 * Reports are checkpointed and resumable. A ply limit is never adjudicated as a result.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { ChessRules } = require('../vendor/chess.js');
const { UciEngine } = require('../engine/uci_engine.js');
const { NodeWorker } = require('./nnue_tests.js');
const { EngineController } = require('../engine/engine_controller.js');
const { GameSession, outcome } = require('../engine/game_session.js');
const Adapter = require('../engine/strength_adapter.js');
const Profiles = require('../engine/player_profile.js');
const Rated = require('../engine/rated_profile.js');
const { TimeManager } = require('../content/time_manager.js');
const levels = (process.env.MATCH_LEVELS || '1000,1400,1800').split(',').map(Number);
const pairs = Number(process.env.MATCH_PAIRS) || 4;
const movetime = Number(process.env.MATCH_MS) || 100;
const maxPlies = Number(process.env.MATCH_PLIES) || 500;
const lanes = Number(process.env.MATCH_CONCURRENCY) || 3;
const phase = process.env.MATCH_PHASE || 'validation';
const reference = Number(process.env.MATCH_REFERENCE) || null;
const bias = Number(process.env.MATCH_BIAS ?? 170);
const offset = Number(process.env.MATCH_OFFSET) || 0;
const policy = Number(process.env.MATCH_POLICY) || 2;
const timeControl = process.env.MATCH_TIME_CONTROL || 'untimed';
const clockSpec = /^(\d+)\+(\d+)$/.exec(timeControl);
assert.ok(timeControl === 'untimed' || clockSpec, 'Use MATCH_TIME_CONTROL=untimed or seconds+increment');
assert.ok(levels.every(level => Number.isInteger(level) && level >= 800 && level <= 2800));
assert.ok(!reference || reference >= 1320 && reference <= 3190);
assert.ok(['calibration', 'validation'].includes(phase));
const startPair = Number(process.env.MATCH_START_PAIR) || 0;
const validationSet = Number(process.env.MATCH_VALIDATION_SET) || 1;
const openings = phase === 'calibration' ? [[], ['e4','e5','Nf3','Nc6'], ['d4','d5','c4','e6'], ['e4','c5','Nf3','d6']] :
  validationSet === 2 ? [['e4','d5','exd5','Qxd5'], ['d4','d5','c4','c6'], ['e4','g6','d4','Bg7'], ['Nf3','Nf6','g3','g6']] :
    [['e4','c6','d4','d5'], ['c4','e5','Nc3','Nf6'], ['d4','Nf6','c4','g6'], ['e4','e6','d4','d5']];
const destination = path.resolve(__dirname, process.env.MATCH_REPORT || `human_v${policy}_${phase}_report.json`);
const conditions = { levels, pairs, startPair, validationSet, movetime, maxPlies, bias, offset, policy, reference, timeControl,
  calibrationVersion: Profiles.HUMAN_CALIBRATION_VERSION, humanCorrections: Profiles.HUMAN_CORRECTIONS,
  targetWinRate: 0.65, colorPairs: true, independentEngines: true, frozenStrength: true, openings,
  sourceHash: createHash('sha256').update(['player_profile','human_candidates','human_perception','human_selector','plan_tracker','engine_controller','game_session','position_complexity','uci_engine']
    .map(name => fs.readFileSync(path.resolve(__dirname,'../engine/' + name + '.js'),'utf8')).join('\n')).digest('hex') };
let report = { schemaVersion: 2, generatedAt: new Date().toISOString(), humanPolicyVersion: policy, calibrationVersion: Profiles.HUMAN_CALIBRATION_VERSION, phase, conditions,
  limitation: 'Fixed-search engine opponents on the Stockfish scale. Human/site rating and similarity to human move datasets are not certified. Censored games are reported; no artificial adjudication.', games: [] };
if (process.env.MATCH_RESUME === '1' && fs.existsSync(destination)) {
  report = JSON.parse(fs.readFileSync(destination, 'utf8'));
  assert.deepEqual(report.conditions, conditions, 'Cannot resume a report with different conditions');
}
const percentile = (items, p) => items.length ? items.slice().sort((a,b) => a-b)[Math.min(items.length-1, Math.floor(items.length*p))] : null;
function checkpoint() {
  report.summaries = levels.map(level => {
    const games = report.games.filter(game => game.level === level), finished = games.filter(game => game.result !== 'unfinished');
    const stats = Adapter.summarize(finished, 0.65, 0, 'wins', 100000);
    const total = games.length, unfinished = total - finished.length;
    const ms = games.flatMap(game => game.decisionMs || []);
    return { level, opponentElo: reference || Math.max(1320, level), ...stats, unfinished,
      winRateLowerIfUnfinishedLose: total ? stats.wins / total : null,
      winRateUpperIfUnfinishedWin: total ? (stats.wins + unfinished) / total : null,
      p95DecisionMs: percentile(ms, 0.95), medianDecisionMs: percentile(ms, 0.5),
      selectedUnscored: games.reduce((sum,g) => sum + g.selectedUnscored, 0),
      naturalSelections: games.reduce((sum,g) => sum + g.naturalSelections, 0),
      confirmed: !unfinished && stats.games >= 350 && stats.low >= 0.6 && stats.high <= 0.7 };
  });
  report.games.sort((a,b) => a.level-b.level || a.pair-b.pair || a.color.localeCompare(b.color));
  report.updatedAt = new Date().toISOString();
  fs.writeFileSync(destination + '.tmp', JSON.stringify(report, null, 2));
  fs.renameSync(destination + '.tmp', destination);
}
async function runLane(jobs) {
  const own = new UciEngine(path.resolve(__dirname, '../offscreen/stockfish-nnue.js'), { WorkerClass: NodeWorker });
  const opponent = new UciEngine(path.resolve(__dirname, '../offscreen/stockfish-nnue.js'), { WorkerClass: NodeWorker });
  try {
    // Warm up both workers before measuring the decision budget.
    const initial = new ChessRules().fen();
    await Promise.all([own.analyze({ fen: initial, movetime: 1, depth: 1 }), opponent.analyze({ fen: initial, movetime: 1, depth: 1 })]);
    while (jobs.length) {
      const job = jobs.shift(), { level, pair, color } = job;
      const game = new ChessRules(); for (const san of openings[pair % openings.length]) assert.ok(game.move(san));
      const options = { targetElo: level, playMode: 'human', adaptiveStrength: bias > 0, humanStrengthBias: bias,
        humanPolicyVersion: policy, humanTargetWinRate: 0.65 };
      const session = new GameSession(); session.begin({ site: 'test', sourceId: `${phase}:${level}:${pair}:${color}`,
        playerColor: color, mode: 'human', baseLevel: level }, options, offset, game.fen());
      session.data.profileSnapshot.gameSeed = `${phase}:${level}:${pair}:${color}`;
      const controller = new EngineController(options); controller.setSession(session);
      controller.openingsBook.db = require('../engine/openings_data.json'); controller.openingsBook.loaded = true;
      controller.requestAnalysis = (fen, search) => own.analyze({ ...search, fen }).then(response => ({ ...response, engineSource: 'nnue' }));
      const timer = new TimeManager({ random: Profiles.random(session.data.id + ':clock') });
      const record = { ...job, phase, opponentElo: reference || Math.max(1320,level), profile: session.data.profileSnapshot,
        result: 'unfinished', plies: 0, selectedUnscored: 0, naturalSelections: 0, planContinuations: 0,
        decisionMs: [], lossesCp: [], motifCounts: {}, termination: 'ply-limit' };
      let opponentNew = true;
      const clocks = clockSpec ? { w: Number(clockSpec[1]), b: Number(clockSpec[1]) } : null;
      while (record.plies < maxPlies && !game.game_over()) {
        const ours = game.turn() === color, side = game.turn(), before = game.fen();
        let move, decision;
        if (ours) {
          decision = await controller.analyzePosition(before, { movetime, remainingSeconds: clocks?.[side] ?? null });
          assert.ok(decision?.move, decision?.error);
          move = decision.move; record.decisionMs.push(decision.elapsedMs || 0);
          const selected = decision.allCandidates?.find(c => c.uci === move);
          if (!decision.isBook && !selected?.engineEvaluation && policy === 2) record.selectedUnscored++;
          if (selected?.lossCp !== null && selected?.lossCp !== undefined) record.lossesCp.push(selected.lossCp);
          if (selected?.originReasons?.length && !decision.lines.slice(0,4).some(l => l.uci === move)) record.naturalSelections++;
          if (move === decision.planState?.nextMove) record.planContinuations++;
          for (const motif of decision.missedMotifs || []) record.motifCounts[motif] = (record.motifCounts[motif] || 0) + 1;
        } else {
          const response = await opponent.analyze({ fen: before, movetime, depth: 24, multipv: 4,
            ratingElo: record.opponentElo, newGame: opponentNew }); opponentNew = false;
          assert.equal(response.success, true, response.error); assert.equal(response.appliedElo, record.opponentElo);
          move = response.bestmove;
        }
        if (clocks) {
          const think = ours ? timer.plan({ ...decision, fen: before, remainingSeconds: clocks[side], incrementSeconds: Number(clockSpec[2]),
            moveNumber: Number(before.split(' ')[5]) }).seconds : Math.min(3, clocks[side] * 0.04);
          clocks[side] -= Math.max(think, ours ? (decision.elapsedMs || 0)/1000 : movetime/1000);
          if (clocks[side] <= 0) { record.result = ours ? 'loss' : 'win'; record.termination = 'simulated-clock'; break; }
          clocks[side] += Number(clockSpec[2]);
        }
        const played = game.move({ from: move.slice(0,2), to: move.slice(2,4), promotion: move[4] }); assert.ok(played, move);
        session.observe({ before, after: game.fen(), move, color: side }); record.plies++;
      }
      const final = outcome(game.fen(), color);
      if (record.result === 'unfinished' && final) { record.result = final.result; record.termination = final.termination; }
      else if (record.result === 'unfinished' && game.in_draw()) { record.result = 'draw'; record.termination = 'rules-draw'; }
      record.finalFen = game.fen(); record.pgn = game.pgn(); if (clocks) record.finalClocks = clocks;
      report.games.push(record); checkpoint();
      console.log(`HUMAN v${policy} ${phase} ${level}+${bias}+${offset} vs ${record.opponentElo}: pair=${pair} ${color} ${record.result}, ${record.plies} plies`);
    }
  } finally { own.destroy(); opponent.destroy(); }
}
async function main() {
  const jobs = levels.flatMap(level => Array.from({ length:pairs },(_,i) => ['w','b'].map(color => ({level,pair:i+startPair,color}))).flat())
    .filter(job => !report.games.some(game => game.level === job.level && game.pair === job.pair && game.color === job.color));
  await Promise.all(Array.from({length:Math.min(lanes,jobs.length)},() => runLane(jobs)));
  checkpoint(); console.log('REPORT',destination); console.log(JSON.stringify(report.summaries,null,2));
}
main().catch(error => { console.error(error); process.exitCode=1; });
