/* One UCI search at a time. A stopped search must acknowledge bestmove before reuse. */
(function (root) {
  class UciEngine {
    constructor(url, options = {}) {
      this.url = url;
      this.WorkerClass = options.WorkerClass || root.Worker;
      this.workerWrapperUrl = options.workerWrapperUrl;
      this.worker = null;
      this.ready = false;
      this.queue = [];
      this.job = null;
      this.timer = null;
      this.engineName = null;
      this.nnueNetwork = null;
      this.uciOptions = {};
    }
    analyze(options) {
      return new Promise(resolve => {
        this.queue.push({ options, resolve, lines: {} });
        this.pump();
      });
    }
    pump() {
      if (!this.worker) {
        try {
          let workerUrl = this.url;
          if (this.workerWrapperUrl) {
            const wrapper = new URL(this.workerWrapperUrl);
            wrapper.searchParams.set('engine', this.url);
            // Stockfish.js uses location.hash to locate WASM when loaded via importScripts.
            wrapper.hash = encodeURIComponent(this.url.replace(/\.js$/, '.wasm'));
            workerUrl = wrapper.href;
          }
          const worker = this.worker = new this.WorkerClass(workerUrl);
          worker.onmessage = event => {
            if (worker !== this.worker) return;
            if (event.data?.type === 'sensei-engine-error') this.fail(String(event.data.error));
            else this.onLine(String(event.data).trim());
          };
          worker.onerror = event => {
            if (worker === this.worker) this.fail('Stockfish worker failed [' + this.url + ']' + (event?.message ? ': ' + event.message : '') +
              (event?.filename ? ' (' + event.filename + ':' + (event.lineno || 0) + ')' : ''));
          };
          this.timer = setTimeout(() => this.fail('Stockfish initialization timed out'), 15000);
          worker.postMessage('uci');
        } catch (err) { this.fail(err.message); }
        return;
      }
      if (!this.ready || this.job || !this.queue.length) return;
      this.job = this.queue.shift();
      this.job.startedAt = Date.now();
      const o = this.job.options;
      if (o.newGame) this.worker.postMessage('ucinewgame');
      const requestedElo = o.ratingElo === null || o.ratingElo === undefined ? NaN : Number(o.ratingElo);
      const eloOption = this.uciOptions.UCI_Elo;
      const ratingSupported = !!(eloOption && this.uciOptions.UCI_LimitStrength);
      if (Number.isFinite(requestedElo) && !ratingSupported) {
        const job = this.job;
        this.job = null;
        job.resolve({ success: false, lines: [], error: 'Этот движок не поддерживает ограничение ELO', ratingSupported: false });
        this.pump();
        return;
      }
      // Reset on EVERY request, including accuracy and root-move searches.
      if (this.uciOptions.UCI_LimitStrength) this.worker.postMessage('setoption name UCI_LimitStrength value ' + (Number.isFinite(requestedElo) ? 'true' : 'false'));
      if (this.uciOptions['Skill Level']) this.worker.postMessage('setoption name Skill Level value 20');
      if (Number.isFinite(requestedElo)) {
        this.job.appliedElo = Math.round(Math.max(eloOption.min, Math.min(eloOption.max, requestedElo)));
        this.worker.postMessage('setoption name UCI_Elo value ' + this.job.appliedElo);
      }
      const depth = Math.min(24, Math.max(1, Number(o.depth) || 10));
      const movetime = Math.min(3000, Math.max(50, Number(o.movetime) || 600));
      this.worker.postMessage('setoption name MultiPV value ' + Math.min(8, Math.max(1, Number(o.multipv) || 3)));
      this.worker.postMessage('position fen ' + o.fen);
      const roots = Array.isArray(o.searchmoves) ? o.searchmoves.filter(move => /^[a-h][1-8][a-h][1-8][qrbn]?$/.test(move)).slice(0, 8) : [];
      this.worker.postMessage(`go depth ${depth} movetime ${movetime}` + (roots.length ? ' searchmoves ' + roots.join(' ') : ''));
      this.timer = setTimeout(() => {
        if (!this.job) return;
        this.job.stopping = true;
        this.worker.postMessage('stop');
        this.timer = setTimeout(() => this.fail('Stockfish stop timed out'), 1500);
      }, movetime + 2500);
    }
    onLine(line) {
      const option = line.match(/^option name (.+?) type (\w+)(.*)$/);
      if (option) this.uciOptions[option[1]] = { type: option[2],
        min: Number(option[3].match(/\bmin (-?\d+)/)?.[1]), max: Number(option[3].match(/\bmax (-?\d+)/)?.[1]) };
      if (line.startsWith('id name ')) {
        this.engineName = line.slice(8);
        console.info('[Chess Sensei Engine]', this.engineName);
      }
      const network = line.match(/NNUE evaluation using (nn-[a-f0-9]+\.nnue)/);
      if (network && this.nnueNetwork !== network[1]) {
        this.nnueNetwork = network[1];
        console.info('[Chess Sensei Engine]', line);
      }
      if (line === 'uciok') {
        // Bundled single-thread build has fixed Threads/Hash; changing Threads
        // can deadlock its emulated threading runtime.
        this.worker.postMessage('isready');
        return;
      }
      if (line === 'readyok' && !this.ready) {
        clearTimeout(this.timer);
        this.ready = true;
        this.pump();
        return;
      }
      if (!this.job) return;
      if (line.startsWith('info ') && !/\b(?:lowerbound|upperbound)\b/.test(line)) {
        const pv = line.match(/\bpv\s+(.+)$/);
        const score = line.match(/\bscore\s+(cp|mate)\s+(-?\d+)/);
        if (pv && score) {
          const multipv = Number(line.match(/\bmultipv\s+(\d+)/)?.[1] || 1);
          const moves = pv[1].split(/\s+/);
          this.job.lines[multipv] = { multipv, depth: Number(line.match(/\bdepth\s+(\d+)/)?.[1] || 0),
            score: { unit: score[1], value: Number(score[2]) }, uci: moves[0], pv: moves };
        }
      }
      if (line.startsWith('bestmove ')) {
        clearTimeout(this.timer);
        const job = this.job;
        this.job = null;
        const lines = Object.values(job.lines).sort((a, b) => a.multipv - b.multipv);
        const bestmove = line.split(/\s+/)[1];
        job.resolve({ success: lines.length > 0 || /^[a-h][1-8][a-h][1-8][qrbn]?$/.test(bestmove), terminal: /bestmove (?:\(none\)|0000)/.test(line), lines, bestmove,
          appliedElo: job.appliedElo, ratingSupported: !!(this.uciOptions.UCI_Elo && this.uciOptions.UCI_LimitStrength),
          engineName: this.engineName, nnueNetwork: this.nnueNetwork, elapsedMs: Date.now() - job.startedAt });
        this.pump();
      }
    }
    fail(error) {
      clearTimeout(this.timer);
      if (this.worker) this.worker.terminate();
      this.worker = null;
      this.ready = false;
      this.uciOptions = {};
      const jobs = [this.job, ...this.queue].filter(Boolean);
      this.job = null;
      this.queue = [];
      jobs.forEach(job => job.resolve({ success: false, error, lines: [] }));
    }
    destroy() { this.fail('Engine closed'); }
  }
  root.UciEngine = UciEngine;
  if (typeof module !== 'undefined') module.exports = { UciEngine };
})(typeof globalThis !== 'undefined' ? globalThis : this);
