// Local replica of the Lichess input trust boundary, never plays on a real server.
const fixtureGame = new ChessRules();
const fixtureBoard = document.querySelector('cg-board');
let fixtureFrom = null;
const fixtureNames = { p: 'pawn', n: 'knight', b: 'bishop', r: 'rook', q: 'queen', k: 'king' };
function renderFixture() {
  fixtureBoard.replaceChildren();
  fixtureGame.board().forEach((rank, r) => rank.forEach((piece, c) => {
    if (!piece) return;
    const el = document.createElement('piece');
    el.className = `${piece.color === 'w' ? 'white' : 'black'} ${fixtureNames[piece.type]}`;
    el.style.transform = `translate(${c * 50}px, ${r * 50}px)`;
    fixtureBoard.appendChild(el);
  }));
  const history = fixtureGame.history();
  document.querySelector('app').innerHTML = history.map(san => `<z7yx>${san}</z7yx>`).join('');
  const buttons = document.querySelectorAll('button[data-ply]');
  buttons[1].setAttribute('data-ply', history.length ? String(history.length - 1) : '-');
  fixtureBoard.dataset.played = String(history.length);
}
fixtureBoard.addEventListener('mousedown', event => {
  if (!event.isTrusted) { fixtureBoard.dataset.untrusted = 'rejected'; return; }
  const rect = fixtureBoard.getBoundingClientRect();
  const square = String.fromCharCode(97 + Math.floor((event.clientX - rect.left) / 50)) + (8 - Math.floor((event.clientY - rect.top) / 50));
  if (!fixtureFrom) fixtureFrom = square;
  else {
    const move = fixtureGame.move({ from: fixtureFrom, to: square, promotion: 'q' });
    fixtureFrom = null;
    if (move) renderFixture();
  }
});
renderFixture();
