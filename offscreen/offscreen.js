const stockfishEngine = new BrowserEngine(chrome.runtime.getURL('offscreen/stockfish-nnue.js'), chrome.runtime.getURL('offscreen/stockfish.js'),
  { workerWrapperUrl: chrome.runtime.getURL('offscreen/engine_worker.js'), frameWorkerClass: FrameWorker });
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.target !== 'offscreen' || message.action !== 'ANALYZE_POSITION') return false;
  stockfishEngine.analyze(message).then(sendResponse).catch(error => {
    sendResponse({ success: false, error: error.message, lines: [] });
  });
  return true;
});
