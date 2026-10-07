const assert = require('node:assert/strict');
const { TimeManager } = require('../content/time_manager.js');
const { ChessRules } = require('../vendor/chess.js');
let now = 1000;
const manager = new TimeManager({ random: () => 0.5, now: () => now });
const initial = new ChessRules().fen();
manager.beginTurn(initial);
const defaults = { fen: initial, move: 'e2e4', moveNumber: 1, remainingSeconds: 180 };
const book = manager.plan({ ...defaults, isBook: true });
assert.equal(book.reason, 'Дебют');
assert.ok(book.seconds >= 0.7 && book.seconds <= 1.5);
assert.ok(manager.plan(defaults).seconds > book.seconds);
const normal = manager.plan({ remainingSeconds: 180, moveNumber: 20 });
const complex = manager.plan({ remainingSeconds: 180, moveNumber: 20, isTactical: true });
assert.ok(complex.seconds > normal.seconds);
assert.ok(complex.seconds >= 6 && complex.seconds <= 12);
assert.ok(manager.plan({ ...defaults, remainingSeconds: 8, isBook: true }).seconds <= 0.6);
assert.ok(manager.plan({ ...defaults, remainingSeconds: 0.1 }).seconds <= 0.1);
assert.equal(manager.plan({ ...defaults, remainingSeconds: 0 }).seconds, 0);
assert.ok(manager.plan({ remainingSeconds: 120, moveNumber: 20, incrementSeconds: 2 }).seconds >
  manager.plan({ remainingSeconds: 120, moveNumber: 20 }).seconds);
const captureFen = '4k3/8/8/8/3p4/4P3/8/4K3 w - - 0 18';
assert.equal(manager.plan({ fen: captureFen, move: 'e3d4', moveNumber: 18 }).phase, 'capture');
const sacrificeFen = '4k3/8/8/2p5/3p4/4Q3/8/4K3 w - - 0 18';
assert.equal(manager.plan({ fen: sacrificeFen, move: 'e3d4', moveNumber: 18 }).phase, 'complex');
const promotionFen = '7k/P7/8/8/8/8/8/4K3 w - - 0 35';
assert.equal(manager.plan({ fen: promotionFen, move: 'a7a8q', moveNumber: 35 }).phase, 'complex');
assert.equal(manager.plan({ ...defaults, moveNumber: 18, lines: [
  { score: { unit: 'cp', value: 100 } }, { score: { unit: 'cp', value: 90 } }
] }).phase, 'choice');
const forcedFen = '8/8/8/8/8/q1k5/8/K7 w - - 0 40';
assert.equal(new ChessRules(forcedFen).moves().length, 1);
const forcedMove = new ChessRules(forcedFen).moves({ verbose: true })[0];
assert.equal(manager.plan({ fen: forcedFen, move: forcedMove.from + forcedMove.to }).phase, 'forced');
now = 2500;
assert.equal(manager.beginTurn(initial).startedAt, 1000);
let tick;
manager.startTimer(4, value => { tick = value; }, null, { startedAt: manager.turn.startedAt });
assert.equal(tick.remainingSec, '2.5');
manager.stopTimer();
let ready = 0;
now = 6000;
manager.startTimer(4, null, () => ready++, { startedAt: 1000 });
assert.equal(ready, 1);
assert.equal(manager.isReady, true);
assert.equal(manager.intervalId, null);
manager.reset();
assert.equal(manager.isReady, false);
// Explicit own clock beats the opponent's active clock, including flipped boards.
const savedDocument = global.document;
global.document = { querySelector: selector => selector === '[data-cy="black-player-clock"]' ? { textContent: '0:08' } : null,
  querySelectorAll: () => [{ textContent: '3:00' }, { textContent: '0:08' }] };
assert.equal(manager.readClockFromDom('black', true), 8);
global.document = savedDocument;
for (const random of [() => 0, () => 1]) {
  const timing = new TimeManager({ random });
  timing.beginTurn(initial);
  for (const clock of [0, 0.1, 1, 8, 15, 30, 120, 180]) {
    for (const isBook of [true, false]) {
      const seconds = timing.plan({ ...defaults, remainingSeconds: clock, isBook }).seconds;
      assert.ok(seconds >= 0 && seconds <= clock);
      if (clock <= 8) assert.ok(seconds <= 0.6);
    }
  }
}
// A sudden clock correction must bring an already running deadline forward.
(async () => {
  let clock = 180;
  now = 1000;
  manager.startTimer(10, value => { tick = value; }, () => ready++, { startedAt: now, readRemainingSeconds: () => clock });
  clock = 1; now = 2000;
  await new Promise(resolve => setTimeout(resolve, 70));
  assert.ok(Number(tick.remainingSec) <= 0.1);
  now = 2100;
  await new Promise(resolve => setTimeout(resolve, 70));
  assert.equal(manager.isReady, true);
  assert.equal(manager.intervalId, null);
  console.log('PASS timing: budgets, move classification, stable turn start, elapsed search, own clocks, time trouble and deadline correction');
})().catch(error => { manager.stopTimer(); console.error(error); process.exitCode = 1; });


