/**
 * service_worker.js - Фоновый сервис расширения Chess Sensei (Manifest V3).
 * Управляет Offscreen Document, защищен от сбоев API и гарантирует работу на всех версиях Chrome.
 */

let creatingOffscreen = null;
let recoveringOffscreen = null;
let offscreenGeneration = 0;
if (typeof importScripts === 'function') importScripts('../engine/strength_adapter.js', 'stats_store.js');
const humanStatsStore = typeof StatsStore !== 'undefined' ? new StatsStore(chrome.storage.local) : null;

async function recoverOffscreen(failedGeneration) {
  if (recoveringOffscreen) return recoveringOffscreen;
  if (failedGeneration !== offscreenGeneration || !chrome.offscreen?.closeDocument) return;
  recoveringOffscreen = (async () => {
    if (creatingOffscreen) await creatingOffscreen;
    if (await hasOffscreenDocument()) await chrome.offscreen.closeDocument();
    await setupOffscreenDocument();
    offscreenGeneration++;
  })();
  try { await recoveringOffscreen; } finally { recoveringOffscreen = null; }
}

async function hasOffscreenDocument() {
  if (chrome.runtime.getContexts) {
    try {
      const contexts = await chrome.runtime.getContexts({
        contextTypes: ['OFFSCREEN_DOCUMENT']
      });
      return contexts && contexts.length > 0;
    } catch (e) {
      // Игнорируем ошибку getContexts
    }
  }
  if (chrome.offscreen && chrome.offscreen.hasDocument) {
    try {
      return await chrome.offscreen.hasDocument();
    } catch (e) {}
  }
  return false;
}

async function setupOffscreenDocument() {
  if (!chrome.offscreen) throw new Error('Offscreen API unavailable');
  if (creatingOffscreen) return creatingOffscreen;
  creatingOffscreen = (async () => {
    if (await hasOffscreenDocument()) return;
    try {
    await chrome.offscreen.createDocument({
      url: 'offscreen/offscreen.html',
      reasons: ['WORKERS'],
      justification: 'Run Stockfish chess engine'
    });
    console.log('[ServiceWorker] Offscreen Document успешно создан!');
  } catch (err) {
    if (!err.message || !err.message.includes('Only a single offscreen document may be created')) {
      throw err;
    }
    }
  })();
  try { await creatingOffscreen; } finally { creatingOffscreen = null; }
}

// Запуск при инициализации
const warmup = () => setupOffscreenDocument().catch(err => console.warn(err.message));
chrome.runtime.onInstalled.addListener(warmup);
chrome.runtime.onStartup.addListener(warmup);
warmup();

// Слушатель сообщений
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action?.startsWith('HUMAN_') && humanStatsStore) {
    humanStatsStore.handle(message, sender).then(sendResponse).catch(error => sendResponse({ success: false, error: error.message }));
    return true;
  }
  if (message.action === 'ENSURE_OFFSCREEN') {
    setupOffscreenDocument().then(() => sendResponse({ ready: true })).catch(err => sendResponse({ ready: false, error: err.message }));
    return true;
  }

  if (message.action === 'ANALYZE_POSITION' && message.target !== 'offscreen') {
    handleAnalyze(message).then(sendResponse).catch(err => {
      sendResponse({ success: false, error: err.message, lines: [] });
    });
    return true; // Держим канал открытым
  }
});

async function handleAnalyze(message) {
  // Native engine is optional; disabled means no requests to the bridge.
  let wasFallback = false;
  if (message.useLocalBridge) {
  try {
    const bridgeUrl = message.bridgeUrl || 'http://127.0.0.1:5000';
    const bridgeRes = await fetch(`${bridgeUrl}/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fen: message.fen,
        depth: message.depth || 12,
        multipv: message.multipv || 3,
        movetime: message.movetime || 600,
        searchmoves: message.searchmoves || [],
        ratingElo: message.ratingElo,
        newGame: message.newGame === true
      }),
      signal: AbortSignal.timeout(6000)
    });
    if (bridgeRes.ok) {
      const data = await bridgeRes.json();
      if (data && data.lines && data.lines.length > 0 &&
          (message.ratingElo == null || (data.ratingSupported && data.appliedElo === message.ratingElo))) {
        console.log('[ServiceWorker] 🚀 Ход мгновенно рассчитан через Native Stockfish (127.0.0.1:5000)!');
        return { ...data, success: true, isLocalNative: true, engineSource: 'native', engineName: data.engineName || 'Native Stockfish' };
      }
    }
  } catch (e) {
    console.warn('[ServiceWorker] Bridge unavailable:', e.message);
  }
    wasFallback = true;
  }

  // 2. Убеждаемся, что offscreen запущен
  if (recoveringOffscreen) await recoveringOffscreen;
  await setupOffscreenDocument();
  const searchGeneration = offscreenGeneration;

  const sendToOffscreen = () => {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(
        {
          ...message,
          target: 'offscreen'
        },
        (response) => {
          if (chrome.runtime.lastError) {
            console.warn('[ServiceWorker] Offscreen notice:', chrome.runtime.lastError.message);
            resolve(null);
          } else {
            resolve(response);
          }
        }
      );
    });
  };

  let resp = await sendToOffscreen();
  if (!resp) {
    // Если Offscreen только инициализировался, даем 250 мс и повторяем
    await new Promise((r) => setTimeout(r, 250));
    resp = await sendToOffscreen();
  }
  if (!resp || resp.success === false) {
    // Both workers can die together after a renderer/process failure. A fresh document
    // resets BrowserEngine's disabled NNUE flag and recreates both workers, once.
    try {
      await recoverOffscreen(searchGeneration);
      resp = await sendToOffscreen();
    } catch (error) { resp = { success: false, error: error.message, lines: [] }; }
  }

  return {
    ...(resp || { success: false, error: 'Offscreen engine did not respond', lines: [] }),
    fallbackToWasm: wasFallback
  };
}
