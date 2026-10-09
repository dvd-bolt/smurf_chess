(function (root) {
  const Profiles = root.PlayerProfiles || require('./player_profile.js');
  const Candidates = root.HumanCandidates || require('./human_candidates.js');
  const Perception = root.HumanPerception || require('./human_perception.js');
  const Complexity = root.PositionComplexity || require('./position_complexity.js');
  const Styles = root.PersonaStyles || require('./personas.js');
  const Plans = root.PlanTracker || require('./plan_tracker.js').PlanTracker;
  const Legacy = root.LegacyHumanSelector || require('./human_legacy_selector.js').HumanSelector;
  class HumanSelector {
    constructor(profile, planState = null, perceptionState = null) {
      this.profile = profile; this.planState = planState; this.perceptionState = perceptionState;
      if (profile.humanPolicyVersion !== 2) this.legacy = new Legacy(profile, planState);
    }
    select(lines, context) {
      if (this.legacy) return this.legacy.select(lines, context);
      const generated = context.generated || Candidates.generate(context.fen, { plan: this.planState });
      const byMove = new Map(lines.map(line => [line.uci, line]));
      const proposed = context.candidates || generated.candidates;
      const pool = new Map(proposed.map(candidate => [candidate.uci, candidate]));
      for (const line of lines.slice(0, 4)) {
        const candidate = generated.all.find(item => item.uci === line.uci);
        if (candidate && !pool.has(line.uci)) pool.set(line.uci, { ...candidate, originReasons: [...candidate.originReasons, 'кандидат расчёта'] });
      }
      if (!pool.size) return null;
      const complexity = Complexity.inspect(context.fen, lines, context.remainingSeconds, context.familiar);
      // Align material/activity estimates with the shared position judgment. Otherwise an
      // uncalculated move looks artificially better whenever all engine lines are negative.
      const positionScores = lines.filter(line => line.score).map(line => Math.max(-2000, Math.min(2000, Complexity.score(line.score)))).sort((a,b) => b-a);
      const positionEstimate = positionScores.length ? (positionScores[0] + (positionScores[1] ?? positionScores[0])) / 2 : generated.beforeCp;
      const evaluationAnchor = (positionEstimate - generated.beforeCp) * this.profile.skills.positional;
      const observations = [...pool.values()].map(candidate => ({ ...candidate,
        ...Perception.inspect(candidate, byMove.get(candidate.uci), this.profile, { ...context, evaluationAnchor, endgame: generated.endgame, complexity }, this.perceptionState) }));
      const plans = new Plans(context.planState ?? this.planState);
      const noticedThreat = generated.exposedBefore >= 300 && observations.some(item => item.features.isProphylaxis && !item.recognizedThreats.length);
      const plan = plans.update(context.fen, 0, { ...complexity, noticedThreat }, this.profile.persona);
      const temperature = Math.max(4, this.profile.selectionTemperature * 0.65 * (complexity.timeTrouble ? 1.3 : 1));
      const bestPerceived = Math.max(...observations.map(item => item.perceivedValue));
      const weights = observations.map(item => Math.exp(Math.max(-700, (item.perceivedValue - bestPerceived) / temperature)) *
        plans.compatibility(item.features, item) * Styles.modifier(this.profile.persona, item.features, item.perceivedValue));
      const total = weights.reduce((sum, weight) => sum + weight, 0);
      const random = Profiles.random(`${this.profile.gameSeed}:${context.decisionKey || context.fen}:choice-v2`);
      let roll = random(), chosen = observations[0];
      observations.forEach((item, index) => { item.probability = weights[index] / total; });
      for (const item of observations) { roll -= item.probability; if (roll <= 0) { chosen = item; break; } }
      const evaluated = lines.filter(l => l.score);
      const line = byMove.get(chosen.uci), bestCp = evaluated.length ? Math.max(...evaluated.map(l => Complexity.score(l.score))) : 0;
      const attention = (this.perceptionState?.attention ?? 0.97) * 0.85 + (0.92 + random() * 0.08) * 0.15;
      const reason = chosen.mateOne ? 'Мат в один' : chosen.uci === plan.nextMove ? `${plan.label}: ${plan.goal}` : chosen.originReasons[0];
      return { move: chosen.uci, rank: line?.rank || lines.findIndex(l => l.uci === chosen.uci) + 1 || 1,
        rankLabel: 'Человеческая игра', strategy: 'human', humanPolicyVersion: 2, aiPersona: this.profile.persona, isBook: false,
        scoreCp: line?.score ? Complexity.score(line.score) : undefined,
        scoreText: line?.score ? line.score.unit === 'mate' ? `M${line.score.value}` : (line.score.value / 100).toFixed(1) : '—',
        reason, perceivedValue: chosen.perceivedValue, recognizedThreats: chosen.recognizedThreats, missedMotifs: chosen.missedMotifs,
        plan: plan.type, planState: plan, pendingState: { planState: Plans.advance(plan, chosen.uci), perceptionState: { attention } },
        complexity, isTactical: !!complexity.candidates[chosen.uci]?.isTactical,
        allCandidates: observations.map(item => ({ uci: item.uci, rank: lines.findIndex(l => l.uci === item.uci) + 1,
          probability: item.probability, isLegal: true, isAllowedByProfile: true,
          lossCp: byMove.get(item.uci)?.score ? Math.max(0, bestCp - Complexity.score(byMove.get(item.uci).score)) : null,
          isWithinStrictSafety: byMove.get(item.uci)?.score ? bestCp - Complexity.score(byMove.get(item.uci).score) <= 160 : false,
          isSafe: byMove.get(item.uci)?.score ? bestCp - Complexity.score(byMove.get(item.uci).score) <= 160 : false,
          originReasons: item.originReasons, perceivedValue: item.perceivedValue, shallowValue: item.shallowValue,
          recognizedThreats: item.recognizedThreats, missedMotifs: item.missedMotifs, uncertainty: item.uncertainty,
          engineEvaluation: item.engineEvaluation, confidence: item.engineEvaluation?.confidence || 'limited' })) };
    }
  }
  root.HumanSelector = HumanSelector;
  if (typeof module !== 'undefined') module.exports = { HumanSelector };
})(typeof globalThis !== 'undefined' ? globalThis : this);
