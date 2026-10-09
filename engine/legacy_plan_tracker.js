/* Frozen v1 plan semantics for games started before human policy v2. */
(function (root) {
  const Rules = root.ChessRules || require('../vendor/chess.js').ChessRules;
  const labels = { develop: 'Развитие: подготовка рокировки', defend: 'Защита: устранить угрозу', simplify: 'Реализация: упрощение позиции',
    attack: 'Атака: давление на короля', file: 'Давление по открытой линии', passed: 'Эндшпиль: продвижение проходной' };
  class LegacyPlanTracker {
    constructor(state = null) { this.state = state; }
    update(fen, scoreCp, complexity, persona) {
      const game = new Rules(fen), color = game.turn();
      const signature = game.board().flat().filter(p => p && ['p','q','r'].includes(p.type))
        .map(p => p.color + p.type + (p.type === 'p' ? p.square : '')).sort().join('|');
      const forcedDefense = complexity.inCheck || scoreCp < -150;
      let type = this.state?.type;
      if (!type || this.state.signature !== signature || Math.abs((this.state.scoreCp || 0) - scoreCp) > 180 || forcedDefense)
        type = forcedDefense ? 'defend' : scoreCp > 150 ? 'simplify' : complexity.endgame ? 'passed' :
          Number(fen.split(' ')[5]) <= 10 ? 'develop' : persona === 'tal' ? 'attack' : 'file';
      this.state = { type, signature, scoreCp, color, label: labels[type] }; return this.state;
    }
    compatibility(features) {
      const type = this.state?.type;
      const fits = type === 'develop' ? features.isMinorDev || features.isStructure : type === 'defend' ? features.isProphylaxis || features.isCheck :
        type === 'simplify' ? features.isQueenTrade : type === 'passed' ? features.isPassedPawn || features.isKingActive :
          type === 'attack' ? features.isCheck || features.isPawnSacrifice : features.isCentral;
      return fits ? 1.25 : 1;
    }
  }
  root.LegacyPlanTracker = LegacyPlanTracker;
  if (typeof module !== 'undefined') module.exports = { LegacyPlanTracker };
})(typeof globalThis !== 'undefined' ? globalThis : this);
