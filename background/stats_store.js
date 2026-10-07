/* One writer for all tabs; each update reads durable storage, so worker restarts are harmless. */
(function (root) {
  const Adapter = root.StrengthAdapter || (typeof require === 'function' ? require('../engine/strength_adapter.js') : null);
  class StatsStore {
    constructor(storage) { this.storage = storage; this.queue = Promise.resolve(); }
    run(action) {
      const job = this.queue.then(async () => {
        const stored = (await this.storage.get('humanPlayState')).humanPlayState;
        const state = stored?.schemaVersion === 1 && Array.isArray(stored.history) && stored.groups && stored.sessions && Array.isArray(stored.seen)
          ? stored : Adapter.empty();
        const result = await action(state);
        await this.storage.set({ humanPlayState: state });
        return result;
      });
      this.queue = job.catch(() => {});
      return job;
    }
    handle(message, sender = {}) {
      const key = `${sender.tab?.id ?? 'page'}:${String(message.pageKey || '').slice(0, 240)}`;
      return this.run(state => {
        if (message.action === 'HUMAN_STATE_GET') return { success: true, session: state.sessions[key] || null,
          summary: Adapter.current(state, message.group, message.target), groups: state.groups };
        if (message.action === 'HUMAN_SESSION_SAVE') {
          if (!message.session?.id || JSON.stringify(message.session).length > 500000) throw new Error('Invalid session');
          state.sessions[key] = { ...message.session, updatedAt: Date.now() };
          const keys = Object.keys(state.sessions).sort((a, b) => state.sessions[b].updatedAt - state.sessions[a].updatedAt);
          keys.slice(16).forEach(item => delete state.sessions[item]);
        } else if (message.action === 'HUMAN_GAME_RECORD') {
          const record = message.record;
          if (!record || JSON.stringify(record).length > 20000) throw new Error('Invalid game record');
          Adapter.record(state, record, message.target);
        } else if (message.action === 'HUMAN_STATS_RESET') {
          // Preserve active sessions; their frozen profile only changes with the next game.
          Object.assign(state, { history: [], seen: state.seen, groups: {} });
        } else throw new Error('Unknown statistics action');
        return { success: true, summary: Adapter.current(state, message.group, message.target), groups: state.groups };
      });
    }
  }
  root.StatsStore = StatsStore;
  if (typeof module !== 'undefined') module.exports = { StatsStore };
})(typeof globalThis !== 'undefined' ? globalThis : this);
