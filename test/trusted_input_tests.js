const assert = require('node:assert/strict');
const { LichessInput } = require('../background/trusted_input.js');
async function main() {
  const calls = [];
  let granted = true, enabled = true, url = 'https://lichess.org/abcdefgh';
  const api = {
    runtime: { id: 'extension' },
    storage: { sync: { get: async () => ({ lichessInputEnabled: enabled }) } },
    permissions: { contains: async () => granted },
    tabs: { get: async () => ({ url }) },
    debugger: {
      attach: async target => calls.push(['attach', target.tabId]),
      sendCommand: async (target, method, params) => calls.push([method, params]),
      detach: async target => calls.push(['detach', target.tabId])
    }
  };
  const input = new LichessInput(api);
  const sender = { id: 'extension', frameId: 0, tab: { id: 7 }, url };
  const click = { x: 130, y: 250 };
  for (const invalid of [{ ...sender, url: 'https://lichess.org.evil.example/' }, { ...sender, frameId: 1 }, { ...sender, id: 'other' }]) {
    await assert.rejects(input.click(click, invalid));
  }
  await assert.rejects(input.click({ x: NaN, y: 0 }, sender));
  granted = false; await assert.rejects(input.click(click, sender), /настройках/);
  granted = true; enabled = false; await assert.rejects(input.click(click, sender), /настройках/);
  enabled = true; url = 'https://lichess.org/changed'; await assert.rejects(input.click(click, sender), /изменилась/);
  assert.equal(calls.length, 0);
  url = sender.url;
  assert.equal((await input.click(click, sender)).success, true);
  assert.deepEqual(calls.map(call => call[0]), ['attach', 'Input.dispatchMouseEvent', 'Input.dispatchMouseEvent', 'Input.dispatchMouseEvent', 'detach']);
  assert.deepEqual(calls.slice(1, 4).map(call => call[1].type), ['mouseMoved', 'mousePressed', 'mouseReleased']);
  assert.ok(calls.slice(1, 4).every(call => call[1].x === 130 && call[1].y === 250));
  calls.length = 0;
  api.debugger.sendCommand = async () => { throw new Error('transport failed'); };
  await assert.rejects(input.click(click, sender), /transport failed/);
  assert.deepEqual(calls.map(call => call[0]), ['attach', 'detach']);
  assert.equal(input.busy.size, 0);
  calls.length = 0;
  let releaseAttempts = 0;
  api.debugger.sendCommand = async (target, method, params) => {
    calls.push([method, params]);
    if (params.type === 'mouseReleased' && ++releaseAttempts === 1) throw new Error('release failed');
  };
  await assert.rejects(input.click(click, sender), /release failed/);
  assert.equal(releaseAttempts, 2);
  assert.equal(calls.at(-1)[0], 'detach');
  calls.length = 0;
  api.debugger.attach = async () => { throw new Error('another debugger'); };
  await assert.rejects(input.click(click, sender), /another debugger/);
  assert.equal(calls.length, 0); // Never detach a debugger that we did not attach.
  console.log('PASS trusted input: domain/frame/permission guards, navigation cancellation, browser input and failure cleanup');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
