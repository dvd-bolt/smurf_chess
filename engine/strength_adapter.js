(function (root) {
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  function group(meta = {}) {
    return [meta.site || 'unknown', meta.opponentCategory || 'unknown', meta.opponentLevelBucket || 'unknown',
      meta.timeControl || 'unknown', meta.persona || 'balanced', meta.mode || 'strict', Math.round(Number(meta.baseLevel) || 1500)].join('|');
  }
  function summarize(records = [], target = 0.65, previousOffset = 0, metric = 'wins') {
    const games = records.filter(item => ['win', 'draw', 'loss'].includes(item.result)).slice(-100);
    const wins = games.filter(item => item.result === 'win').length;
    const draws = games.filter(item => item.result === 'draw').length;
    const n = games.length;
    const rate = n ? wins / n : null;
    const scoreRate = n ? (wins + draws * 0.5) / n : null;
    const observed = metric === 'score' ? scoreRate : rate;
    // Wilson interval for wins; a conservative score interval treats half-point draws as fractional outcomes.
    const z = 1.96, divisor = 1 + z * z / Math.max(1, n);
    const center = n ? (observed + z * z / (2 * n)) / divisor : 0.5;
    const radius = n ? z * Math.sqrt(observed * (1 - observed) / n + z * z / (4 * n * n)) / divisor : 0.5;
    const low = n ? Math.max(0, center - radius) : 0;
    const high = n ? Math.min(1, center + radius) : 1;
    const boundedTarget = clamp(Number(target) || 0.65, 0.5, 0.8);
    let offset = previousOffset;
    let status = n < 20 ? 'collecting' : 'uncertain';
    if (n >= 20 && games.length % 10 === 0) {
      if (low > boundedTarget + 0.05) { offset -= 40; status = 'decrease'; }
      else if (high < boundedTarget - 0.05) { offset += 40; status = 'increase'; }
      else if (observed >= boundedTarget - 0.05 && observed <= boundedTarget + 0.05) status = 'target';
    }
    offset = clamp(offset, -600, 600);
    if (Math.abs(offset) === 600 && (status === 'increase' || status === 'decrease')) status = 'limit';
    return { games: n, wins, draws, losses: n - wins - draws, winRate: rate,
      scoreRate, metric, low, high, offset, target: boundedTarget, status };
  }
  function empty() { return { schemaVersion: 1, history: [], seen: [], groups: {}, sessions: {} }; }
  function record(state, item, target = 0.65) {
    if (!item?.id || typeof item.id !== 'string' || !['win', 'draw', 'loss'].includes(item.result) ||
        !item.resultSource || state.seen.includes(item.id)) return false;
    state.seen.push(item.id); state.seen = state.seen.slice(-5000);
    state.history.push(item); state.history = state.history.slice(-500);
    // Games whose settings changed midway cannot calibrate a single strength profile.
    if (item.mixedSettings) return true;
    const key = group(item);
    const previous = state.groups[key] || { records: [], offset: 0, total: 0 };
    previous.records.push({ id: item.id, result: item.result }); previous.records = previous.records.slice(-100);
    previous.total++;
    // Once the window is full, updates still happen every ten new games, not on every game.
    const summary = summarize(previous.records, target, previous.offset, item.mode === 'rated' ? 'score' : 'wins');
    const base = clamp(Number(item.baseLevel) || 1500, 800, 2800);
    const minimum = Math.max(-600, 800 - base), maximum = Math.min(600, 2800 - base);
    if (previous.total >= 20 && previous.total % 10 === 0) previous.offset = clamp(summary.offset, minimum, maximum);
    const limited = summary.offset < minimum || summary.offset > maximum || summary.status === 'limit';
    previous.summary = { ...summary, status: limited ? 'limit' : summary.status, offset: previous.offset, total: previous.total };
    state.groups[key] = previous;
    return true;
  }
  function current(state, key, target = 0.65) {
    const stored = state.groups[key];
    const summary = summarize(stored?.records || [], target, stored?.offset || 0, String(key).includes('|rated|') ? 'score' : 'wins');
    return { ...summary, status: stored?.summary?.status === 'limit' ? 'limit' : summary.status,
      offset: stored?.offset || 0, total: stored?.total || 0 };
  }
  const api = { group, summarize, empty, record, current };
  root.StrengthAdapter = api;
  if (typeof module !== 'undefined') module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
