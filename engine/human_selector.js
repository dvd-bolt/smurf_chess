(function (root) {
  const Profiles = root.PlayerProfiles || (typeof require === 'function' ? require('./player_profile.js') : null);
  const Complexity = root.PositionComplexity || (typeof require === 'function' ? require('./position_complexity.js') : null);
  const Styles = root.PersonaStyles || (typeof require === 'function' ? require('./personas.js') : null);
  const Plans = root.PlanTracker || (typeof require === 'function' ? require('./plan_tracker.js').PlanTracker : null);
  class HumanSelector {
    constructor(profile, planState = null) { this.profile = profile; this.plans = new Plans(planState); }
    select(lines, context) {
      const profile = this.profile;
      const complexity = Complexity.inspect(context.fen, lines, context.remainingSeconds, context.familiar);
      const sorted = lines.filter(line => complexity.candidates[line.uci] && line.score)
        .slice().sort((a, b) => Complexity.score(b.score) - Complexity.score(a.score));
      if (!sorted.length) return null;
      const best = sorted[0];
      const bestCp = Complexity.score(best.score);
      const plan = this.plans.update(context.fen, bestCp, complexity, profile.persona);
      const random = Profiles.random(profile.gameSeed + context.fen);
      const ability = complexity.endgame ? profile.skills.endgame : complexity.level > 0.4 ? profile.skills.tactics : profile.skills.positional;
      const temperature = profile.selectionTemperature * (0.65 + complexity.level * 0.9 + (complexity.timeTrouble ? 0.25 : 0));
      const errorRoll = random();
      const serious = errorRoll < profile.errorDistribution.serious * complexity.level;
      const moderate = !serious && errorRoll < profile.errorDistribution.moderate * (0.3 + complexity.level);
      const cap = serious ? profile.maxLossCp : moderate ? Math.min(profile.maxLossCp, 240) : Math.min(profile.maxLossCp, 130);
      const obvious = complexity.legalMoves.length === 1 || complexity.candidates[best.uci].mateOne || complexity.candidates[best.uci].obviousCapture;
      const items = sorted.map((line, index) => {
        const details = complexity.candidates[line.uci];
        const features = Styles.features(context.fen, line.uci, line.pv);
        const lossCp = Math.max(0, bestCp - Complexity.score(line.score));
        const comparable = !best.depth || !line.depth || Math.abs(best.depth - line.depth) <= 3;
        const allowed = index === 0 || (!details.immediateRisk && comparable && lossCp <= cap &&
          !(line.score.unit === 'mate' && line.score.value < 0 && bestCp > -10000));
        const visibility = details.recognizability * (1 - details.difficulty * (1 - ability));
        let weight = allowed ? Math.exp(-lossCp / Math.max(5, temperature)) * visibility * this.plans.compatibility(features) *
          Styles.modifier(profile.persona, features, bestCp) : 0;
        if (complexity.timeTrouble && details.sacrifice) weight *= 0.6;
        if (moderate && lossCp >= 40) weight *= 2;
        if (serious && lossCp >= 120) weight *= 4;
        if (obvious && index !== 0) weight *= 0.005;
        return { uci: line.uci, rank: index + 1, scoreCp: Complexity.score(line.score), lossCp, features,
          isLegal: true, isAllowedByProfile: allowed, isWithinStrictSafety: lossCp <= 160, isSafe: lossCp <= 160,
          confidence: comparable && (line.depth || 0) >= 6 ? 'normal' : 'limited', weight, details };
      });
      const total = items.reduce((sum, item) => sum + item.weight, 0);
      items.forEach(item => { item.probability = total > 0 ? item.weight / total : item.rank === 1 ? 1 : 0; });
      let roll = random();
      let chosen = items[0];
      for (const item of items) { roll -= item.probability; if (roll <= 0) { chosen = item; break; } }
      const selectedLine = sorted.find(line => line.uci === chosen.uci);
      const reason = chosen.details.mateOne ? 'Мат в один' : chosen.details.obviousCapture ? 'Очевидное взятие' : plan.label;
      return { move: chosen.uci, rank: chosen.rank, rankLabel: 'Человеческая игра', isBook: false,
        scoreCp: chosen.scoreCp, scoreText: selectedLine.score.unit === 'mate' ? `M${selectedLine.score.value}` :
          `${chosen.scoreCp >= 0 ? '+' : ''}${(chosen.scoreCp / 100).toFixed(1)}`,
        strategy: 'human', aiPersona: profile.persona, reason, plan: plan.type, planState: plan,
        complexity, isTactical: chosen.details.isTactical, allCandidates: items.map(({ weight, details, ...item }) => item) };
    }
  }
  root.HumanSelector = HumanSelector;
  if (typeof module !== 'undefined') module.exports = { HumanSelector };
})(typeof globalThis !== 'undefined' ? globalThis : this);
