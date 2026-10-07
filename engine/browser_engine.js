/* Keep browser analyses local; degrade to the bundled JS engine on WASM failure. */
(function (root) {
  const Engine = root.UciEngine || (typeof require === 'function' ? require('./uci_engine.js').UciEngine : null);
  class BrowserEngine {
    constructor(nnueUrl, jsUrl, options = {}) {
      this.nnueUrl = nnueUrl;
      this.jsUrl = jsUrl;
      this.options = options;
      this.nnueAvailable = options.wasmSupported ?? (typeof root.WebAssembly === 'object');
      this.fallbackReason = this.nnueAvailable ? null : 'WebAssembly недоступен';
      this.primary = null;
      this.fallback = null;
      this.frame = null;
      this.closed = false;
    }
    async analyze(options) {
      if (this.closed) return { success: false, error: 'Engine closed', lines: [] };
      if (this.frame) return { ...await this.frame.analyze(options), engineSource: 'js', engineTransport: 'frame', fallbackReason: this.fallbackReason };
      if (this.nnueAvailable) {
        if (!this.primary) this.primary = new Engine(this.nnueUrl, this.options);
        const result = await this.primary.analyze(options);
        if (this.closed) return { success: false, error: 'Engine closed', lines: [] };
        if (result.success || result.terminal) return { ...result, engineSource: 'nnue', fallbackReason: null };
        this.nnueAvailable = false;
        this.fallbackReason = result.error || 'NNUE не вернул результат';
        this.primary.destroy();
      }
      if (!this.fallback) this.fallback = new Engine(this.jsUrl, this.options);
      const fallbackResult = await this.fallback.analyze(options);
      if (this.closed) return { success: false, error: 'Engine closed', lines: [] };
      if (!fallbackResult.success && !fallbackResult.terminal && this.options.frameWorkerClass) {
        this.fallbackReason = [this.fallbackReason, fallbackResult.error].filter(Boolean).join('; ');
        if (!this.frame) this.frame = new Engine(this.jsUrl, { ...this.options, WorkerClass: this.options.frameWorkerClass, workerWrapperUrl: null });
        return { ...await this.frame.analyze(options), engineSource: 'js', engineTransport: 'frame', fallbackReason: this.fallbackReason };
      }
      return { ...fallbackResult, engineSource: 'js', fallbackReason: this.fallbackReason };
    }
    destroy() { this.closed = true; this.primary?.destroy(); this.fallback?.destroy(); this.frame?.destroy(); }
  }
  root.BrowserEngine = BrowserEngine;
  if (typeof module !== 'undefined') module.exports = { BrowserEngine };
})(typeof globalThis !== 'undefined' ? globalThis : this);
