/** Read only explicit game metadata and result elements, never infer an outcome from a missing board. */
class GameContext {
  static isHistory(board) {
    if (board?.dataset.history === 'true') return true;
    if (board?.tagName?.toLowerCase() === 'cg-board' && typeof BoardDetector !== 'undefined') {
      const round = BoardDetector.lichessRoundHistory();
      if (round) return round.ply < round.moves.length;
    }
    const moves = [...document.querySelectorAll('wc-move-list .node, .move-list .node, .moves-list .node, .round__app move')];
    const selected = moves.findIndex(node => node.matches('.selected, .active, [aria-current="true"]'));
    return selected >= 0 && selected < moves.length - 1;
  }
  static read(detector, settings) {
    const board = detector.boardElement;
    const path = location.pathname;
    const site = location.hostname.includes('chess.com') ? 'chess.com' : location.hostname.includes('lichess.org') ? 'lichess' : 'test';
    const gameId = board?.dataset.gameId || (site === 'chess.com' ? path.match(/\/(?:game|live)\/(?:live\/)?(\d+)/)?.[1] :
      site === 'lichess' && !/^\/(?:analysis|training|practice|study)(?:\/|$)/.test(path) ? path.match(/^\/([a-zA-Z0-9]{8,12})(?:\/|$)/)?.[1] : null);
    const category = site === 'test' ? 'test' : /\/play\/computer/.test(path) ? 'bot' : gameId ? 'human' : 'unknown';
    const opponent = document.querySelector('[data-cy="top-player-rating"], .player-top .user-tagline-rating, .player-component.top .user-tagline-rating, .game__meta .opponent .rating');
    const explicitLevel = board?.dataset.opponentLevel;
    const rating = Number(explicitLevel || opponent?.textContent?.replace(/[^\d]/g, ''));
    const levelBucket = Number.isFinite(rating) && rating >= 100 && rating <= 4000 ? String(Math.floor(rating / 200) * 200) : 'unknown';
    const explicitTime = board?.dataset.timeControl || document.querySelector('[data-time-control]')?.getAttribute('data-time-control');
    const timeControl = explicitTime || document.querySelector('.game__meta .setup')?.textContent?.trim().slice(0, 60) ||
      (category === 'bot' ? 'untimed' : 'unknown');
    return { site, sourceId: gameId || null, route: location.origin + path,
      opponentCategory: category, opponentLevelBucket: levelBucket, timeControl,
      playerColor: detector.getUserColor(), persona: settings.playMode === 'rated' ? 'balanced' : settings.aiPersona, mode: settings.playMode,
      baseLevel: settings.targetElo,
      ...(settings.playMode === 'human' ? { humanPolicyVersion: 2, calibrationVersion: PlayerProfiles.HUMAN_CALIBRATION_VERSION,
        target: settings.humanTargetWinRate ?? 0.65,
        strengthBias: settings.adaptiveStrength ? Number(settings.humanStrengthBias ?? 170) : 0 } : {}) };
  }
  static result(fen, color, board) {
    const verified = GameOutcomes.outcome(fen, color);
    if (verified) return verified;
    const fixture = board?.dataset.result;
    if (fixture) return GameOutcomes.fromResult(fixture, color);
    for (const element of document.querySelectorAll('.game-over-modal [data-result], .game-over-component [data-result], .round__app .result, .game__meta .result')) {
      if (!element.getClientRects().length) continue;
      const result = GameOutcomes.fromResult(element.getAttribute('data-result') || element.textContent, color);
      if (result) return result;
    }
    const titleElement = document.querySelector('.game-over-modal .game-over-title, .game-over-modal .game-over-header-component, .game-over-component .game-over-header-component');
    const title = titleElement?.getClientRects().length ? titleElement.textContent?.trim().toLowerCase() : null;
    if (title && /^(you won!?|you win!?|вы победили!?|победа!?)$/.test(title)) return { result: 'win', termination: 'site-result', resultSource: 'site-result' };
    if (title && /^(you lost!?|you lose!?|вы проиграли!?|поражение!?)$/.test(title)) return { result: 'loss', termination: 'site-result', resultSource: 'site-result' };
    if (title && /^(draw!?|ничья!?)$/.test(title)) return { result: 'draw', termination: 'draw', resultSource: 'site-result' };
    return null;
  }
}
if (typeof module !== 'undefined') module.exports = { GameContext };
