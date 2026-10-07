/* Real Stockfish 19 NNUE process behind the same Worker/UCI protocol as the browser. */
const { spawn } = require('node:child_process');
const path = require('node:path');
const assert = require('node:assert/strict');
const { UciEngine } = require('../engine/uci_engine.js');
const { START } = require('../engine/position_state.js');
const fs = require('node:fs');
const { createHash } = require('node:crypto');
class NodeWorker {
  constructor(file) {
    this.child = spawn(process.execPath, [file], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let pending = '';
    this.child.stdout.on('data', chunk => {
      pending += chunk.toString();
      const lines = pending.split(/\r?\n/); pending = lines.pop();
      lines.forEach(line => this.onmessage?.({ data: line }));
    });
    this.child.on('error', error => this.onerror?.(error));
    this.child.on('exit', code => { if (!this.closed) this.onerror?.(new Error('Engine exited: ' + code)); });
  }
  postMessage(command) { this.child.stdin.write(command + '\n'); }
  terminate() { this.closed = true; this.child.kill(); }
}
async function main() {
  const metadata = require('../vendor/stockfish-nnue-assets.json');
  for (const asset of metadata.assets) {
    const bytes = fs.readFileSync(path.resolve(__dirname, '..', asset.path));
    assert.equal(bytes.length, asset.bytes);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), asset.sha256);
  }
  const engine = new UciEngine(path.resolve(__dirname, '../offscreen/stockfish-nnue.js'), { WorkerClass: NodeWorker });
  try {
    const results = await Promise.all([
      engine.analyze({ fen: START, depth: 10, movetime: 200, multipv: 3 }),
      engine.analyze({ fen: 'r1bqk2r/pp2bppp/2n1pn2/2pp4/2PP4/2N1PN2/PP2BPPP/R1BQ1RK1 w kq - 0 8', depth: 10, movetime: 200, multipv: 3 })
    ]);
    for (const result of results) {
      assert.equal(result.success, true);
      assert.match(result.engineName, /Stockfish 19/);
      assert.equal(result.nnueNetwork, 'nn-61e7af4bb97d.nnue');
      assert.equal(result.lines.length, 3);
      assert.ok(result.lines.every(line => /^[a-h][1-8][a-h][1-8][qrbn]?$/.test(line.uci)));
    }
    console.log('PASS real NNUE Node/Worker:', results.map(result => ({ ms: result.elapsedMs, depth: result.lines[0].depth, move: result.lines[0].uci })));
  } finally { engine.destroy(); }
}
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { runNnueTests: main, NodeWorker };
