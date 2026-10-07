document.addEventListener('DOMContentLoaded', async () => {
  const eloRange = document.getElementById('elo-range');
  const eloDisplay = document.getElementById('elo-display');
  const eloHint = document.getElementById('elo-hint');

  const toggleBlunder = document.getElementById('toggle-blunder');
  const toggleSnowball = document.getElementById('toggle-snowball');
  const toggleDelay = document.getElementById('toggle-delay');
  const toggleBridge = document.getElementById('toggle-bridge');
  const toggleAutoPlay = document.getElementById('toggle-auto-play');
  const playMode = document.getElementById('play-mode');
  const adaptive = document.getElementById('toggle-adaptive');
  const winTarget = document.getElementById('target-win-rate');
  const statsGroup = document.getElementById('stats-group');
  let groups = {};
  function updateModel() {
    const human = playMode.value === 'human';
    const rated = playMode.value === 'rated';
    adaptive.disabled = !(human || rated);
    personaButtons.forEach(button => { button.disabled = rated; });
    toggleSnowball.disabled = rated;
    document.getElementById('safety-label').textContent = human || rated ? '🛡️ Неточности по силе профиля' : '🛡️ Защита от зевов — всегда включена';
    updateEloDisplay(eloRange.value);
  }
  function showStatistics() {
    const item = groups[statsGroup.value];
    const records = item?.records || [];
    const wins = records.filter(game => game.result === 'win').length;
    const draws = records.filter(game => game.result === 'draw').length;
    document.getElementById('human-statistics').textContent = records.length ?
      `${wins}/${records.length} побед (${Math.round(wins / records.length * 100)}%). Ничьи: ${draws}; поражения: ${records.length - wins - draws}. ` +
      `Очки: ${Math.round((wins + draws * 0.5) / records.length * 100)}%. ` +
      (item.total < 20 ? 'Собираем данные.' : `Поправка силы: ${item.offset > 0 ? '+' : ''}${item.offset}.`) : 'Нет завершённых партий';
  }
  async function readStatistics() {
    if (typeof chrome === 'undefined' || !chrome.storage?.local) return;
    const stored = await chrome.storage.local.get('humanPlayState');
    groups = stored.humanPlayState?.groups || {};
    const selected = statsGroup.value;
    statsGroup.replaceChildren();
    for (const key of Object.keys(groups)) {
      const [site, category, level, time, persona, mode, base] = key.split('|');
      const label = `${site} · ${category === 'bot' ? 'бот' : category === 'human' ? 'игрок' : category} ${level === 'unknown' ? '' : level} · ${time} · ${persona} · ${mode === 'rated' ? 'ELO' : mode === 'human' ? 'человек' : 'сильный'} ${base}`;
      statsGroup.add(new Option(label, key));
    }
    if (!statsGroup.options.length) statsGroup.add(new Option('Нет партий', ''));
    if (groups[selected]) statsGroup.value = selected;
    showStatistics();
  }
  statsGroup.addEventListener('change', showStatistics);
  document.getElementById('reset-human-stats').addEventListener('click', async () => {
    try {
      const response = await chrome.runtime.sendMessage({ action: 'HUMAN_STATS_RESET' });
      if (!response?.success) throw new Error(response?.error || 'Не удалось сбросить статистику');
      await readStatistics();
    } catch (error) { document.getElementById('human-statistics').textContent = error.message; }
  });

  const btnOpenTest = document.getElementById('btn-open-test');
  const personaButtons = [...document.querySelectorAll('[data-persona]')];
  function updatePersona(value) {
    const id = PersonaStyles.normalizePersona(value);
    personaButtons.forEach(button => {
      const active = button.dataset.persona === id;
      button.setAttribute('aria-pressed', String(active));
      button.classList.toggle('active', active);
    });
    document.getElementById('persona-description').textContent = PersonaStyles.PERSONAS[id].description;
  }
  personaButtons.forEach(button => button.addEventListener('click', () => {
    updatePersona(button.dataset.persona);
    if (typeof chrome !== 'undefined' && chrome.storage?.sync) chrome.storage.sync.set({ aiPersona: button.dataset.persona });
  }));
  updatePersona('balanced');

  const hints = {
    800: 'Новичок • Глубина 6 • Частые неточности',
    1000: 'Новичок • Глубина 6 • Топ 2-3 приоритет',
    1200: 'Любитель • Глубина 8 • Сбалансированный сноубол',
    1400: 'Любитель • Глубина 8 • Топ 1-2 приоритет',
    1600: 'Клубный игрок • Глубина 10 • Топ 1 (50%)',
    1800: 'Клубный игрок • Глубина 12 • Позиционная стабильность',
    2000: 'КМС • Глубина 14 • Сильный позиционный расчет',
    2200: 'Мастер • Глубина 16 • Топ 1 (85%)',
    2400: 'Мастер • Глубина 16 • Топ 1 (85%)',
    2600: 'Движок • Глубина 18+ • Максимальная мощность'
  };

  function updateEloDisplay(val) {
    eloDisplay.textContent = `${val} ELO`;
    eloHint.textContent = playMode.value === 'rated' ? 'Ориентир: 55% очков против равного уровня • шкала Stockfish' :
      playMode.value === 'human' ? 'Исходная сила профиля • не измеренный рейтинг' : 'Сильный анализ • ELO не ограничивает силу';
  }

  // Загрузка сохраненных настроек
  if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.sync) {
    chrome.storage.sync.get(['ratingPolicyVersion', 'targetElo', 'aiPersona', 'snowballMode', 'humanDelay', 'useLocalBridge', 'autoPlay', 'playMode', 'adaptiveStrength', 'targetWinRate'], (data) => {
      if (data.ratingPolicyVersion !== 2) {
        Object.assign(data, { playMode: 'rated', targetWinRate: 0.55, ratingPolicyVersion: 2 });
        chrome.storage.sync.set({ playMode: 'rated', targetWinRate: 0.55, ratingPolicyVersion: 2 });
      }
      playMode.value = ['human', 'strict'].includes(data.playMode) ? data.playMode : 'rated';
      adaptive.checked = data.adaptiveStrength === true;
      winTarget.value = String(data.targetWinRate || 0.55);
      if (data.targetElo) {
        eloRange.value = data.targetElo;
        updateEloDisplay(data.targetElo);
      }
      updatePersona(data.aiPersona);
      if (data.snowballMode !== undefined) toggleSnowball.checked = data.snowballMode;
      if (data.humanDelay !== undefined) toggleDelay.checked = data.humanDelay;
      if (data.useLocalBridge !== undefined) toggleBridge.checked = data.useLocalBridge;
      toggleAutoPlay.checked = data.autoPlay === true;
      updateModel();
    });
  }

  eloRange.addEventListener('input', (e) => {
    const val = parseInt(e.target.value, 10);
    updateEloDisplay(val);
  });

  eloRange.addEventListener('change', (e) => {
    const val = parseInt(e.target.value, 10);
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.sync) {
      chrome.storage.sync.set({ targetElo: val });
    }
  });

  const bindToggle = (el, key) => {
    el.addEventListener('change', () => {
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.sync) {
        chrome.storage.sync.set({ [key]: el.checked });
      }
    });
  };

  if (typeof chrome !== 'undefined' && chrome.storage?.onChanged) chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.humanPlayState) readStatistics();
    if (area === 'sync' && changes.playMode) { playMode.value = ['human', 'strict'].includes(changes.playMode.newValue) ? changes.playMode.newValue : 'rated'; updateModel(); }
    if (area === 'sync' && changes.adaptiveStrength) adaptive.checked = changes.adaptiveStrength.newValue === true;
    if (area === 'sync' && changes.targetWinRate) winTarget.value = String(changes.targetWinRate.newValue || 0.55);
    if (area === 'sync' && changes.aiPersona) updatePersona(changes.aiPersona.newValue);
    if (area === 'sync' && changes.autoPlay) toggleAutoPlay.checked = changes.autoPlay.newValue === true;
  });
  bindToggle(toggleSnowball, 'snowballMode');
  bindToggle(toggleDelay, 'humanDelay');
  bindToggle(toggleBridge, 'useLocalBridge');
  bindToggle(toggleAutoPlay, 'autoPlay');
  bindToggle(adaptive, 'adaptiveStrength');
  playMode.addEventListener('change', () => { updateModel(); chrome.storage?.sync?.set({ playMode: playMode.value }); });
  winTarget.addEventListener('change', () => chrome.storage?.sync?.set({ targetWinRate: Number(winTarget.value) }));
  updateModel();
  readStatistics().catch(error => { document.getElementById('human-statistics').textContent = error.message; });

  btnOpenTest.addEventListener('click', () => {
    if (typeof chrome !== 'undefined' && chrome.tabs) {
      chrome.tabs.create({ url: chrome.runtime.getURL('test/test_board.html') });
    } else {
      window.open('../test/test_board.html', '_blank');
    }
  });
});
