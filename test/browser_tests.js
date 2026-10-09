/* Run with Playwright available on NODE_PATH; uses Edge or BROWSER_PATH. */
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const trustedInputOnly = process.argv.includes('--lichess-input');
const launchOptions = { headless: true, ...(process.env.BROWSER_PATH ? { executablePath: process.env.BROWSER_PATH } : { channel: 'msedge' }) };
async function waitForAsync(read, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Async state did not become ready');
}

async function boardChecks(page, extension = false) {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error' || message.type() === 'warning') console.log('Browser:', message.text()); });
  await page.waitForSelector('#chess-sensei-hud');
  await page.waitForFunction(() => document.querySelector('.cs-mp-move'));
  assert.equal(await page.locator('#test-board .piece').count(), 32);
  const smoke = await page.evaluate(async () => {
    const controller = new EngineController();
    const response = await controller.analyzePosition(document.querySelector('#test-board').dataset.fen, { analysisOnly: true });
    controller.localEngine?.destroy();
    return { unit: response?.score?.unit, source: response?.engineSource, network: response?.nnueNetwork, elapsedMs: response?.elapsedMs };
  });
  assert.equal(smoke.unit, 'cp');
  assert.equal(smoke.source, 'nnue');
  assert.equal(smoke.network, 'nn-61e7af4bb97d.nnue');
  console.log('NNUE real search:', smoke.elapsedMs, 'ms');
  if (!extension) {
    const fallback = await page.evaluate(async () => {
      const engine = new BrowserEngine(new URL('../offscreen/missing-nnue.js', document.baseURI).href, new URL('../engine/stockfish.js', document.baseURI).href);
      const response = await engine.analyze({ fen: document.querySelector('#test-board').dataset.fen, depth: 6, movetime: 100, multipv: 1 });
      engine.destroy();
      return { success: response.success, source: response.engineSource, reason: response.fallbackReason };
    });
    assert.equal(fallback.success, true);
    assert.equal(fallback.source, 'js');
    assert.ok(fallback.reason);
    console.log('PASS browser: failed WASM worker falls back to real JS engine');
    const unsupported = await page.evaluate(async () => {
      const engine = new BrowserEngine('unused', new URL('../engine/stockfish.js', document.baseURI).href, { wasmSupported: false });
      const response = await engine.analyze({ fen: document.querySelector('#test-board').dataset.fen, depth: 6, movetime: 100, multipv: 1 });
      engine.destroy();
      return { success: response.success, source: response.engineSource };
    });
    assert.equal(unsupported.success, true); assert.equal(unsupported.source, 'js');
    const wrapped = await page.evaluate(async () => {
      const engine = new BrowserEngine(new URL('../offscreen/missing-engine.js', document.baseURI).href,
        new URL('../offscreen/stockfish.js', document.baseURI).href,
        { workerWrapperUrl: new URL('../offscreen/engine_worker.js', document.baseURI).href });
      const response = await engine.analyze({ fen: document.querySelector('#test-board').dataset.fen, depth: 6, movetime: 100 });
      engine.destroy();
      return { success: response.success, source: response.engineSource, reason: response.fallbackReason };
    });
    assert.equal(wrapped.success, true); assert.equal(wrapped.source, 'js');
    assert.match(wrapped.reason, /importScripts|missing-engine|failed|load/i);
    console.log('PASS browser: detailed worker startup error and wrapped classic JS fallback');
    console.log('PASS browser: WebAssembly unavailable uses real JS engine');
  }
  const initial = await page.locator('#test-board').getAttribute('data-fen');
  await page.locator('[data-row="6"][data-col="4"]').click();
  await page.locator('[data-row="3"][data-col="4"]').click(); // illegal e2-e5
  assert.equal(await page.locator('#test-board').getAttribute('data-fen'), initial);
  await page.locator('[data-row="6"][data-col="4"]').click();
  await page.locator('[data-row="4"][data-col="4"]').click();
  await page.waitForFunction(() => document.querySelector('#cs-rank-pill').textContent === 'Ход соперника');
  assert.match(await page.locator('#test-board').getAttribute('data-fen'), / b KQkq e3 0 1$/);
  await page.locator('[data-row="1"][data-col="4"]').click();
  await page.locator('[data-row="3"][data-col="4"]').click();
  await page.waitForFunction(() => document.querySelector('#cs-acc-val').textContent.startsWith('≈'), null, { timeout: 20000 });
  await page.waitForFunction(() => document.querySelector('.chess-sensei-overlay line'));
  await page.locator('#cs-btn-vis').click();
  assert.equal(await page.locator('.chess-sensei-overlay line').count(), 0);
  await page.locator('#cs-btn-vis').click();
  assert.ok(await page.locator('.chess-sensei-overlay line').count());
  await page.locator('#btn-flip').click();
  await page.waitForFunction(() => document.querySelector('#cs-rank-pill').textContent === 'Ход соперника');
  await page.locator('#cs-col-white').click();
  await page.waitForFunction(() => document.querySelector('.chess-sensei-overlay line'));
  await page.locator('.preset-btn').nth(1).click();
  await page.waitForFunction(() => document.querySelector('#cs-engine-badge').textContent.includes('NNUE') && document.querySelector('.cs-mp-move'), null, { timeout: 20000 });
  assert.ok(await page.locator('.chess-sensei-overlay line').count());
  await page.locator('#btn-new').click();
  await page.waitForFunction(() => document.querySelector('#cs-acc-val').textContent === '—');
  if (extension) {
    const popup = await page.context().newPage();
    const base = page.url().split('/test/')[0];
    await popup.goto(base + '/popup/popup.html');
    await popup.locator('#play-mode').selectOption('strict');
    await popup.locator('.toggle-row').filter({ has: popup.locator('#toggle-delay') }).click();
    assert.equal(await popup.locator('#toggle-delay').isChecked(), false);
    await page.waitForFunction(() => document.querySelector('#cs-timer-status').textContent === 'Таймер выключен');
    await popup.locator('#elo-range').fill('1800');
    await popup.locator('#elo-range').dispatchEvent('change');
    await page.waitForFunction(() => document.querySelector('.cs-elo-btn.active').dataset.elo === '1800');
    for (const persona of ['tal', 'karpov', 'capablanca', 'balanced']) {
      await popup.locator(`[data-persona="${persona}"]`).click();
      await page.waitForFunction(id => document.querySelector('#cs-persona-select').value === id, persona);
      assert.equal(await popup.locator(`[data-persona="${persona}"]`).getAttribute('aria-pressed'), 'true');
    }
    await page.locator('#cs-persona-select').selectOption('tal');
    await popup.waitForFunction(() => document.querySelector('[data-persona="tal"]').getAttribute('aria-pressed') === 'true');
    await page.waitForFunction(() => document.querySelector('#cs-engine-badge').textContent.includes('NNUE'));
    if (process.env.SCREENSHOT_DIR) {
      fs.mkdirSync(process.env.SCREENSHOT_DIR, { recursive: true });
      await popup.locator('.popup-container').screenshot({ path: path.join(process.env.SCREENSHOT_DIR, 'popup.png') });
      await page.locator('#chess-sensei-hud').screenshot({ path: path.join(process.env.SCREENSHOT_DIR, 'hud.png') });
    }
    await popup.close();
  } else {
    assert.equal(await page.locator('#cs-persona-select').isDisabled(), true);
    await page.waitForFunction(() => document.querySelector('#cs-engine-badge').textContent.includes('NNUE'));
  }
  await hotkeyChecks(page);
  if (extension) { await autoPlayChecks(page); await humanPlayChecks(page); }
  assert.deepEqual(errors, []);
  console.log('PASS browser:', extension ? 'unpacked extension, live settings, real Stockfish' : 'standalone, real Stockfish');
}

