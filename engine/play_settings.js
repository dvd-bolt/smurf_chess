(function (root) {
  const bounded = (value, fallback) => Math.max(0.5, Math.min(0.8, Number(value) || fallback));
  function normalize(stored = {}) {
    const playMode = ['human', 'rated', 'strict'].includes(stored.playMode) ? stored.playMode : 'rated';
    const humanTargetWinRate = bounded(stored.humanTargetWinRate ??
      (stored.settingsVersion !== 2 && stored.playMode === 'human' ? stored.targetWinRate : undefined), 0.65);
    const ratedTargetScore = bounded(stored.ratedTargetScore ??
      (stored.settingsVersion !== 2 && stored.playMode === 'rated' ? stored.targetWinRate : undefined), 0.55);
    return { ...stored, settingsVersion: 2, playMode, humanTargetWinRate, ratedTargetScore,
      targetWinRate: playMode === 'human' ? humanTargetWinRate : ratedTargetScore };
  }
  function target(settings, mode = settings.playMode) {
    return mode === 'human' ? settings.humanTargetWinRate ?? 0.65 : settings.ratedTargetScore ?? 0.55;
  }
  root.PlaySettings = { normalize, target };
  if (typeof module !== 'undefined') module.exports = root.PlaySettings;
})(typeof globalThis !== 'undefined' ? globalThis : this);
