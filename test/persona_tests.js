const assert = require('node:assert/strict');
const { features, modifier, normalizePersona } = require('../engine/personas.js');
const { MoveSelector } = require('../engine/move_selector.js');
function runPersonaTests() {
let checks = 0;
function check(name, test) { test(); checks++; console.log('PASS persona:', name); }
function distribution(persona, fen, lines) {
  return new MoveSelector({ aiPersona: persona, snowballMode: false }).selectMove(lines, null, { fen }).allCandidates;
}
const line = (uci, cp, pv = [uci]) => ({ uci, score: { unit: 'cp', value: cp }, pv });
const attacking = '6k1/5ppp/8/8/8/8/5PPP/3R2K1 w - - 0 20';
const attacks = [line('d1d2', 100), line('d1d8', 90), line('g2g3', 80)];
const balanced = distribution('balanced', attacking, attacks);
const tal = distribution('tal', attacking, attacks);
check('Checking move recognized', () => assert.equal(features(attacking, 'd1d8').isCheck, true));
check('Tal raises probability of check', () => assert.ok(tal[1].probability > balanced[1].probability));
check('Tal boost is a 1.35 relative weight multiplier', () => assert.ok(Math.abs((tal[1].probability / tal[0].probability) / (balanced[1].probability / balanced[0].probability) - 1.35) < 1e-10));
check('Capture recognized', () => assert.equal(features('6k1/3p4/8/8/8/8/5PPP/3R2K1 w - - 0 20', 'd1d7').isCapture, true));
const opening = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2';
const development = [line('d1h5', 50), line('g1f3', 45), line('f1c4', 40)];
const neutralDev = distribution('balanced', opening, development);
const karpov = distribution('karpov', opening, development);
check('Minor development recognized', () => assert.equal(features(opening, 'g1f3').isMinorDev, true));
check('Early queen excursion penalized', () => assert.equal(features(opening, 'd1h5').isEarlyQueen, true));
check('Karpov prefers development over early queen', () => assert.ok(karpov[1].probability > neutralDev[1].probability && karpov[0].probability < neutralDev[0].probability));
const exchange = '3qr1k1/8/8/8/8/8/8/3Q2K1 w - - 0 20';
const trades = [line('d1d2', 140), line('d1d8', 130, ['d1d8', 'e8d8']), line('d1e1', 125)];
check('Legal queen trade verified through PV', () => assert.equal(features(exchange, 'd1d8', trades[1].pv).isQueenTrade, true));
check('Capture of a queen alone is not a trade', () => assert.equal(features(exchange, 'd1d8', ['d1d8']).isQueenTrade, false));
check('Capablanca favors queen trade with advantage', () => assert.ok(distribution('capablanca', exchange, trades)[1].probability > distribution('balanced', exchange, trades)[1].probability));
check('Queen trade bonus starts at 100 centipawns', () => assert.equal(modifier('capablanca', { isQueenTrade: true }, 99), 1));
const endgame = '6k1/7p/8/8/8/8/P7/6K1 w - - 0 40';
check('Endgame king centralization recognized', () => assert.equal(features(endgame, 'g1f2').isKingActive, true));
check('Passed pawn advance recognized', () => assert.equal(features(endgame, 'a2a3').isPassedPawn, true));
check('Invalid persona restores balanced default', () => assert.equal(normalizePersona('unknown'), 'balanced'));
check('Illegal move yields no style bonus', () => assert.equal(modifier('tal', features(attacking, 'd1e8'), 100), 1));
check('Prophylaxis removes an undefended knight from attack', () => assert.equal(features('6k1/8/8/8/1p6/2N5/8/6K1 w - - 0 20', 'c3e4').isProphylaxis, true));
check('Safety threshold cannot exceed 160 cp', () => assert.equal(new MoveSelector({ blunderThresholdCp: 999 }).blunderThresholdCp, 160));
check('Pawn sacrifice requires verified initiative in the PV', () => {
  const f = features('6k1/8/8/1p6/2P5/8/8/3R2K1 w - - 0 20', 'd1d2', ['d1d2', 'b5c4', 'd2d8']);
  assert.equal(f.isPawnSacrifice, true);
  assert.equal(modifier('tal', f, 50), 1.35);
});
for (const persona of ['balanced', 'tal', 'karpov', 'capablanca']) {
  const candidates = distribution(persona, attacking, [line('d1d2', 100), line('d1d8', -100), line('g2g3', 80)]);
  const unsafe = candidates.find(candidate => candidate.uci === 'd1d8');
  check(`${persona} never recommends an unsafe checking move`, () => { assert.equal(unsafe.isSafe, false); assert.equal(unsafe.probability, 0); });
  check(`${persona} probabilities sum to one`, () => assert.ok(Math.abs(candidates.reduce((sum, c) => sum + c.probability, 0) - 1) < 1e-10));
}
console.log('Persona checks passed:', checks);

return checks;
}
if (require.main === module) runPersonaTests();
module.exports = { runPersonaTests };
