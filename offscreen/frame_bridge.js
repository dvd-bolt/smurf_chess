/* The unchanged asm.js engine speaks the Worker API; provide it inside this isolated frame. */
const nativePostMessage = window.postMessage.bind(window);
window.postMessage = function (line, targetOrigin, transfer) {
  if (arguments.length > 1) return nativePostMessage(line, targetOrigin, transfer);
  parent.postMessage({ source: 'sensei-frame', line }, '*');
};
// Offscreen frames are invisible: their search loop must not depend on visible-frame RAF.
window.requestAnimationFrame = callback => setTimeout(() => callback(performance.now()), 16);
window.cancelAnimationFrame = id => clearTimeout(id);
window.addEventListener('error', event => {
  parent.postMessage({ source: 'sensei-frame', error: event.message || 'Stockfish JS frame failed' }, '*');
});
window.addEventListener('unhandledrejection', event => {
  parent.postMessage({ source: 'sensei-frame', error: event.reason?.message || String(event.reason) }, '*');
});
