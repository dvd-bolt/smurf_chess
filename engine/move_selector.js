/**
 * MoveSelector - Модуль выбора оптимального хода со стратегией «Сноубол»,
 * фильтрацией грубых ошибок (Blunder Filter), профилями ELO и трекером точности (Live Accuracy).
 */

const SelectorPersonas = typeof PersonaStyles !== 'undefined' ? PersonaStyles : (typeof require === 'function' ? require('./personas.js') : null);
class MoveSelector {
  constructor(options = {}) {
    this.targetElo = options.targetElo || 1500;
    this.blunderThresholdCp = Math.min(160, Math.max(0, Number(options.blunderThresholdCp ?? 160) || 0));
    this.history = []; // История ходов текущей партии для подсчета CPL
    this.blunderFilter = true;
    this.snowballMode = options.snowballMode !== false;
    this.aiPersona = SelectorPersonas.normalizePersona(options.aiPersona);
  }

  setElo(elo) {
    this.targetElo = Math.max(800, Math.min(2800, Number(elo) || 1500));
  }

  resetHistory() {
    this.history = [];
  }

  /**
   * Получить параметры поиска Stockfish и базовые веса по ELO
   */
  getEloProfile() {
    const elo = this.targetElo;
    if (elo <= 1100) {
      return { depth: 6, weights: [0.20, 0.45, 0.35], name: 'Новичок' };
    } else if (elo <= 1400) {
      return { depth: 8, weights: [0.35, 0.45, 0.20], name: 'Любитель' };
    } else if (elo <= 1600) {
      return { depth: 10, weights: [0.50, 0.35, 0.15], name: 'Клубный игрок' };
    } else if (elo <= 1800) {
      return { depth: 12, weights: [0.60, 0.30, 0.10], name: 'Клубный игрок+' };
    } else if (elo <= 2100) {
      return { depth: 14, weights: [0.72, 0.22, 0.06], name: 'КМС / Продвинутый' };
    } else if (elo <= 2400) {
      return { depth: 16, weights: [0.85, 0.13, 0.02], name: 'Мастер' };
    } else {
      return { depth: 18, weights: [0.95, 0.05, 0.00], name: 'Гроссмейстер' };
    }
  }

  /**
   * Нормализует оценку (в сантипешках) относительно игрока, чей ход.
   * Маты приводятся к диапазону 10000..30000.
   */
  normalizeScore(scoreObj) {
    if (!scoreObj) return 0;
    if (scoreObj.unit === 'mate') {
      const mateIn = scoreObj.value;
      if (mateIn > 0) return 20000 - mateIn * 100;
      if (mateIn < 0) return -20000 - mateIn * 100;
      return 0;
    }
    return Number(scoreObj.value) || 0;
  }

  /**
   * Фильтрация грубых ошибок (Blunder Filter).
   * Отсекает ходы Топ-2 / Топ-3, если они теряют больше blunderThresholdCp относительно Топ-1.
   * @param {Array} lines - отсортированные по оценке ходы MultiPV
   * @returns {Array} - отфильтрованные безопасные ходы
   */
  filterBlunders(lines) {
    if (!lines || lines.length <= 1) return lines || [];

    const bestScore = this.normalizeScore(lines[0].score);
    const safeLines = [lines[0]]; // Топ-1 всегда включен

    for (let i = 1; i < lines.length; i++) {
      const lineScore = this.normalizeScore(lines[i].score);
      const loss = bestScore - lineScore;

      // Если потеря больше порога, это зевок или серьезная неточность
      if (loss <= this.blunderThresholdCp) {
        safeLines.push(lines[i]);
      } else {
        console.log(`[MoveSelector] Blunder Filter: ход ${lines[i].uci} (ранг ${lines[i].rank}) отсеян (потеря ${loss} cp)`);
      }
    }

    return safeLines;
  }

  /**
   * Стратегия «Сноубол» (Smooth Snowballing).
   * Адаптирует распределение вероятностей под текущую стадию позиции:
   * - Равно: надежные ходы без риска
   * - Преимущество: плавное наращивание давления
   * - Выиграно: упрощение и чистая реализация
   * - Тяжелая позиция: тактическое сопротивление (ловушки)
   */
  adjustWeightsForSnowball(baseWeights, evalCp, count) {
    const weights = baseWeights.slice(0, count);

    // Нормализуем исходные веса
    let sum = weights.reduce((a, b) => a + b, 0);
    let normWeights = weights.map(w => w / sum);

    if (evalCp >= 250) {
      // Большой перевес: играем строго на закрепление и реализацию (смещаем к Топ-1)
      normWeights[0] = Math.min(0.92, normWeights[0] + 0.25);
      if (normWeights[1]) normWeights[1] = Math.max(0.08, normWeights[1] - 0.15);
      if (normWeights[2]) normWeights[2] = Math.max(0.00, normWeights[2] - 0.10);
    } else if (evalCp >= 60) {
      // Сноубол-зона: плавное накопление перевеса (+0.6..+2.5)
      normWeights[0] = Math.min(0.70, normWeights[0] + 0.10);
    } else if (evalCp <= -150) {
      // Трудная позиция: если альтернативы не зевки, даем шанс активным контр-линиям
      if (normWeights[1]) normWeights[1] += 0.10;
      normWeights[0] = Math.max(0.40, normWeights[0] - 0.10);
    }

    // Финальная перенормировка
    sum = normWeights.reduce((a, b) => a + b, 0);
    return normWeights.map(w => w / sum);
  }

