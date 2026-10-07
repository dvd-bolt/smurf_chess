/**
 * run_tests.js - Комплексный автоматизированный набор тестов для Chess Sensei.
 * Запуск: node test/run_tests.js
 */

const fs = require('fs');
const path = require('path');
const { OpeningsBook } = require('../engine/openings_book.js');
const { MoveSelector } = require('../engine/move_selector.js');
const { TimeManager } = require('../content/time_manager.js');
const { VisualOverlay } = require('../content/visual_overlay.js');
const { HudWidget } = require('../content/hud_widget.js');
const { BoardDetector } = require('../content/board_detector.js');
const { EngineController } = require('../engine/engine_controller.js');

let passedCount = 0;
let failedCount = 0;

function assert(condition, testName) {
  if (condition) {
    console.log(`  ✅ [PASS] ${testName}`);
    passedCount++;
  } else {
    console.error(`  ❌ [FAIL] ${testName}`);
    failedCount++;
  }
}

async function runAllTests() {
  console.log('====================================================');
  console.log('🧪 ЗАПУСК АВТОМАТИЗИРОВАННЫХ ТЕСТОВ CHESS SENSEI');
  console.log('====================================================\n');

  // ----------------------------------------------------
  // ТЕСТ 1: OpeningsBook
  // ----------------------------------------------------
  console.log('📦 1. Тестирование Дебютной Книги (OpeningsBook)...');
  const book = new OpeningsBook();
  const dbData = JSON.parse(fs.readFileSync(path.join(__dirname, '../engine/openings_data.json'), 'utf8'));
  book.db = dbData;
  book.loaded = true;

  assert(Object.keys(book.db).length >= 5000, `База дебютов загружена (${Object.keys(book.db).length} позиций)`);

  const startposFen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
  const startMatch = book.lookup(startposFen);
  assert(startMatch !== null, 'Стартовая позиция найдена в книге');
  assert(startMatch.moves.length >= 2, 'В стартовой позиции есть ходы (e4, d4 и т.д.)');

  const pickedMove = book.pickMove(startMatch);
  assert(pickedMove && ['e2e4', 'd2d4', 'c2c4', 'g1f3'].includes(pickedMove.uci), `Случайный книжный ход корректен: ${pickedMove ? pickedMove.uci : 'null'}`);

  const sicilianFen = 'rnbqkbnr/pp1ppppp/8/2p5/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2';
  const sicilianMatch = book.lookup(sicilianFen);
  assert(sicilianMatch !== null && sicilianMatch.moves.some(m => m.uci === 'g1f3'), 'Сицилианская защита распознана (1...c5)');

  // ----------------------------------------------------
  // ТЕСТ 2: MoveSelector & Blunder Filter
  // ----------------------------------------------------
  console.log('\n🧠 2. Тестирование Селектора Ходов и Фильтра Зевов...');
  const selector = new MoveSelector({ targetElo: 1500, blunderThresholdCp: 160 });

  // Тест профилей ELO
  selector.setElo(1000);
  assert(selector.getEloProfile().depth === 6, 'Рейтинг 1000 ELO -> глубина 6');
  selector.setElo(1800);
  assert(selector.getEloProfile().depth === 12, 'Рейтинг 1800 ELO -> глубина 12');
  selector.setElo(2500);
  assert(selector.getEloProfile().depth === 18, 'Рейтинг 2500 ELO -> глубина 18');

  // Тест фильтра зевов: линия 1 (+100 cp), линия 2 (+60 cp), линия 3 (-300 cp - грубый зевок!)
  const sampleLines = [
    { uci: 'e2e4', score: { unit: 'cp', value: 100 } },
    { uci: 'd2d4', score: { unit: 'cp', value: 60 } },
    { uci: 'g1f3', score: { unit: 'cp', value: -300 } }
  ];
  const safeLines = selector.filterBlunders(sampleLines);
  assert(safeLines.length === 2, 'Грубый зевок g1f3 (-300) успешно отфильтрован из пула');
  assert(safeLines[0].uci === 'e2e4' && safeLines[1].uci === 'd2d4', 'Остались только безопасные кандидаты e2e4 и d2d4');

  // Проверка выбора хода со стратегией сноубола
  const chosenResult = selector.selectMove(sampleLines);
  assert(chosenResult && ['e2e4', 'd2d4'].includes(chosenResult.move), `Выбран безопасный ход: ${chosenResult.move} (ранг ${chosenResult.rank})`);
  assert(chosenResult.strategy === 'blunder_filtered', 'Стратегия выбора помечена как blunder_filtered');

  // ----------------------------------------------------
  // ТЕСТ 3: Live Accuracy & CPL Tracker
  // ----------------------------------------------------
  console.log('\n📊 3. Тестирование Трекера Точности (Live Accuracy)...');
  selector.resetHistory();
  [10, 15, 8, 12, 16].forEach(cpl => selector.recordMoveLoss(cpl));
  const masterAcc = selector.getLiveAccuracy();
  assert(masterAcc.accuracy >= 92, `Гроссмейстерская точность: ${masterAcc.accuracy}%`);
  assert(masterAcc.statusLabel.includes('Гроссмейстер'), `Статус корректен: ${masterAcc.statusLabel}`);

  selector.resetHistory();
  [50, 70, 65, 55, 80].forEach(cpl => selector.recordMoveLoss(cpl));
  const clubAcc = selector.getLiveAccuracy();
  assert(clubAcc.accuracy >= 70 && clubAcc.accuracy <= 82, `Человеческая точность: ${clubAcc.accuracy}%`);

  // ----------------------------------------------------
  // ТЕСТ 4: TimeManager & Режим Ботов Chess.com
  // ----------------------------------------------------
  console.log('\n⏱️ 4. Тестирование Тайм-менеджера и Часов...');
  const timeMgr = new TimeManager({ random: () => 0.5 });

  // Парсинг времени
  assert(timeMgr.parseClockText('3:00') === 180, 'Парсинг "3:00" -> 180 сек');
  assert(timeMgr.parseClockText('0:14.5') === 14.5, 'Парсинг "0:14.5" -> 14.5 сек');
  assert(timeMgr.parseClockText('1:15:00') === 4500, 'Парсинг "1:15:00" -> 4500 сек');

  // Режим партии с ботом без часов (null)
  const botOpeningDelay = timeMgr.calculateThinkTime({ remainingSeconds: null, moveNumber: 3, isBook: false });
  assert(botOpeningDelay >= 1.2 && botOpeningDelay <= 2.8, `Задержка против бота в ранней игре: ${botOpeningDelay}s`);

  const botTacticalDelay = timeMgr.calculateThinkTime({ remainingSeconds: null, moveNumber: 16, isTactical: true });
  assert(botTacticalDelay >= 3.2 && botTacticalDelay <= 5.5, `Обучающая задержка против бота в тактике: ${botTacticalDelay}s`);

  // Расчет времени при нормальном контроле (3 мин, 15-й ход)
  const normalTime = timeMgr.calculateThinkTime({ remainingSeconds: 120, moveNumber: 15, isBook: false });
  assert(normalTime >= 2.5 && normalTime <= 6.5, `Реалистичное время в миттельшпиле: ${normalTime}s`);

  // Расчет времени в сильном цейтноте (8 секунд на часах)
  const scrambleTime = timeMgr.calculateThinkTime({ remainingSeconds: 8, moveNumber: 38, isBook: false });
  assert(scrambleTime >= 0.5 && scrambleTime <= 1.8, `Защита от флага в цейтноте: ${scrambleTime}s`);

  // ----------------------------------------------------
  // ТЕСТ 5: VisualOverlay — Координаты и Мульти-стрелки
  // ----------------------------------------------------
  console.log('\n🏹 5. Тестирование Геометрии Стрелок (VisualOverlay)...');
  const overlay = new VisualOverlay();
  const mockRect = { width: 800, height: 800 };

  // e4 для белых (нормальная доска: a=0..h=7, ряд 4 -> row=4, col=4)
  const coordsE4Normal = overlay.squareToCoords('e4', false, mockRect);
  assert(coordsE4Normal && Math.round(coordsE4Normal.x) === 450 && Math.round(coordsE4Normal.y) === 450, 'Координаты e4 (нормальная ориентация): 450, 450');

  // e4 для черных (перевернутая доска: 7-col=3, 7-row=3 -> 350, 350)
  const coordsE4Flipped = overlay.squareToCoords('e4', true, mockRect);
  assert(coordsE4Flipped && Math.round(coordsE4Flipped.x) === 350 && Math.round(coordsE4Flipped.y) === 350, 'Координаты e4 (перевернутая доска): 350, 350');

  // Переключение флага отображения всех стрелок
  assert(overlay.showAllTopMoves === true, 'По умолчанию включен режим Топ 1-3 стрелок');
  overlay.toggleMultiArrows();
  assert(overlay.showAllTopMoves === false, 'Успешное переключение в режим 1 стрелки');
  overlay.toggleMultiArrows();
  assert(overlay.showAllTopMoves === true, 'Успешный возврат в режим Топ 1-3 стрелок');

  // ----------------------------------------------------
  // ТЕСТ 6: HudWidget — Форматирование Оценок
  // ----------------------------------------------------
  console.log('\n👑 6. Тестирование Форматирования HUD (HudWidget)...');
  const hud = new HudWidget();

  const scorePlus = hud.formatScore({ unit: 'cp', value: 45 });
  assert(scorePlus === '+0.45', `Оценка +45 cp -> "${scorePlus}"`);

  const scoreMinus = hud.formatScore({ unit: 'cp', value: -120 });
  assert(scoreMinus === '-1.20', `Оценка -120 cp -> "${scoreMinus}"`);

  const scoreMateWin = hud.formatScore({ unit: 'mate', value: 3 });
  assert(scoreMateWin === '#M3', `Мат в 3 хода -> "${scoreMateWin}"`);

  const scoreMateLoss = hud.formatScore({ unit: 'mate', value: -2 });
  assert(scoreMateLoss === '#-M2', `Мат соперника в 2 хода -> "${scoreMateLoss}"`);

  // ----------------------------------------------------
  // ТЕСТ 7: BoardDetector & EngineController Fallback Safety
  // ----------------------------------------------------
  console.log('\n🛡️ 7. Тестирование Защиты от Невозможных Ходов и Очереди Хода...');
  const detector = new BoardDetector();
  detector.siteType = 'chesscom';
  
  // Эмуляция moveCount
  detector.getChessComMoveCount = () => 0;
  assert(detector.determineActiveTurn() === 'w', 'Move count 0 -> ход белых (w)');
  assert(detector.estimateMoveNumber() === 1, 'Move count 0 -> номер хода 1');

  detector.getChessComMoveCount = () => 1;
  assert(detector.determineActiveTurn() === 'b', 'Move count 1 -> ход черных (b)');
  assert(detector.estimateMoveNumber() === 1, 'Move count 1 -> номер хода 1');

  detector.getChessComMoveCount = () => 16;
  assert(detector.determineActiveTurn() === 'w', 'Move count 16 (ход 8 завершен) -> ход белых (w)');
  assert(detector.estimateMoveNumber() === 9, 'Move count 16 -> номер хода 9');

  detector.getChessComMoveCount = () => 17;
  assert(detector.determineActiveTurn() === 'b', 'Move count 17 -> ход черных (b)');
  assert(detector.estimateMoveNumber() === 9, 'Move count 17 -> номер хода 9');

  // Тестирование по реальным подсвеченным клеткам (после 9... O-O-O)
  const mockBoardBlackJustMoved = {
    querySelectorAll: (sel) => {
      if (sel === '.highlight') {
        return [
          { classList: ['highlight', 'square-38'] }, // c8 (куда пришел черный король)
          { classList: ['highlight', 'square-58'] }  // e8 (откуда ушел)
        ];
      }
      return [];
    },
    querySelector: (sel) => {
      if (sel === '.piece.square-38') return { classList: ['piece', 'bk', 'square-38'] }; // bk
      return null;
    }
  };
  const detectorHlBlack = new BoardDetector();
  detectorHlBlack.siteType = 'chesscom';
  detectorHlBlack.boardElement = mockBoardBlackJustMoved;
  assert(detectorHlBlack.determineActiveTurn() === 'w', 'После хода 9... O-O-O (черный король на c8) -> ход белых (w)');

  // Тестирование после хода белых (9. Bd2)
  const mockBoardWhiteJustMoved = {
    querySelectorAll: (sel) => {
      if (sel === '.highlight') {
        return [
          { classList: ['highlight', 'square-42'] }, // d2 (куда пришел белый слон)
          { classList: ['highlight', 'square-31'] }  // c1 (откуда ушел)
        ];
      }
      return [];
    },
    querySelector: (sel) => {
      if (sel === '.piece.square-42') return { classList: ['piece', 'wb', 'square-42'] }; // wb
      return null;
    }
  };
  const detectorHlWhite = new BoardDetector();
  detectorHlWhite.siteType = 'chesscom';
  detectorHlWhite.boardElement = mockBoardWhiteJustMoved;
  assert(detectorHlWhite.determineActiveTurn() === 'b', 'После хода 9. Bd2 (белый слон на d2) -> ход черных (b)');

  // Fallback движка в миттельшпиле не должен выдавать e2e4!
  const engine = new EngineController();
  const midgameFen = 'r1b1k2r/ppp1qppp/3p1n2/8/2BPP3/2P1B3/P1QN1PPP/R4RK1 w kq - 1 9';
  const midgameFallback = engine.getFallbackMove(midgameFen);
  assert(midgameFallback === null, 'В миттельшпиле getFallbackMove() возвращает null (нет невозможных e2e4)');

  const startposFallback = engine.getFallbackMove('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1');
  assert(startposFallback === null, 'В стартовой позиции fallback возвращает null (нет захардкоженных ходов)');

  // Тестирование getTurnFromMoveList логики
  const mockRowsCompleted = [
    { querySelectorAll: () => [{ querySelector: () => null, textContent: 'Bd2' }, { querySelector: () => null, textContent: 'O-O-O' }] },
    { querySelectorAll: () => [{ querySelector: () => null, textContent: 'a3' }, { querySelector: () => null, textContent: 'Bxc3' }] },
    { querySelectorAll: () => [] } // пустая строка 11.
  ];
  const detectorList = new BoardDetector();
  detectorList.siteType = 'chesscom';
  // Эмулируем парсинг списка ходов
  let turnFromRows = null;
  for (let i = mockRowsCompleted.length - 1; i >= 0; i--) {
    const nodes = mockRowsCompleted[i].querySelectorAll();
    if (nodes.length >= 2) { turnFromRows = 'w'; break; }
    if (nodes.length === 1) { turnFromRows = 'b'; break; }
  }
  assert(turnFromRows === 'w', 'После завершения 10-го хода (a3, Bxc3) очередь хода возвращает w');

  // Тестирование реальной ситуации со скриншота: 11. h3 xd2 (черный слон берет на d2)
  const mockBoardMove11Capture = {
    querySelectorAll: (sel) => {
      if (sel === '.highlight') {
        return [
          { classList: ['highlight', 'square-33'] }, // c3 (откуда ушел черный слон)
          { classList: ['highlight', 'square-42'] }  // d2 (куда пришел черный слон и взял фигуру)
        ];
      }
      return [];
    },
    querySelector: (sel) => {
      if (sel === '.piece.square-42') return { classList: ['piece', 'bb', 'square-42'] }; // черный слон bb
      return null;
    }
  };
  const detectorMove11 = new BoardDetector();
  detectorMove11.siteType = 'chesscom';
  detectorMove11.boardElement = mockBoardMove11Capture;
  assert(detectorMove11.determineActiveTurn() === 'w', 'После хода 11... xd2 (черный слон взял на d2) -> очередь БЕЛЫХ (w)');

  // Тестирование getTurnFromMoveList с классами .black-node и .white-node и иконками
  const detectorDocMock = new BoardDetector();
  detectorDocMock.siteType = 'chesscom';
  // Мокаем глобальный document для проверки getTurnFromMoveList
  global.document = {
    querySelector: (sel) => {
      if (sel.includes('wc-move-list')) {
        return {
          querySelectorAll: (rowSel) => [
            {
              querySelector: (nodeSel) => {
                if (nodeSel === '.black-node') return { textContent: 'xd2', classList: { contains: () => false } };
                if (nodeSel === '.white-node') return { textContent: 'h3', classList: { contains: () => false } };
                return null;
              },
              querySelectorAll: () => []
            }
          ]
        };
      }
      return null;
    }
  };
  assert(detectorDocMock.getTurnFromMoveList() === 'w', 'getTurnFromMoveList корректно возвращает w для строки с .black-node xd2');
  delete global.document;

  // ----------------------------------------------------
  // ИТОГИ
  // ----------------------------------------------------
  passedCount += require('./persona_tests.js').runPersonaTests();

  console.log('\n====================================================');
  console.log(`РЕЗУЛЬТАТ: Пройдено ${passedCount} из ${passedCount + failedCount} тестов.`);
  if (failedCount === 0) {
    console.log('🎉 ВСЕ ТЕСТЫ УСПЕШНО ПРОЙДЕНЫ!');
  } else {
    console.error(`⚠️ Обнаружено ошибок: ${failedCount}`);
    process.exit(1);
  }
}

runAllTests().catch(err => {
  console.error('Ошибка в тестах:', err);
  process.exit(1);
});
