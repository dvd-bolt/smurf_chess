(function (root) {
  const Rules = root.ChessRules || require('../vendor/chess.js').ChessRules;
  const labels = { develop: 'Развитие и рокировка', defend: 'Устранить замеченную угрозу', simplify: 'Размен фигур',
    passed: 'Провести проходную', king: 'Активизировать короля', attack: 'Усилить давление', file: 'Улучшить фигуру' };
  class PlanTracker {
    constructor(state = null) { this.state = state ? JSON.parse(JSON.stringify(state)) : null; }
    update(fen, scoreCp, complexity = {}, persona = 'balanced') {
      const game = new Rules(fen), color = game.turn(), legal = game.moves({ verbose: true });
      const fullmove = Number(fen.split(' ')[5]), old = this.state;
      const piece = old?.pieceSquare && game.get(old.pieceSquare);
      const completed = old?.completed || old?.targetSquare && game.get(old.targetSquare)?.color === color && game.get(old.targetSquare)?.type === old.pieceType;
      const forcedDefense = complexity.inCheck || complexity.noticedThreat;
      const invalid = !old || old.color !== color || (old.pieceSquare && (!piece || piece.color !== color || piece.type !== old.pieceType));
      if (!invalid && !completed && !forcedDefense && fullmove - (old.startedMove || fullmove) < 6) {
        this.state = { ...old, nextMove: this.nextStep(game, old, legal) }; return this.state;
      }
      const pieces = game.board().flat().filter(Boolean);
      const passed = pieces.filter(p => p.color === color && p.type === 'p' && !pieces.some(enemy => enemy.color !== color && enemy.type === 'p' &&
        Math.abs(enemy.square.charCodeAt(0) - p.square.charCodeAt(0)) <= 1 && (color === 'w' ? enemy.square[1] > p.square[1] : enemy.square[1] < p.square[1])));
      const type = forcedDefense ? 'defend' : complexity.endgame ? passed.length ? 'passed' : 'king' : fullmove <= 10 ? 'develop' : persona === 'tal' ? 'attack' : 'file';
      const home = color === 'w' ? '1' : '8';
      const center = square => Math.abs(square.charCodeAt(0) - 100.5) + Math.abs(Number(square[1]) - 4.5);
      let options = legal.filter(move => type === 'develop' ? /[kq]/.test(move.flags) || (['n', 'b'].includes(move.piece) && move.from[1] === home) :
        type === 'passed' ? passed.some(p => p.square === move.from) : type === 'king' ? move.piece === 'k' :
          type === 'defend' ? !!move.captured || move.piece === 'k' : ['r', 'n', 'b'].includes(move.piece));
      options.sort((a, b) => Number(/[kq]/.test(b.flags)) - Number(/[kq]/.test(a.flags)) || center(a.to) - center(b.to) || a.from.localeCompare(b.from));
      const target = options[0] || legal[0];
      const rank = color === 'w' ? '1' : '8';
      const castleGoal = type === 'develop' && game.get('e' + rank)?.type === 'k' && fen.split(' ')[2].includes(color === 'w' ? 'K' : 'k');
      const targetSquare = castleGoal ? 'g' + rank : type === 'passed' && target?.piece === 'p' ? target.to[0] + (color === 'w' ? '8' : '1') :
        type === 'king' && target?.piece === 'k' ? (color === 'w' ? 'e4' : 'e5') : target?.to || null;
      this.state = { type, color, label: labels[type], pieceSquare: target?.from || null, pieceType: target?.piece || null,
        targetSquare, nextMove: target ? target.from + target.to + (target.promotion || '') : null,
        startedMove: fullmove, progress: 0, goal: target ? `${target.piece}: ${target.from} → ${target.to}` : labels[type],
        changeReason: forcedDefense ? 'угроза' : completed ? 'цель достигнута' : invalid ? 'новая цель' : 'пересмотр плана' };
      if (castleGoal) Object.assign(this.state, { pieceSquare: 'e' + rank, pieceType: 'k', goal: 'Развить фигуры и рокировать на королевский фланг' });
      else if (type === 'passed' && target?.piece === 'p') this.state.goal = `Провести пешку ${target.from} на ${targetSquare}`;
      else if (type === 'king') this.state.goal = 'Вывести короля к центру';
      this.state.nextMove = this.nextStep(game, this.state, legal);
      return this.state;
    }
    nextStep(game, state, legal) {
      const direct = legal.find(move => move.from === state.pieceSquare && move.to === state.targetSquare);
      if (direct) return direct.from + direct.to + (direct.promotion || '');
      let moves;
      if (state.type === 'develop' && state.pieceType === 'k') {
        const home = state.color === 'w' ? '1' : '8';
        moves = legal.filter(move => ['f' + home, 'g' + home].includes(move.from) && ['n', 'b'].includes(move.piece));
        if (!moves.length) moves = legal.filter(move => move.piece === 'p' && ['e', 'g'].includes(move.from[0]));
      } else moves = legal.filter(move => move.from === state.pieceSquare);
      const distance = square => Math.abs(square.charCodeAt(0) - (state.targetSquare || square).charCodeAt(0)) +
        Math.abs(Number(square[1]) - Number((state.targetSquare || square)[1]));
      moves.sort((a,b) => distance(a.to) - distance(b.to) || a.to.localeCompare(b.to));
      const move = moves[0]; return move ? move.from + move.to + (move.promotion || '') : null;
    }
    compatibility(features, candidate = null) {
      const state = this.state, type = state?.type;
      if (candidate?.uci === state?.nextMove) return 1.55;
      const fits = type === 'develop' ? features.isMinorDev || features.isCastle :
        type === 'defend' ? features.isProphylaxis : type === 'king' ? features.isKingActive : type === 'passed' ? features.isPassedPawn || features.isKingActive :
          type === 'attack' ? features.isCheck || features.isPawnSacrifice : features.isCentral;
      return fits ? 1.2 : 1;
    }
    static advance(state, move) {
      if (!state) return null;
      const next = { ...state };
      if (move.slice(0, 2) === next.pieceSquare) next.pieceSquare = move.slice(2, 4);
      if (move.slice(2, 4) === next.targetSquare && move.slice(0, 2) === state.pieceSquare) next.completed = true;
      if (move === state.nextMove) next.progress = (next.progress || 0) + 1;
      return next;
    }
  }
  root.PlanTracker = PlanTracker;
  if (typeof module !== 'undefined') module.exports = { PlanTracker };
})(typeof globalThis !== 'undefined' ? globalThis : this);
