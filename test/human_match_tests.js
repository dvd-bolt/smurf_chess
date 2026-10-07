/* Reproducible exploratory matches. Never adjudicate unfinished games as wins. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ChessRules } = require('../vendor/chess.js');
const { UciEngine } = require('../engine/uci_engine.js');
const { NodeWorker } = require('./nnue_tests.js');
const { HumanSelector } = require('../engine/human_selector.js');
const Profiles = require('../engine/player_profile.js');
const { outcome } = require('../engine/game_session.js');
const Adapter = require('../engine/strength_adapter.js');
async function main() {
  const engine = new UciEngine(path.resolve(__dirname, '../offscreen/stockfish-nnue.js'), { WorkerClass: NodeWorker });
  const openings = [[], ['e4', 'e5', 'Nf3', 'Nc6'], ['d4', 'd5', 'c4', 'e6']];
  const report = { schemaVersion: 1, generatedAt: new Date().toISOString(), purpose: 'exploratory calibration and independent seed validation',
    limitation: 'Small sample; short fixed search; unfinished games excluded from win rate. Does not certify a 60–70% win rate.', games: [] };
  const seedCount = Number(process.env.MATCH_SEEDS) || 3;
  const maxPlies = Number(process.env.MATCH_PLIES) || 160;
  try {
    for (const phase of ['calibration', 'validation']) {
      for (const level of [800, 2200]) {
        for (const opponentDepth of [4, 8]) {
          for (let seed = 0; seed < seedCount; seed++) {
            const color = seed % 2 ? 'b' : 'w';
            const game = new ChessRules();
            for (const san of openings[seed % openings.length]) assert.ok(game.move(san));
            const selector = new HumanSelector(Profiles.create({ targetElo: level }, `${phase}-${seed}`));
            const record = { phase, level, opponentDepth, seed, color, result: 'aborted', lossesCp: [], searchMs: [], selectedRanks: [], plies: 0 };
            for (let ply = 0; ply < maxPlies && !game.game_over(); ply++) {
              const own = game.turn() === color;
              const response = await engine.analyze({ fen: game.fen(), depth: own ? 8 : opponentDepth, movetime: 50, multipv: own ? 8 : 1 });
              assert.equal(response.success, true);
              let uci = response.lines[0].uci;
              if (own) {
                const chosen = selector.select(response.lines, { fen: game.fen(), remainingSeconds: 180 });
                uci = chosen.move;
                record.lossesCp.push(chosen.allCandidates.find(item => item.uci === uci).lossCp);
                record.selectedRanks.push(chosen.rank);
              }
              record.searchMs.push(response.elapsedMs);
              assert.ok(game.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] }), uci);
              record.plies++;
            }
            const final = outcome(game.fen(), color);
            if (final) record.result = final.result;
            else if (game.in_draw()) record.result = 'draw';
            record.finalFen = game.fen();
            report.games.push(record);
            console.log(`MATCH ${phase} level=${level} opponentDepth=${opponentDepth} seed=${seed} color=${color}: ${record.result}, ${record.plies} plies`);
          }
        }
      }
    }
    report.summaries = [];
    for (const phase of ['calibration', 'validation']) {
      for (const level of [800, 2200]) {
        for (const opponentDepth of [4, 8]) {
          const games = report.games.filter(item => item.phase === phase && item.level === level && item.opponentDepth === opponentDepth);
          const losses = games.flatMap(item => item.lossesCp);
          const times = games.flatMap(item => item.searchMs).sort((a, b) => a - b);
          report.summaries.push({ phase, level, opponentDepth, ...Adapter.summarize(games),
            unfinished: games.filter(item => item.result === 'aborted').length,
            averageLossCp: losses.reduce((sum, value) => sum + value, 0) / Math.max(1, losses.length),
            p95SearchMs: times[Math.floor(times.length * 0.95)] || 0 });
        }
      }
    }
    const destination = path.join(__dirname, 'human_match_report.json');
    fs.writeFileSync(destination, JSON.stringify(report, null, 2));
    console.log('Exploratory report:', destination);
    console.log(JSON.stringify(report.summaries.map(({ phase, level, opponentDepth, games, wins, draws, unfinished, averageLossCp, p95SearchMs }) =>
      ({ phase, level, opponentDepth, games, wins, draws, unfinished, averageLossCp: Number(averageLossCp.toFixed(1)), p95SearchMs })), null, 2));
  } finally { engine.destroy(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
