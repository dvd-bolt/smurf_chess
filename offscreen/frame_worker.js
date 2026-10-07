/* Worker-compatible UCI transport for browsers where worker processes cannot start. */
(function (root) {
  class FrameWorker {
    constructor() {
      this.closed = false;
      this.loaded = false;
      this.pending = [];
      this.frame = document.createElement('iframe');
      this.frame.hidden = true;
      this.frame.src = chrome.runtime.getURL('offscreen/js_engine_frame.html');
      this.listener = event => {
        if (this.closed || event.source !== this.frame.contentWindow || event.data?.source !== 'sensei-frame') return;
        if (event.data.error) this.onerror?.({ message: event.data.error });
        else this.onmessage?.({ data: event.data.line });
      };
      window.addEventListener('message', this.listener);
      this.frame.addEventListener('load', () => {
        if (this.closed) return;
        this.loaded = true;
        for (const command of this.pending) this.postMessage(command);
        this.pending = [];
      });
      document.body.appendChild(this.frame);
    }
    postMessage(command) {
      if (this.closed) return;
      if (!this.loaded) this.pending.push(command);
      else this.frame.contentWindow.postMessage(command, '*');
    }
    terminate() {
      this.closed = true;
      this.pending = [];
      window.removeEventListener('message', this.listener);
      this.frame.remove();
    }
  }
  root.FrameWorker = FrameWorker;
})(globalThis);