async function humanPlayChecks(page) {
  const popup = await page.context().newPage();
  await popup.goto(page.url().split('/test/')[0] + '/popup/popup.html');
  await popup.locator('#play-mode').selectOption('human');
  assert.equal(await popup.locator('#target-win-rate').inputValue(), '0.65');
  await popup.locator('#target-win-rate').selectOption('0.7');
  await popup.locator('#play-mode').selectOption('rated');
  assert.equal(await popup.locator('#target-win-rate').inputValue(), '0.55');
  await popup.locator('#play-mode').selectOption('human');
  assert.equal(await popup.locator('#target-win-rate').inputValue(), '0.7');
  await popup.locator('#target-win-rate').selectOption('0.65');
  await popup.locator('.toggle-row').filter({ has: popup.locator('#toggle-adaptive') }).click();
  await popup.locator('#elo-range').fill('1000');
  await popup.locator('#elo-range').dispatchEvent('change');
  await page.locator('#btn-new').click();
  await page.waitForFunction(() => document.querySelector('#cs-opening-text').textContent === 'Знакомый дебют');
  const getSession = () => page.evaluate(async () => {
    const state = (await chrome.storage.local.get('humanPlayState')).humanPlayState;
    return Object.values(state?.sessions || {}).find(item => item.sourceId === document.querySelector('#test-board').dataset.gameId);
  });
  const before = await waitForAsync(async () => {
    const stored = await getSession();
    const fen = await page.locator('#test-board').getAttribute('data-fen');
    const selected = (await page.locator('.cs-multipv-item.selected .cs-mp-move').textContent()).replace(/\s|→/g, '');
    return stored?.profileSnapshot.level === 1170 && stored.decisions[fen]?.strategy === 'human-book' && stored.decisions[fen]?.move === selected ? stored : null;
  });
  const move = await page.locator('.cs-multipv-item.selected .cs-mp-move').textContent();
  await page.reload();
  await page.waitForSelector('.cs-multipv-item.selected');
  assert.equal(await page.locator('.cs-multipv-item.selected .cs-mp-move').textContent(), move);
  assert.equal((await getSession()).id, before.id);
  await popup.locator('#elo-range').fill('1800');
  await popup.locator('#elo-range').dispatchEvent('change');
  await page.waitForFunction(() => document.querySelector('#cs-game-stats').textContent.includes('со следующей партии'));
  assert.equal((await getSession()).profileSnapshot.level, 1170);
  await page.locator('.preset-btn').nth(1).click();
  await page.waitForFunction(() => document.querySelectorAll('.cs-multipv-item').length >= 4 && document.querySelector('#cs-rank-pill').textContent === 'Человеческая игра');
  await waitForAsync(async () => (await getSession())?.profileSnapshot.level === 1970);
  await page.locator('.cs-multipv-item[aria-disabled="false"]').last().click();
  const selected = await page.locator('.cs-multipv-item.selected .cs-mp-move').textContent();
  await page.evaluate(() => document.activeElement.blur());
  await page.keyboard.press('Space');
  await page.waitForFunction(() => document.querySelector('#cs-rank-pill').textContent === 'Ход соперника');
  assert.ok(selected);
  const ending = '7k/6Q1/6K1/8/8/8/8/8 b - - 0 40';
  await page.locator('.preset-btn').first().evaluate((button, fen) => { button.dataset.fen = fen; button.click(); }, ending);
  await page.waitForFunction(() => document.querySelector('#cs-move-text').textContent === '—' && document.querySelector('#cs-multipv-list').textContent.includes('Результат сохранён'));
  await waitForAsync(() => page.evaluate(async () => {
    const state = (await chrome.storage.local.get('humanPlayState')).humanPlayState;
    return state?.history.some(item => item.sourceId === document.querySelector('#test-board').dataset.gameId && item.result === 'win');
  }));
  const gamesBefore = await page.evaluate(async () => (await chrome.storage.local.get('humanPlayState')).humanPlayState.history.length);
  await page.reload();
  await page.waitForSelector('#cs-game-stats');
  assert.equal(await page.evaluate(async () => (await chrome.storage.local.get('humanPlayState')).humanPlayState.history.length), gamesBefore);
  await popup.locator('#reset-human-stats').click();
  await popup.waitForFunction(() => document.querySelector('#human-statistics').textContent === 'Нет завершённых партий');
  await popup.locator('#play-mode').selectOption('strict');
  await popup.close();
  console.log('PASS browser: human mode, eight candidates, frozen profile, F5 decision memory, manual execution, confirmed results and reset');
}