  /**
   * Главный метод выбора хода
   * @param {Array} multipvLines - массив строк от Stockfish [{ rank: 1, uci: 'e2e4', score: { unit: 'cp', value: 40 } }, ...]
   * @param {object} bookCandidate - ход из дебютной книги (если есть)
   * @returns {object} результат выбора хода
   */
  selectMove(multipvLines, bookCandidate = null, context = {}) {
    // 1. Если есть подходящий дебютный ход, играем по книге
    if (bookCandidate && bookCandidate.uci) {
      return {
        move: bookCandidate.uci,
        rank: 'book',
        rankLabel: 'Дебютная книга',
        isBook: true,
        scoreText: '+0.0',
        scoreCp: 0,
        strategy: 'book',
        allCandidates: [{ uci: bookCandidate.uci, rank: 1, isBook: true }]
      };
    }

    if (!multipvLines || multipvLines.length === 0) {
      return null;
    }

    // 2. Сортируем линии по оценке
    const sortedLines = multipvLines.slice().sort((a, b) => {
      return this.normalizeScore(b.score) - this.normalizeScore(a.score);
    });

    // Присваиваем ранги 1, 2, 3
    sortedLines.forEach((line, idx) => { line.rank = idx + 1; });
    const styleFeatures = new Map(sortedLines.map(line => [line.uci, SelectorPersonas.features(context.fen, line.uci, line.pv)]));

    // 3. Применяем фильтр зевов
    const safeLines = this.filterBlunders(sortedLines);

    // 4. Получаем профиль ELO и веса со сноуболом
    const profile = this.getEloProfile();
    const bestScoreCp = this.normalizeScore(safeLines[0].score);
    const adjustedWeights = this.snowballMode
      ? this.adjustWeightsForSnowball(safeLines.map(line => profile.weights[line.rank - 1]), bestScoreCp, safeLines.length)
      : safeLines.map(line => profile.weights[line.rank - 1]);
    const styledWeights = adjustedWeights.map((weight, i) => weight * SelectorPersonas.modifier(this.aiPersona,
      styleFeatures.get(safeLines[i].uci), bestScoreCp));
    const totalWeight = styledWeights.reduce((sum, weight) => sum + weight, 0);
    const probabilities = totalWeight > 0 ? styledWeights.map(weight => weight / totalWeight) : safeLines.map((_, i) => i === 0 ? 1 : 0);

    // 5. Рандомизированный выбор по весам
    let rand = Math.random();
    let chosenLine = safeLines[0];

    for (let i = 0; i < safeLines.length; i++) {
      rand -= probabilities[i];
      if (rand <= 0) {
        chosenLine = safeLines[i];
        break;
      }
    }

    // 6. Форматируем читаемую оценку
    let scoreText = '+0.0';
    if (chosenLine.score) {
      if (chosenLine.score.unit === 'mate') {
        scoreText = `M${chosenLine.score.value}`;
      } else {
        const val = (chosenLine.score.value / 100).toFixed(1);
        scoreText = chosenLine.score.value >= 0 ? `+${val}` : val;
      }
    }

    const rankLabels = {
      1: '🏆 Топ-1 (Лучший)',
      2: '🥈 Топ-2 (Надежный)',
      3: '🥉 Топ-3 (Сноубол)'
    };

    return {
      move: chosenLine.uci,
      rank: chosenLine.rank,
      rankLabel: rankLabels[chosenLine.rank] || `Топ-${chosenLine.rank}`,
      isBook: false,
      scoreText,
      scoreCp: this.normalizeScore(chosenLine.score),
      strategy: safeLines.length < sortedLines.length ? 'blunder_filtered' : 'snowball',
      aiPersona: this.aiPersona,
      allCandidates: sortedLines.map(l => ({
        uci: l.uci,
        rank: l.rank,
        scoreCp: this.normalizeScore(l.score),
        isSafe: safeLines.includes(l),
        probability: probabilities[safeLines.indexOf(l)] || 0,
        features: styleFeatures.get(l.uci)
      }))
    };
  }

  /**
   * Запись сделанного хода для трекера точности партии
   */
  recordMoveLoss(centipawnLoss) {
    this.history.push(Math.max(0, Number(centipawnLoss) || 0));
  }

  /**
   * Расчет текущей точности (Accuracy %) и статуса подозрительности
   */
  getLiveAccuracy() {
    if (this.history.length === 0) {
      return { accuracy: 100, avgCpl: 0, statusLabel: 'Нет оценённых ходов', movesAnalyzed: 0, warning: false };
    }

    const totalCpl = this.history.reduce((a, b) => a + b, 0);
    const avgCpl = totalCpl / this.history.length;

    // Честная формула точности: экспоненциальное затухание от среднего CPL
    // avgCpl = 15 cp -> ~94% (мастер)
    // avgCpl = 35 cp -> ~87% (клубный игрок)
    // avgCpl = 60 cp -> ~78% (любитель)
    // avgCpl = 100 cp -> ~67% (новичок)
    const accuracy = Math.max(10, Math.min(100, Math.round(100 * Math.exp(-0.0042 * avgCpl))));

    // Проверка на подозрительность относительно выбранного ELO
    let warning = false;
    let label = 'Человеческий уровень';

    if (this.targetElo <= 1400 && accuracy >= 95 && this.history.length >= 10) {
      warning = true;
      label = '⚠️ Слишком чисто для 1400 ELO!';
    } else if (this.targetElo <= 1700 && accuracy >= 97 && this.history.length >= 12) {
      warning = true;
      label = '⚠️ Аномально высокая точность!';
    } else if (accuracy >= 92) {
      label = '💎 Гроссмейстерский уровень';
    } else if (accuracy >= 82) {
      label = '👍 Уверенная игра';
    } else {
      label = '👌 Спокойная игра';
    }

    return {
      accuracy,
      avgCpl: Math.round(avgCpl),
      statusLabel: label,
      warning,
      movesAnalyzed: this.history.length
    };
  }
}

if (typeof module !== 'undefined') {
  module.exports = { MoveSelector };
}
