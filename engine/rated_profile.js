/* Rating-limited play. Below Stockfish's advertised floor, use a measured error blend. */
(function (root) {
  const Profiles = root.PlayerProfiles || (typeof require === 'function' ? require('./player_profile.js') : null);
  const VERSION = 2;
  const FLOOR = 1320;
  const TARGET = 0.55;
  const ADVANTAGE = Math.round(400 * Math.log10(TARGET / (1 - TARGET)));
  const ERROR_KNOTS = [[800, 0.175], [1000, 0.122], [1200, 0.020], [1320, 0]];
  // Short-search NNUE matches exposed excess strength at the top of this build's scale.
  const ENGINE_CORRECTIONS = [[800, 0], [2200, 0], [2600, -25], [2800, -25]];
  function engineCorrection(level) {
    for (let i = 1; i < ENGINE_CORRECTIONS.length; i++) {
      const [low, from] = ENGINE_CORRECTIONS[i - 1], [high, to] = ENGINE_CORRECTIONS[i];
      if (level <= high) return Math.round(from + (to - from) * Profiles.clamp((level - low) / (high - low), 0, 1));
    }
    return ENGINE_CORRECTIONS.at(-1)[1];
  }
  function errorProbability(elo) {
    if (elo >= FLOOR) return 0;
    for (let i = 1; i < ERROR_KNOTS.length; i++) {
      const [low, from] = ERROR_KNOTS[i - 1], [high, to] = ERROR_KNOTS[i];
      if (elo <= high) return from + (to - from) * Profiles.clamp((elo - low) / (high - low), 0, 1);
    }
    return 0;
  }
  function create(level, seed = 'rated', advantage = ADVANTAGE) {
    const nominalElo = Math.round(Profiles.clamp(Number(level) || 1500, 800, 2800));
    const effectiveElo = nominalElo + advantage;
    const correction = engineCorrection(nominalElo);
    return { version: VERSION, nominalElo, effectiveElo, engineCorrection: correction,
      engineElo: Math.max(FLOOR, effectiveElo + correction),
      // Provisional until the independent match report has enough completed games.
      errorProbability: errorProbability(effectiveElo),
      seed: String(seed), targetScore: TARGET };
  }
  function alternative(profile, fen, legalMoves, preferred) {
    const random = Profiles.random(`${profile.seed}:${fen}:rated-v${VERSION}`);
    if (random() >= profile.errorProbability) return null;
    const candidates = legalMoves.filter(move => move.from + move.to + (move.promotion || '') !== preferred);
    if (!candidates.length) return null;
    // All legal moves remain available: low profiles can miss hanging pieces and tactics.
    const move = candidates[Math.floor(random() * candidates.length)];
    return move.from + move.to + (move.promotion || '');
  }
  const api = { VERSION, FLOOR, TARGET, ADVANTAGE, ERROR_KNOTS, ENGINE_CORRECTIONS, create, alternative };
  root.RatedProfile = api;
  if (typeof module !== 'undefined') module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
