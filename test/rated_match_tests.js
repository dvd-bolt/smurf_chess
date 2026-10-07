/* Independent anchors: actual Stockfish UCI_Elo opponents, paired colors and held-out seeds.
 * MATCH_LEVELS=1000 MATCH_PAIRS=12 MATCH_MS=100 node test/rated_match_tests.js
 * Low profiles are compared with Stockfish's 1320 floor; implied ratings are estimates.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ChessRules } = require('../vendor/chess.js');
const { UciEngine } = require('../engine/uci_engine.js');
const { NodeWorker } = require('./nnue_tests.js');
const Rated = require('../engine/rated_profile.js');
const { outcome } = require('../engine/game_session.js');
const Adapter = require('../engine/strength_adapter.js');
const openings = [[], ['e4', 'e5', 'Nf3', 'Nc6'], ['d4', 'd5', 'c4', 'e6'], ['e4', 'c5', 'Nf3', 'd6'],
  ['d4', 'Nf6', 'c4', 'g6'], ['e4', 'e6', 'd4', 'd5'], ['c4', 'e5'], ['Nf3', 'd5', 'g3', 'Nf6']];
const levels = (process.env.MATCH_LEVELS || '800,1000,1200,1400,1800,2200,2600').split(',').map(Number);
const pairs = Number(process.env.MATCH_PAIRS) || 8;
const movetime = Number(process.env.MATCH_MS) || 100;
const maxPlies = Number(process.env.MATCH_PLIES) || 400;
const concurrency = Number(process.env.MATCH_CONCURRENCY) || 3;
const phase = process.env.MATCH_PHASE || 'validation';
const equalOpponent = process.env.MATCH_OPPONENT === 'equal';
const referenceOverride = Number(process.env.MATCH_REFERENCE) || null;
if (referenceOverride !== null) assert.ok(Number.isInteger(referenceOverride) && referenceOverride >= Rated.FLOOR && referenceOverride <= 3190,
  'MATCH_REFERENCE must be an integer within the independent Stockfish range 1320..3190');
function opponentLevel(level) { return referenceOverride || (equalOpponent ? level : Math.max(Rated.FLOOR, level)); }
const report = { schemaVersion: 1, generatedAt: new Date().toISOString(), policyVersion: Rated.VERSION, phase,
  purpose: 'Rating-limited profiles against independent Stockfish UCI_Elo anchors',
  conditions: { movetime, maxPlies, pairs, openings: openings.length, colorPairs: true, targetScore: Rated.TARGET,
    equalOpponent, referenceOverride, errorKnots: Rated.ERROR_KNOTS, engineCorrections: Rated.ENGINE_CORRECTIONS,
    errorScaleOverride: process.env.MATCH_ERROR_SCALE || null },
  limitation: 'Short fixed searches; estimates use the Stockfish scale, not verified human/site ratings. Unfinished games are excluded and reported separately.', games: [] };
function summary(games, level) {
  const anchor = opponentLevel(level);
  const stats = Adapter.summarize(games, Rated.TARGET, 0, 'score');
  const probability = stats.scoreRate;
  const expected = 1 / (1 + 10 ** ((anchor - (level + Rated.ADVANTAGE)) / 400));
  const estimate = probability > 0 && probability < 1 ? anchor + 400 * Math.log10(probability / (1 - probability)) : null;
  return { level, opponentElo: anchor, ...stats, expectedScore: expected, estimatedElo: estimate === null ? null : Math.round(estimate),
    unfinished: games.filter(game => game.result === 'unfinished').length,
    opponentModel: equalOpponent && anchor < Rated.FLOOR ? 'low-profile (relative check only)' : 'Stockfish UCI_Elo',
    errorProbability: games[0]?.errorProbability ?? Rated.create(level).errorProbability };
}
async function runLane(jobs) {
  const own = new UciEngine(path.resolve(__dirname, '../offscreen/stockfish-nnue.js'), { WorkerClass: NodeWorker });
  const opponent = new UciEngine(path.resolve(__dirname, '../offscreen/stockfish-nnue.js'), { WorkerClass: NodeWorker });
  try {
    while (jobs.length) {
      const job = jobs.shift();
      const { level, pair, color } = job;
      const game = new ChessRules();
      for (const san of openings[pair % openings.length]) assert.ok(game.move(san));
      const profile = Rated.create(level, `${phase}:${pair}`);
      const referenceProfile = Rated.create(level, `${phase}:reference:${pair}`, 0);
      if (process.env.MATCH_ERROR_SCALE) profile.errorProbability = profile.effectiveElo < Rated.FLOOR ?
        1 - Math.exp((profile.effectiveElo - Rated.FLOOR) / Number(process.env.MATCH_ERROR_SCALE)) : 0;
      const record = { ...job, phase, result: 'unfinished', plies: 0, alternateMoves: 0, errorProbability: profile.errorProbability,
        opponentElo: opponentLevel(level), ratingProfile: { ...profile }, pgn: '' };
      const reset = { own: true, opponent: true };
      while (record.plies < maxPlies && !game.game_over()) {
        const ours = game.turn() === color;
        const side = ours ? 'own' : 'opponent';
        const engine = ours ? own : opponent;
        const response = await engine.analyze({ fen: game.fen(), depth: 24, movetime, multipv: 4,
          ratingElo: ours ? profile.engineElo : Math.max(Rated.FLOOR, record.opponentElo), newGame: reset[side] });
        reset[side] = false;
        assert.equal(response.ratingSupported, true);
        assert.equal(response.appliedElo, ours ? profile.engineElo : Math.max(Rated.FLOOR, record.opponentElo));
        assert.equal(response.success, true, response.error);
        let uci = response.bestmove;
        if (ours) {
          const alternative = Rated.alternative(profile, game.fen(), game.moves({ verbose: true }), uci);
          if (alternative) { uci = alternative; record.alternateMoves++; }
        } else if (equalOpponent && record.opponentElo < Rated.FLOOR) {
          uci = Rated.alternative(referenceProfile, game.fen(), game.moves({ verbose: true }), uci) || uci;
        }
        assert.ok(game.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] }), uci);
        record.plies++;
      }
      const final = outcome(game.fen(), color);
      if (final) record.result = final.result;
      else if (game.in_draw()) record.result = 'draw';
      record.finalFen = game.fen(); record.pgn = game.pgn();
      report.games.push(record);
      console.log(`RATED ${level} vs ${record.opponentElo}, pair=${pair} ${color}: ${record.result}, ${record.plies} plies, errors=${record.alternateMoves}`);
    }
  } finally { own.destroy(); opponent.destroy(); }
}
async function main() {
  const jobs = levels.flatMap(level => Array.from({ length: pairs }, (_, pair) => ['w', 'b'].map(color => ({ level, pair, color }))).flat());
  await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, () => runLane(jobs)));
  report.games.sort((a, b) => a.level - b.level || a.pair - b.pair || a.color.localeCompare(b.color));
  report.summaries = levels.map(level => summary(report.games.filter(game => game.level === level), level));
  const destination = path.resolve(__dirname, process.env.MATCH_REPORT || 'rated_match_report.json');
  fs.writeFileSync(destination, JSON.stringify(report, null, 2));
  console.log('REPORT', destination);
  console.log(JSON.stringify(report.summaries, null, 2));
}
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { summary };
