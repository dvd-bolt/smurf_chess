(function (root) {
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  function group(meta = {}) {
    return [meta.site || 'unknown', meta.opponentCategory || 'unknown', meta.opponentLevelBucket || 'unknown',
      meta.timeControl || 'unknown', meta.persona || 'balanced', meta.mode || 'strict', Math.round(Number(meta.baseLevel) || 1500),
      ...(meta.mode === 'human' && meta.humanPolicyVersion ? [`h${meta.humanPolicyVersion}`, `c${meta.calibrationVersion || 1}`,
        `wins${Math.round((meta.target ?? 0.65) * 100)}`, `bias${meta.strengthBias || 0}`] : [])].join('|');
  }
  function summarize(records = [], target = 0.65, previousOffset = 0, metric = 'wins', window = 100, deadband = 0.05) {
    const games = records.filter(item => ['win', 'draw', 'loss'].includes(item.result)).slice(-window);
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
    if (n >= 20) {
      if (low > boundedTarget + deadband) { offset -= 40; status = 'decrease'; }
      else if (high < boundedTarget - deadband) { offset += 40; status = 'increase'; }
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
    if (item.mixedSettings || item.manualOverride) return true;
    const key = group(item);
    const previous = state.groups[key] || { records: [], offset: 0, total: 0 };
    // IDs are already kept in the deduplication ledger; avoid duplicating them in both statistical windows.
    const sample = { result: item.result, effectiveStrength: item.profileSnapshot?.modelLevel ?? item.profileSnapshot?.level ?? item.baseLevel };
    previous.records.push(sample); previous.records = previous.records.slice(-100);
    previous.validationRecords = [...(previous.validationRecords || []), sample].slice(-2000);
    previous.total++;
    // Once the window is full, updates still happen every ten new games, not on every game.
    const metric = item.mode === 'rated' ? 'score' : 'wins';
    const summary = summarize(previous.records, item.target ?? target, previous.offset, metric);
    const modelCorrection = item.mode === 'human' && item.humanPolicyVersion === 2 ? Number(item.profileSnapshot?.modelCorrection) || 0 : 0;
    const base = clamp((Number(item.baseLevel) || 1500) + (Number(item.strengthBias) || 0) + modelCorrection, 800, 2800);
    const stableRecords = previous.validationRecords.filter(record => record.effectiveStrength === clamp(base + previous.offset, 800, 2800));
    // A 100-game rolling interval never narrows further. V2 accumulates evidence
    // at the actual frozen strength, so a persistent 75% rate can eventually correct.
    const adaptation = item.mode === 'human' && item.humanPolicyVersion === 2 ?
      summarize(stableRecords, summary.target, previous.offset, metric, 2000, 0) : summary;
    const minimum = Math.max(-600, 800 - base), maximum = Math.min(600, 2800 - base);
    if (previous.total >= 20 && previous.total % 10 === 0 && adaptation.games >= 20) previous.offset = clamp(adaptation.offset, minimum, maximum);
    const limited = adaptation.offset < minimum || adaptation.offset > maximum || adaptation.status === 'limit';
    previous.summary = { ...summary, status: limited ? 'limit' : adaptation.status, offset: previous.offset, total: previous.total };
    previous.target = summary.target;
    previous.effectiveStrength = clamp(base + previous.offset, 800, 2800);
    state.groups[key] = previous;
    return true;
  }
  function current(state, key, target = 0.65) {
    const stored = state.groups[key];
    const metric = String(key).includes('|rated|') ? 'score' : 'wins';
    const summary = summarize(stored?.records || [], stored?.target ?? target, stored?.offset || 0, metric);
    const stable = (stored?.validationRecords || []).filter(record => record.effectiveStrength === stored.effectiveStrength);
    const validation = summarize(stable, summary.target, stored?.offset || 0, metric, 2000);
    const confirmed = metric === 'wins' && validation.games >= 350 && validation.low >= summary.target - 0.05 && validation.high <= summary.target + 0.05;
    return { ...summary, status: stored?.summary?.status === 'limit' ? 'limit' : String(key).includes('|h2|') ? validation.status : summary.status,
      offset: stored?.offset || 0, total: stored?.total || 0, validation, confirmed };
  }
  const api = { group, summarize, empty, record, current };
  root.StrengthAdapter = api;
  if (typeof module !== 'undefined') module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