async function ratedPlayChecks(page) {
  const popup = await page.context().newPage();
  await popup.goto(page.url().split('/test/')[0] + '/popup/popup.html');
  await popup.locator('#play-mode').selectOption('rated');
  await popup.locator('#elo-range').fill('1000');
  await popup.locator('#elo-range').dispatchEvent('change');
  await page.locator('#btn-new').click();
  const decision = () => page.evaluate(async () => {
    const state = (await chrome.storage.local.get('humanPlayState')).humanPlayState;
    const session = Object.values(state?.sessions || {}).find(item => item.sourceId === document.querySelector('#test-board').dataset.gameId);
    return session?.decisions[document.querySelector('#test-board').dataset.fen];
  });
  const first = await waitForAsync(async () => {
    const value = await decision();
    return value?.strategy === 'rated' && value.ratingProfile.nominalElo === 1000 ? value : null;
  });
  assert.equal(first.appliedElo, 1320);
  assert.equal(await popup.locator('[data-persona="tal"]').isDisabled(), true);
  assert.equal(await page.locator('#cs-persona-select').isDisabled(), true);
  assert.equal(await page.locator('.cs-multipv-item[aria-disabled="false"]').count(), 1);
  const displayed = first.lines.filter(line => line.rank <= 3 || line.uci === first.move);
  assert.equal(await page.locator('.chess-sensei-overlay line').count(), displayed.length);
  await page.reload();
  await page.waitForSelector('.cs-multipv-item.selected');
  assert.equal((await decision()).move, first.move);
  await popup.locator('#elo-range').fill('2000');
  await popup.locator('#elo-range').dispatchEvent('change');
  await page.waitForFunction(() => document.querySelector('#cs-game-stats').textContent.includes('со следующей партии'));
  assert.equal((await decision()).ratingProfile.nominalElo, 1000);
  await page.locator('#btn-new').click();
  const next = await waitForAsync(async () => {
    const value = await decision();
    return value?.strategy === 'rated' && value.ratingProfile.nominalElo === 2000 ? value : null;
  });
  assert.equal(next.appliedElo, 2035);
  await page.evaluate(() => { document.querySelector('#test-board').dataset.result = '1/2-1/2'; });
  await page.waitForFunction(() => document.querySelector('#cs-multipv-list').textContent.includes('Результат сохранён'));
  await waitForAsync(() => page.evaluate(async () => {
    const state = (await chrome.storage.local.get('humanPlayState')).humanPlayState;
    return Object.values(state?.groups || {}).some(group => group.summary.metric === 'score' && group.summary.scoreRate === 0.5);
  }));
  await popup.close();
  console.log('PASS browser: real rated ELO, migration, cached decision, new-game strength, disabled style overrides and half-point draws');
}

