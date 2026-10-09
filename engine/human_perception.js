/* Perceived value is separate from engine truth. Missed replies remain possible. */
(function (root) {
  const Rules = root.ChessRules || require('../vendor/chess.js').ChessRules;
  const Profiles = root.PlayerProfiles || require('./player_profile.js');
  const Candidates = root.HumanCandidates || require('./human_candidates.js');
  const Complexity = root.PositionComplexity || require('./position_complexity.js');
  function inspect(candidate, line, profile, context, state = null) {
    const random = Profiles.random(`${profile.gameSeed}:${context.decisionKey || context.fen}:${candidate.uci}:perception-v2`);
    const game = new Rules(context.fen), color = game.turn();
    game.move(candidate.move);
    const replies = game.moves({ verbose: true });
    const mateOne = !replies.length && game.in_check();
    const trouble = Number.isFinite(context.remainingSeconds) && context.remainingSeconds <= 30;
    const clockFactor = trouble ? (context.remainingSeconds <= 10 ? 0.64 : 0.82) : 1;
    const attention = state?.attention ?? (0.94 + Profiles.random(profile.gameSeed + ':attention')() * 0.06);
    const tacticalSkill = Profiles.clamp(profile.skills.tactics * clockFactor * attention, 0.1, 0.995);
    const endgame = context.endgame;
    const positionalSkill = (endgame ? profile.skills.endgame : profile.skills.positional) * clockFactor;
    const anchor = context.evaluationAnchor || 0;
    let shallow = candidate.staticCp + anchor, recognizedThreats = [], missedMotifs = [];
    // Every candidate gets the same bounded reply scan; material trade chains are short and visible.
    const forcing = replies.filter(reply => reply.captured || /[+#]/.test(reply.san))
      .sort((a, b) => (b.san.includes('#') ? 100000 : Candidates.values[b.captured] || 0) -
        (a.san.includes('#') ? 100000 : Candidates.values[a.captured] || 0)).slice(0, 6);
    for (const reply of forcing) {
      const easy = reply.san.includes('#') || reply.to === candidate.move.to;
      const notice = easy ? 0.96 + tacticalSkill * 0.039 : 0.30 + tacticalSkill * 0.69;
      if (random() > notice * (trouble ? 0.97 : 1)) { missedMotifs.push(reply.san.includes('#') ? 'матовая угроза' : 'форсированный ответ'); continue; }
      game.move(reply);
      let value = reply.san.includes('#') ? -20000 : Candidates.evaluate(game, color) + anchor;
      if (!reply.san.includes('#')) {
        const recaptures = game.moves({ verbose: true }).filter(next => next.captured && next.to === reply.to).slice(0, 3);
        for (const next of recaptures) {
          if (random() > 0.70 + tacticalSkill * 0.29) continue;
          game.move(next); value = Math.max(value, Candidates.evaluate(game, color) + anchor); game.undo();
        }
      }
      game.undo();
      if (value < shallow - 70) recognizedThreats.push(reply.san.includes('#') ? 'мат в один' : 'потеря материала');
      shallow = Math.min(shallow, value);
    }
    const detail = context.complexity?.candidates?.[candidate.uci];
    const difficulty = detail?.difficulty ?? 0.3;
    // Skill is not a per-move coin flip: simple continuations are visible even to
    // weaker players. Most misses belong to difficult motifs and low clock budgets.
    const recognition = Profiles.clamp(0.93 + tacticalSkill * 0.069 - difficulty * (1 - tacticalSkill) * 0.65 -
      (trouble ? 0.04 : 0), 0.30, 0.998);
    const recognizedLine = !!line?.score && random() < recognition;
    let perceived = shallow;
    if (recognizedLine) {
      // A recognised continuation informs judgment; incomplete engine evidence is discounted.
      const truth = Complexity.score(line.score);
      const confidence = Math.min(1, (line.depth || 0) / 8);
      const blend = Profiles.clamp((0.4 + positionalSkill * 0.60) * confidence, 0, 0.99);
      perceived = truth * blend + shallow * (1 - blend);
      if (truth < shallow - 100) recognizedThreats.push('тактическое опровержение');
    } else if (line?.score) missedMotifs.push(difficulty > 0.35 ? 'сложное продолжение' : 'оценка продолжения');
    else perceived -= 30 + positionalSkill * 90; // Limited evidence carries uncertainty, never a fictitious 0 cp score.
    const uncertainty = (1 - positionalSkill) * (18 + difficulty * 65) * (trouble ? 1.3 : 1);
    perceived += (random() + random() - 1) * uncertainty;
    if (mateOne) perceived = 20000;
    return { perceivedValue: perceived, shallowValue: shallow, recognizedLine, recognizedThreats: [...new Set(recognizedThreats)],
      missedMotifs: [...new Set(missedMotifs)], uncertainty, mateOne, clockFactor,
      engineEvaluation: line?.score ? { score: line.score, depth: line.depth || 0, confidence: (line.depth || 0) >= 8 ? 'normal' : 'limited' } : null };
  }
  root.HumanPerception = { inspect };
  if (typeof module !== 'undefined') module.exports = root.HumanPerception;
})(typeof globalThis !== 'undefined' ? globalThis : this);
