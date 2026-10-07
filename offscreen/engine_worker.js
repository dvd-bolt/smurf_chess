/* Report failures inside the worker; cross-origin Worker.onerror can hide their details. */
function reportEngineFailure(error) {
  self.postMessage({ type: 'sensei-engine-error', error: error?.message || String(error) });
}
self.addEventListener('error', event => {
  reportEngineFailure(event.error || event.message);
  event.preventDefault();
});
self.addEventListener('unhandledrejection', event => {
  reportEngineFailure(event.reason);
  event.preventDefault();
});
try {
  const script = new URL(self.location.href).searchParams.get('engine');
  if (!script || new URL(script).origin !== new URL(self.location.href).origin) throw new Error('Invalid engine script URL');
  importScripts(script);
} catch (error) { reportEngineFailure(error); }