async function autoPlayChecks(page) {
  const popup = await page.context().newPage();
  await popup.goto(page.url().split('/test/')[0] + '/popup/popup.html');
  const toggle = id => popup.locator('.toggle-row').filter({ has: popup.locator(id) }).click();
  assert.equal(await popup.locator('#toggle-auto-play').isChecked(), false);
  await popup.locator('[data-persona="balanced"]').click();
  await page.locator('#btn-new').click();
  const initial = await page.locator('#test-board').getAttribute('data-fen');
  await toggle('#toggle-auto-play');
  await page.waitForFunction(() => document.querySelector('#test-board').dataset.fen.split(' ')[1] === 'b');
  const afterFirst = await page.locator('#test-board').getAttribute('data-fen');
  await page.waitForTimeout(350);
  assert.equal(await page.locator('#test-board').getAttribute('data-fen'), afterFirst);
  const opponentFen = await page.evaluate(() => {
    const board = document.querySelector('#test-board');
    const game = new ChessRules(board.dataset.fen);
    const move = game.moves({ verbose: true })[0];
    const uci = move.from + move.to + (move.promotion || '');
    board.dispatchEvent(new CustomEvent('chess-sensei-play', { detail: JSON.stringify({ uci, fen: game.fen() }) }));
    return board.dataset.fen;
  });
  await page.waitForFunction(fen => {
    const current = document.querySelector('#test-board').dataset.fen;
    return current !== fen && current.split(' ')[1] === 'b';
  }, opponentFen);
  await toggle('#toggle-auto-play');
  await toggle('#toggle-delay'); // Human delay back on.
  // A normal middlegame budget leaves enough time to test cancellation even on a busy CI machine.
  await page.locator('.preset-btn').nth(1).click();
  const cancelledFen = await page.locator('#test-board').getAttribute('data-fen');
  await toggle('#toggle-auto-play');
  await page.waitForFunction(() => document.querySelector('#cs-move-action').textContent === 'Автоходы включены' && document.querySelector('.cs-multipv-item.selected'));
  assert.equal(await page.locator('#test-board').getAttribute('data-fen'), cancelledFen);
  await toggle('#toggle-auto-play'); // Cancel a pending timer.
  await page.waitForFunction(() => document.querySelector('#cs-move-action').textContent.startsWith('Пробел'));
  await page.waitForTimeout(2800);
  assert.equal(await page.locator('#test-board').getAttribute('data-fen'), cancelledFen);
  // Select while autoplay is off: this turn has already spent its entire think budget.
  await page.locator('.cs-multipv-item[aria-disabled="false"]').last().click();
  const expected = await page.evaluate(() => {
    const [from, to] = document.querySelector('.cs-multipv-item.selected .cs-mp-move').textContent.trim().split(' → ');
    const game = new ChessRules(document.querySelector('#test-board').dataset.fen); game.move({ from, to }); return game.fen();
  });
  await toggle('#toggle-auto-play');
  await page.waitForFunction(fen => document.querySelector('#test-board').dataset.fen === fen, expected);
  await popup.reload();
  await popup.waitForFunction(() => document.querySelector('#toggle-auto-play').checked);
  await page.reload();
  await page.waitForFunction(() => document.querySelector('#test-board').dataset.fen.split(' ')[1] === 'b');
  await toggle('#toggle-auto-play');
  await page.locator('#btn-new').click();
  await page.waitForTimeout(2800);
  assert.equal(await page.locator('#test-board').getAttribute('data-fen'), initial);
  await toggle('#toggle-delay');
  await page.evaluate(() => {
    window.rejectedAutoMoves = 0;
    window.rejectAutoMove = event => { window.rejectedAutoMoves++; event.stopImmediatePropagation(); };
    document.querySelector('#test-board').addEventListener('chess-sensei-play', window.rejectAutoMove, true);
  });
  await toggle('#toggle-auto-play');
  await page.waitForFunction(() => document.querySelector('#cs-move-action').textContent.includes('Доска не приняла ход'));
  await page.waitForTimeout(500);
  assert.equal(await page.evaluate(() => window.rejectedAutoMoves), 1);
  assert.equal(await page.locator('#test-board').getAttribute('data-fen'), initial);
  await toggle('#toggle-auto-play');
  await page.evaluate(() => document.querySelector('#test-board').removeEventListener('chess-sensei-play', window.rejectAutoMove, true));
  await popup.close();
  console.log('PASS browser: autoplay immediate, repeated own turns, opponent guard, delayed selected move, cancellation, saved switch, reload');
}

