(function (root) {
  const Rules = root.ChessRules || (typeof require === 'function' ? require('../vendor/chess.js').ChessRules : null);
  const labels = { develop: 'Развитие: подготовка рокировки', defend: 'Защита: устранить угрозу',
    simplify: 'Реализация: упрощение позиции', attack: 'Атака: давление на короля',
    file: 'Давление по открытой линии', passed: 'Эндшпиль: продвижение проходной' };
  class PlanTracker {
    constructor(state = null) { this.state = state; }
    update(fen, scoreCp, complexity, persona) {
      const game = new Rules(fen);
      const pieces = game.board().flat().filter(Boolean);
      const color = game.turn();
      const signature = pieces.filter(p => p.type === 'p' || p.type === 'q' || p.type === 'r')
        .map(p => p.color + p.type + (p.type === 'p' ? p.square : '')).sort().join('|');
      const forcedDefense = complexity.inCheck || scoreCp < -150;
      let type = this.state?.type;
      if (!type || this.state.signature !== signature || Math.abs((this.state.scoreCp || 0) - scoreCp) > 180 || forcedDefense) {
        type = forcedDefense ? 'defend' : scoreCp > 150 ? 'simplify' :
          complexity.endgame ? 'passed' : Number(fen.split(' ')[5]) <= 10 ? 'develop' : persona === 'tal' ? 'attack' : 'file';
      }
      this.state = { type, signature, scoreCp, color, label: labels[type] };
      return this.state;
    }
    compatibility(features) {
      const type = this.state?.type;
      const fits = type === 'develop' ? features.isMinorDev || features.isStructure :
        type === 'defend' ? features.isProphylaxis || features.isCheck :
          type === 'simplify' ? features.isQueenTrade : type === 'passed' ? features.isPassedPawn || features.isKingActive :
            type === 'attack' ? features.isCheck || features.isPawnSacrifice : features.isCentral;
      return fits ? 1.25 : 1;
    }
  }
  root.PlanTracker = PlanTracker;
  if (typeof module !== 'undefined') module.exports = { PlanTracker };
})(typeof globalThis !== 'undefined' ? globalThis : this);
