/* Browser-generated input for Lichess, enabled only by an explicit optional grant. */
(function (root) {
  class LichessInput {
    constructor(api) { this.api = api; this.busy = new Set(); }
    async click(message, sender) {
      const api = this.api, tabId = sender.tab?.id;
      const allowedUrl = value => {
        try { const url = new URL(value); return url.protocol === 'https:' && url.hostname === 'lichess.org'; }
        catch (_) { return false; }
      };
      if (sender.id !== api.runtime.id || sender.frameId !== 0 || !Number.isInteger(tabId) || !allowedUrl(sender.url)) {
        throw new Error('Ввод разрешён только основной вкладке Lichess.');
      }
      if (![message.x, message.y].every(value => Number.isFinite(value) && value >= 0 && value <= 10000)) {
        throw new Error('Некорректные координаты доски.');
      }
      const enabled = (await api.storage.sync.get('lichessInputEnabled')).lichessInputEnabled;
      if (!enabled || !await api.permissions.contains({ permissions: ['debugger'] })) {
        throw new Error('В настройках расширения разрешите автоходы Lichess.');
      }
      if (this.busy.has(tabId)) throw new Error('Предыдущий ввод ещё не завершён.');
      this.busy.add(tabId);
      const target = { tabId };
      let attached = false;
      let pressed = false;
      const base = { x: message.x, y: message.y, button: 'left', clickCount: 1 };
      try {
        const tab = await api.tabs.get(tabId);
        if (!allowedUrl(tab.url) || tab.url !== sender.url) throw new Error('Страница изменилась: ход отменён.');
        await api.debugger.attach(target, '1.3');
        attached = true;
        await api.debugger.sendCommand(target, 'Input.dispatchMouseEvent', { ...base, type: 'mouseMoved', buttons: 0 });
        await api.debugger.sendCommand(target, 'Input.dispatchMouseEvent', { ...base, type: 'mousePressed', buttons: 1 });
        pressed = true;
        await api.debugger.sendCommand(target, 'Input.dispatchMouseEvent', { ...base, type: 'mouseReleased', buttons: 0 });
        pressed = false;
        return { success: true };
      } catch (error) {
        throw new Error('Не удалось нажать на доску Lichess: ' + error.message);
      } finally {
        if (pressed) {
          try { await api.debugger.sendCommand(target, 'Input.dispatchMouseEvent', { ...base, type: 'mouseReleased', buttons: 0 }); } catch (_) {}
        }
        if (attached) { try { await api.debugger.detach(target); } catch (_) {} }
        this.busy.delete(tabId);
      }
    }
  }
  root.LichessInput = LichessInput;
  if (typeof module !== 'undefined') module.exports = { LichessInput };
})(typeof globalThis !== 'undefined' ? globalThis : this);
