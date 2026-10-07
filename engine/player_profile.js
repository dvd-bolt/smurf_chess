(function (root) {
  const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
  function hash(text) {
    let value = 2166136261;
    for (const char of String(text)) value = Math.imul(value ^ char.charCodeAt(0), 16777619);
    return value >>> 0;
  }
  function random(seed) {
    let state = hash(seed);
    return () => {
      state += 0x6D2B79F5;
      let value = Math.imul(state ^ state >>> 15, 1 | state);
      value ^= value + Math.imul(value ^ value >>> 7, 61 | value);
      return ((value ^ value >>> 14) >>> 0) / 4294967296;
    };
  }
  function create(options = {}, seed = 'sensei') {
    const baseLevel = clamp(Number(options.targetElo) || 1500, 800, 2800);
    const adaptationOffset = clamp(Number(options.adaptationOffset) || 0, -600, 600);
    const level = clamp(baseLevel + adaptationOffset, 800, 2800);
    const ability = (level - 800) / 2000;
    const persona = ['balanced', 'tal', 'karpov', 'capablanca'].includes(options.aiPersona) ? options.aiPersona : 'balanced';
    return { schemaVersion: 1, baseLevel, adaptationOffset, level, persona, gameSeed: String(seed),
      repertoireId: `${persona}:${Math.floor(baseLevel / 400)}`,
      skills: { tactics: clamp(0.35 + ability * 0.63 + (persona === 'tal' ? 0.06 : 0), 0, 0.99),
        positional: clamp(0.4 + ability * 0.58 + (persona === 'karpov' ? 0.06 : 0), 0, 0.99),
        endgame: clamp(0.3 + ability * 0.68 + (persona === 'capablanca' ? 0.07 : 0), 0, 0.99),
        opening: 0.5 + ability * 0.45 },
      riskPreference: persona === 'tal' ? 1.2 : persona === 'karpov' ? 0.85 : 1,
      selectionTemperature: 4 + (1 - ability) ** 2 * 138,
      maxLossCp: Math.round(35 + (1 - ability) ** 2 * 415),
      errorDistribution: { moderate: (1 - ability) ** 2 * 0.16, serious: (1 - ability) ** 2 * 0.04 } };
  }
  function bookMove(opening, legal, profile) {
    const moves = (opening?.moves || []).filter(item => legal.has(item.uci));
    if (!moves.length) return null;
    // A small repertoire repeats across games; the position, rather than request order, picks its branch.
    const repertoire = moves.slice().sort((a, b) => hash(profile.repertoireId + a.uci) - hash(profile.repertoireId + b.uci)).slice(0, 2);
    return repertoire[Math.floor(random(profile.repertoireId + opening.fen + [...legal].sort().join(','))() * repertoire.length)];
  }
  function familiar(fen, profile) {
    const number = Number(fen.split(' ')[5]);
    if (number <= 3) return true;
    if (number > Math.floor(4 + profile.skills.opening * 10)) return false;
    return random(profile.repertoireId + fen.split(' ').slice(0, 4).join(' '))() < profile.skills.opening;
  }
  const api = { create, random, hash, clamp, bookMove, familiar };
  root.PlayerProfiles = api;
  if (typeof module !== 'undefined') module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