async function hotkeyChecks(page) {
  await page.locator('#cs-col-white').click();
  await page.locator('#btn-new').click();
  await page.waitForSelector('.cs-multipv-item.selected');
  const before = await page.locator('#test-board').getAttribute('data-fen');
  await page.locator('#fen-input').focus();
  await page.keyboard.press('Space');
  assert.equal(await page.locator('#test-board').getAttribute('data-fen'), before);
  await page.evaluate(() => {
    document.activeElement.blur();
    for (const options of [{ repeat: true }, { ctrlKey: true }, { altKey: true }, { isComposing: true }]) {
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', code: 'Space', bubbles: true, ...options }));
    }
  });
  assert.equal(await page.locator('#test-board').getAttribute('data-fen'), before);
  await page.locator('.cs-multipv-item[aria-disabled="false"]').last().click();
  const expected = await page.evaluate(() => {
    const [from, to] = document.querySelector('.cs-multipv-item.selected .cs-mp-move').textContent.trim().split(' → ');
    const game = new ChessRules(document.querySelector('#test-board').dataset.fen);
    game.move({ from, to });
    document.querySelector('.cs-multipv-item.selected').focus();
    return game.fen();
  });
  await page.keyboard.press('Space');
  await page.waitForFunction(fen => document.querySelector('#test-board').dataset.fen === fen, expected);
  await page.keyboard.press('Space');
  assert.equal(await page.locator('#test-board').getAttribute('data-fen'), expected);

  // Special moves and stale/illegal requests use the same execution path as the shortcut.
  for (const [fen, uci] of [
    ['r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1', 'e1g1'],
    ['4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 2', 'e5d6'],
    ['4k3/P7/8/8/8/8/8/4K3 w - - 0 1', 'a7a8n']
  ]) {
    await page.locator('.preset-btn').first().evaluate((button, value) => { button.dataset.fen = value; button.click(); }, fen);
    const result = await page.evaluate(async ({ fen, uci }) => {
      const detector = new BoardDetector(); detector.boardElement = detector.findBoard();
      const executor = new MoveExecutor(detector);
      detector.userColorOverride = 'b';
      const opponent = await executor.execute(uci, fen);
      detector.userColorOverride = 'w';
      const stale = await executor.execute(uci, fen.replace(' 0 ', ' 1 '));
      const illegal = await executor.execute('e1e8', fen);
      const game = new ChessRules(fen); game.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
      const results = await Promise.all([executor.execute(uci, fen), executor.execute(uci, fen)]);
      return { opponent, stale, illegal, results, actual: detector.getCurrentFen(), expected: game.fen() };
    }, { fen, uci });
    assert.equal(result.opponent, false); assert.equal(result.stale, false); assert.equal(result.illegal, false);
    assert.deepEqual(result.results, [true, false]); assert.equal(result.actual, result.expected);
  }
  // Exercise square-center mouse/pointer interaction in both orientations.
  for (let orientation = 0; orientation < 2; orientation++) {
    await page.locator('#btn-new').click();
    await page.locator('#btn-flip').click();
    const pointer = await page.evaluate(async () => {
      const detector = new BoardDetector(); detector.boardElement = detector.findBoard(); detector.siteType = 'chesscom';
      detector.userColorOverride = 'w';
      return new MoveExecutor(detector).execute('e2e4', detector.getCurrentFen());
    });
    assert.equal(pointer, true);
    assert.match(await page.locator('#test-board').getAttribute('data-fen'), / b KQkq e3 0 1$/);
  }
  console.log('PASS browser: Space plays selected move; input/modifiers/repeats guarded; stale moves, castling, en passant, underpromotion, flipped pointer clicks');
}

async function lichessChecks(browser) {
  const page = await browser.newPage();
  await page.setContent('<div class="cg-wrap orientation-black"><cg-board style="display:block;position:relative;width:400px;height:400px"></cg-board></div><div class="rclock-bottom running"><span class="time">3:00</span></div>');
  for (const file of ['vendor/chess.js', 'engine/position_state.js', 'content/board_detector.js', 'engine/game_session.js', 'content/game_context.js', 'content/visual_overlay.js', 'content/time_manager.js', 'content/move_executor.js']) {
    await page.addScriptTag({ path: path.join(root, file) });
  }
  const result = await page.evaluate(async () => {
    const game = new ChessRules(); game.move('e4');
    const board = document.querySelector('cg-board');
    board.dataset.fen = game.fen();
    const names = { p: 'pawn', n: 'knight', b: 'bishop', r: 'rook', q: 'queen', k: 'king' };
    const render = () => {
      board.querySelectorAll('piece').forEach(piece => piece.remove());
      board.dataset.fen = game.fen();
      game.board().forEach((rank, r) => rank.forEach((piece, c) => {
        if (!piece) return;
        const el = document.createElement('piece');
        el.className = `${piece.color === 'w' ? 'white' : 'black'} ${names[piece.type]}`;
        el.style.transform = `translate(${(7-c)*50}px, ${(7-r)*50}px)`;
        board.appendChild(el);
      }));
    };
    render();
    const detector = new BoardDetector(); detector.boardElement = detector.findBoard();
    const fen = detector.getCurrentFen();
    const overlay = new VisualOverlay();
    overlay.renderMultiMoves([{ uci: 'e2e4', multipv: 1 }], 'e2e4', { isFlipped: detector.isFlipped() });
    const line = document.querySelector('.chess-sensei-overlay line');
    const clock = new TimeManager().readClockFromDom('black', true);
    const expected = game.fen();
    let from = null;
    board.addEventListener('mousedown', event => {
      const rect = board.getBoundingClientRect();
      const col = 7 - Math.floor((event.clientX - rect.left) / 50);
      const row = Math.floor((event.clientY - rect.top) / 50);
      const square = String.fromCharCode(97 + col) + (row + 1);
      if (!from) from = square;
      else { game.move({ from, to: square }); from = null; render(); }
    });
    const played = await new MoveExecutor(detector).execute('e7e5', fen);
    return { fen, expected, played, after: game.fen(), color: detector.getUserColor(), x: line.getAttribute('x1'), y: line.getAttribute('y1'), clock };
  });
  assert.equal(result.fen, result.expected);
  assert.equal(result.color, 'b');
  assert.equal(result.x, '175'); assert.equal(result.y, '75');
  assert.equal(result.clock, 180);
  assert.equal(result.played, true);
  assert.match(result.after, / w KQkq e6 0 2$/);

  const history = await page.evaluate(() => {
    // Actual round layout observed on Lichess: generated tags, no data-fen,
    // and a draw offer embedded in the SAN node. Start after six plies (F5).
    document.body.innerHTML = '<main class="round__app"><div class="cg-wrap orientation-white"><cg-board style="display:block;width:400px;height:400px"></cg-board></div><i5d><bo3><button data-ply="0"></button><button data-ply="5"></button><button data-ply="-"></button><button data-ply="-"></button></bo3><app><qzm>1</qzm><z7yx>e4</z7yx><z7yx>e5</z7yx><qzm>2</qzm><z7yx>Nf3</z7yx><z7yx>Nc6</z7yx><qzm>3</qzm><z7yx>Bb5<draw>½?</draw></z7yx><z7yx class="a1t">a6</z7yx></app></i5d></main>';
    const board = document.querySelector('cg-board');
    const game = new ChessRules();
    const sans = ['e4', 'e5', 'Nf3', 'Nc6', 'Bb5', 'a6'];
    const names = { p: 'pawn', n: 'knight', b: 'bishop', r: 'rook', q: 'queen', k: 'king' };
    const render = () => {
      board.innerHTML = '';
      game.board().forEach((rank, r) => rank.forEach((piece, c) => {
        if (!piece) return;
        const el = document.createElement('piece');
        el.className = `${piece.color === 'w' ? 'white' : 'black'} ${names[piece.type]}`;
        el.style.transform = `translate(${c * 50}px, ${r * 50}px)`;
        board.appendChild(el);
      }));
    };
    sans.forEach(san => game.move(san)); render();
    const detector = new BoardDetector(); detector.boardElement = detector.findBoard();
    const recovered = detector.getCurrentFen();
    const latestIsHistory = GameContext.isHistory(board);
    const buttons = document.querySelectorAll('button[data-ply]');
    buttons[1].setAttribute('data-ply', '2'); buttons[2].setAttribute('data-ply', '4');
    game.undo(); game.undo(); game.undo(); render();
    const historical = new BoardDetector(); historical.boardElement = historical.findBoard();
    const historicalFen = historical.getCurrentFen();
    const viewingHistory = GameContext.isHistory(board);
    const parsed = historical.readMoves();
    board.querySelector('piece').classList.add('anim');
    let unavailable = 0;
    historical.onUnavailable = () => unavailable++;
    const duringAnimation = historical.getCurrentFen(); historical.triggerCheck();
    board.querySelector('piece').classList.remove('anim');
    const afterAnimation = historical.getCurrentFen();
    // Return to the latest board with a completely new detector, as on reload.
    ['Nc6', 'Bb5', 'a6'].forEach(san => game.move(san)); render();
    buttons[1].setAttribute('data-ply', '5'); buttons[2].setAttribute('data-ply', '-');
    const reloaded = new BoardDetector(); reloaded.boardElement = reloaded.findBoard();
    return { recovered, expected: game.fen(), latestIsHistory, viewingHistory,
      parsed, historicalFen, duringAnimation, unavailable, afterAnimation, reloaded: reloaded.getCurrentFen() };
  });
  assert.equal(history.recovered, history.expected);
  assert.equal(history.reloaded, history.expected);
  assert.equal(history.latestIsHistory, false); assert.equal(history.viewingHistory, true);
  assert.deepEqual(history.parsed, ['e4', 'e5', 'Nf3']);
  assert.match(history.historicalFen, / b KQkq - 1 2$/);
  assert.equal(history.duringAnimation, null); assert.equal(history.unavailable, 0);
  assert.equal(history.afterAnimation, history.historicalFen);
  await page.close();
  console.log('PASS browser: Lichess round history without data-fen, reload in midgame, draw annotations, history navigation, animation guard, orientation, arrows, clocks');
}

async function main() {
  const server = http.createServer((req, res) => {
    if (req.url === '/favicon.ico') { res.writeHead(204); return res.end(); }
    const file = path.resolve(root, '.' + decodeURIComponent(req.url.split('?')[0]));
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); return res.end(); }
    const mime = { '.html': 'text/html', '.js': 'application/javascript', '.wasm': 'application/wasm', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png' };
    res.setHeader('Content-Type', mime[path.extname(file)] || 'application/octet-stream');
    res.setHeader('Content-Security-Policy', "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'");
    if (req.url.includes('content-fixture=1') && file.endsWith('test_board.html')) {
      return res.end(fs.readFileSync(file, 'utf8').replace(/<script src="\.\.\/(?:engine|content)\/[^"\n]+"><\/script>/g, ''));
    }
    fs.createReadStream(file).pipe(res);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser, context;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'sensei-browser-'));
  try {
    let extensionRoot = root;
    if (trustedInputOnly) {
      // Give the disposable test extension permission at install time. Production
      // keeps it optional; no existing browser profile or permission is changed.
      extensionRoot = path.join(profile, 'extension');
      fs.mkdirSync(extensionRoot);
      for (const directory of ['background', 'content', 'engine', 'offscreen', 'popup', 'icons', 'vendor', 'test']) {
        fs.cpSync(path.join(root, directory), path.join(extensionRoot, directory), { recursive: true });
      }
      const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
      manifest.permissions.push('debugger'); manifest.optional_permissions = [];
      fs.writeFileSync(path.join(extensionRoot, 'manifest.json'), JSON.stringify(manifest));
    }
    if (!process.env.HUMAN_ONLY && !trustedInputOnly) {
    browser = await chromium.launch(launchOptions);
    const standalone = await browser.newPage({ viewport: { width: 1800, height: 1100 } });
    await standalone.goto(`http://127.0.0.1:${server.address().port}/test/test_board.html`);
    await boardChecks(standalone);
    await lichessChecks(browser);
    await browser.close(); browser = null;
    }
    context = await chromium.launchPersistentContext(profile, { ...launchOptions, viewport: { width: 1800, height: 1100 },
      args: [`--disable-extensions-except=${extensionRoot}`, `--load-extension=${extensionRoot}`] });
    let worker = context.serviceWorkers()[0];
    if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15000 });
    const extensionId = worker.url().split('/')[2];
    if (trustedInputOnly) {
      await worker.evaluate(() => chrome.storage.sync.set({ autoPlay: false, humanDelay: false,
        playMode: 'rated', lichessInputEnabled: false }));
      await context.route('https://lichess.org/**', async route => {
        const url = new URL(route.request().url());
        if (url.pathname === '/rules.js' || url.pathname === '/fixture.js') {
          return route.fulfill({ contentType: 'text/javascript', body: fs.readFileSync(path.join(root,
            url.pathname === '/rules.js' ? 'vendor/chess.js' : 'test/lichess_input_fixture.js'), 'utf8') });
        }
        return route.fulfill({ contentType: 'text/html', body: '<!doctype html><main class="round__app"><div class="cg-wrap orientation-white"><cg-board style="display:block;position:relative;width:400px;height:400px"></cg-board></div><i5d><bo3><button data-ply="0"></button><button data-ply="-"></button><button data-ply="-"></button><button data-ply="-"></button></bo3><app></app></i5d></main><style>piece {position:absolute;width:50px;height:50px;pointer-events:none}</style><script src="/rules.js"></script><script src="/fixture.js"></script>' });
      });
      const fixture = await context.newPage();
      await fixture.goto('https://lichess.org/analysis');
      await fixture.waitForSelector('.cs-multipv-item.selected');
      await fixture.evaluate(() => {
        document.querySelector('cg-board').dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: 30, clientY: 330 }));
        document.activeElement.blur();
      });
      assert.equal(await fixture.locator('cg-board').getAttribute('data-untrusted'), 'rejected');
      await fixture.keyboard.press('Space');
      await fixture.waitForFunction(() => document.querySelector('#cs-move-action').textContent.includes('настройках'));
      assert.equal(await fixture.locator('cg-board').getAttribute('data-played'), '0');
      await worker.evaluate(() => chrome.storage.sync.set({ lichessInputEnabled: true }));
      await fixture.waitForSelector('.cs-multipv-item.selected');
      await fixture.keyboard.press('Space');
      await fixture.waitForFunction(() => document.querySelector('cg-board').dataset.played === '1');
      await worker.evaluate(() => chrome.storage.sync.set({ autoPlay: true }));
      await fixture.evaluate(() => { fixtureGame.move(fixtureGame.moves()[0]); renderFixture(); });
      await fixture.waitForFunction(() => document.querySelector('cg-board').dataset.played === '3');
      assert.equal(await fixture.evaluate(() => typeof EngineController), 'undefined');
      console.log('PASS browser: Lichess rejects synthetic clicks; optional input stays disabled until enabled; real debugger input executes Space and subsequent autoplay from isolated content scripts');
      return;
    }
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/test/test_board.html`);
    await page.waitForSelector('#chess-sensei-hud');
    await worker.evaluate(() => chrome.storage.sync.set({ humanDelay: false, autoPlay: false }));
    await ratedPlayChecks(page);
    await worker.evaluate(() => chrome.storage.sync.set({ playMode: 'strict', humanDelay: true }));
    await page.locator('#btn-new').click();
    if (process.env.HUMAN_ONLY) {
      await worker.evaluate(() => chrome.storage.sync.set({ humanDelay: false, autoPlay: false }));
      await page.waitForSelector('#chess-sensei-hud');
      await humanPlayChecks(page);
      return;
    }
    await boardChecks(page, true);
    await page.addScriptTag({ url: `chrome-extension://${extensionId}/offscreen/frame_worker.js` });
    const frameFallback = await page.evaluate(async () => {
      class BlockedWorker { constructor() { throw new Error('Worker startup blocked (test)'); } }
      const engine = new BrowserEngine(chrome.runtime.getURL('offscreen/stockfish-nnue.js'), chrome.runtime.getURL('offscreen/stockfish.js'),
        { WorkerClass: BlockedWorker, frameWorkerClass: FrameWorker });
      const game = new ChessRules();
      const results = [];
      try {
        for (let turn = 0; turn < 8; turn++) {
          const response = await engine.analyze({ fen: game.fen(), depth: 6, movetime: 100, multipv: 3 });
          results.push({ success: response.success, source: response.engineSource, transport: response.engineTransport,
            move: response.lines[0]?.uci, error: response.error, name: response.engineName });
          const uci = response.lines[0]?.uci;
          if (!uci || !game.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] })) break;
        }
      } finally { engine.destroy(); }
      return results;
    });
    assert.equal(frameFallback.length, 8, JSON.stringify(frameFallback));
    assert.ok(frameFallback.every(result => result.success && result.transport === 'frame' && result.source === 'js'), JSON.stringify(frameFallback));
    console.log('PASS browser: real Stockfish frame plays 8 legal plies with both Worker transports blocked');
    const sitePage = await context.newPage();
    await sitePage.goto(`http://127.0.0.1:${server.address().port}/test/test_board.html?content-fixture=1`);
    await sitePage.waitForSelector('.cs-multipv-item.selected');
    // The page contains only chess.js and its board: coordinator runs in the REAL content-script world.
    assert.equal(await sitePage.evaluate(() => typeof EngineController), 'undefined');
    for (let turn = 0; turn < 12; turn++) {
      await sitePage.waitForFunction(() => document.querySelector('.cs-multipv-item.selected'));
      await sitePage.evaluate(() => document.activeElement.blur());
      await sitePage.keyboard.press('Space');
      await sitePage.waitForFunction(() => document.querySelector('#cs-rank-pill').textContent === 'Ход соперника');
      await sitePage.evaluate(() => {
        const board = document.querySelector('#test-board');
        const game = new ChessRules(board.dataset.fen);
        const move = game.moves({ verbose: true })[0];
        if (!move) throw new Error('Unexpected terminal fixture');
        board.dispatchEvent(new CustomEvent('chess-sensei-play', { detail: JSON.stringify({
          fen: game.fen(), uci: move.from + move.to + (move.promotion || '') }) }));
      });
    }
    await sitePage.waitForSelector('.cs-multipv-item.selected');
    assert.ok((await sitePage.locator('#cs-engine-badge').textContent()).includes('NNUE'));
    console.log('PASS browser: real isolated content script, 12 consecutive turns plus concurrent accuracy searches');
    await sitePage.close();
    await worker.evaluate(() => chrome.storage.sync.set({ playMode: 'human', adaptiveStrength: true, humanDelay: false, autoPlay: true, targetElo: 1400 }));
    const humanSite = await context.newPage();
    await humanSite.goto(`http://127.0.0.1:${server.address().port}/test/test_board.html?content-fixture=1`);
    assert.equal(await humanSite.evaluate(() => typeof EngineController), 'undefined');
    for (let turn = 0; turn < 8; turn++) {
      await humanSite.waitForFunction(() => document.querySelector('#test-board').dataset.fen.split(' ')[1] === 'b');
      const beforeReply = await humanSite.locator('#test-board').getAttribute('data-fen');
      await humanSite.evaluate(() => {
        const board = document.querySelector('#test-board');
        const game = new ChessRules(board.dataset.fen);
        const reply = game.moves({ verbose: true })[0];
        board.dispatchEvent(new CustomEvent('chess-sensei-play', { detail: JSON.stringify({
          fen: game.fen(), uci: reply.from + reply.to + (reply.promotion || '') }) }));
      });
      await humanSite.waitForFunction(fen => document.querySelector('#test-board').dataset.fen !== fen, beforeReply);
    }
    await humanSite.waitForFunction(() => document.querySelector('#test-board').dataset.fen.split(' ')[1] === 'b');
    const endedFen = await humanSite.locator('#test-board').getAttribute('data-fen');
    const sourceId = await humanSite.locator('#test-board').getAttribute('data-game-id');
    await humanSite.evaluate(() => { document.querySelector('#test-board').dataset.result = '1/2-1/2'; });
    await humanSite.waitForFunction(() => document.querySelector('#cs-multipv-list').textContent.includes('Результат сохранён'));
    await waitForAsync(() => worker.evaluate(async id => {
      const state = (await chrome.storage.local.get('humanPlayState')).humanPlayState;
      return state.history.some(game => game.sourceId === id && game.mode === 'human' && game.result === 'draw');
    }, sourceId));
    await humanSite.keyboard.press('Space');
    assert.equal(await humanSite.locator('#test-board').getAttribute('data-fen'), endedFen);
    await humanSite.close();
    console.log('PASS browser: isolated human autoplay, eight replies, explicit draw, durable result and post-game execution guard');
    const recovery = await worker.evaluate(async () => {
      const originalSend = chrome.runtime.sendMessage.bind(chrome.runtime);
      let injected = false;
      chrome.runtime.sendMessage = (message, callback) => {
        if (!injected && message.target === 'offscreen') {
          injected = true;
          callback({ success: false, error: 'Stockfish worker failed (test)', lines: [] });
        } else originalSend(message, callback);
      };
      try {
        return await handleAnalyze({ action: 'ANALYZE_POSITION', fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
          depth: 6, movetime: 100, multipv: 3 });
      } finally { chrome.runtime.sendMessage = originalSend; }
    });
    assert.equal(recovery.success, true);
    assert.equal(recovery.engineSource, 'nnue');
    assert.ok(recovery.lines.length);
    console.log('PASS browser: injected worker failure recreates real offscreen and resumes NNUE search');
  } finally {
    if (browser) await browser.close();
    if (context) await context.close();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(profile, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
