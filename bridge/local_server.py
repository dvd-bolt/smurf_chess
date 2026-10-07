"""Local, bounded UCI bridge for Chess Sensei (standard library only)."""
import json
import os
import queue
import re
import subprocess
import sys
import threading
import time
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from pathlib import Path

DEFAULT_PATHS = [
    Path(__file__).resolve().parent / 'stockfish.exe',
    Path(r'C:\Users\dvd\Desktop\Projects\chess\stockfish\stockfish.exe'),
    Path(r'C:\Users\dvd\Desktop\Projects\stockfish\src\stockfish.exe'),
]
STOCKFISH_PATH = os.environ.get('STOCKFISH_PATH') or next((str(p) for p in DEFAULT_PATHS if p.is_file()), 'stockfish')


def validate_request(req):
    if not isinstance(req, dict):
        raise ValueError('Expected a JSON object')
    fen = req.get('fen', '')
    if not isinstance(fen, str) or len(fen) > 128:
        raise ValueError('Invalid FEN')
    parts = fen.split()
    if len(parts) != 6 or '\n' in fen or '\r' in fen:
        raise ValueError('Expected a full FEN')
    ranks = parts[0].split('/')
    if len(ranks) != 8 or any(not re.fullmatch(r'[prnbqkPRNBQK1-8]+', rank) or
                            sum(int(c) if c.isdigit() else 1 for c in rank) != 8 for rank in ranks):
        raise ValueError('Invalid board')
    if parts[0].count('K') != 1 or parts[0].count('k') != 1:
        raise ValueError('Expected two kings')
    if parts[1] not in ('w', 'b') or not re.fullmatch(r'-|K?Q?k?q?', parts[2]):
        raise ValueError('Invalid turn or castling rights')
    if not re.fullmatch(r'-|[a-h][36]', parts[3]) or not parts[4].isdigit() or not parts[5].isdigit() or int(parts[5]) < 1:
        raise ValueError('Invalid FEN counters or en passant')
    limits = {'depth': (1, 24, 12), 'multipv': (1, 8, 3), 'movetime': (50, 3000, 600)}
    values = {}
    for key, (low, high, default) in limits.items():
        value = req.get(key, default)
        if isinstance(value, bool) or not isinstance(value, int) or not low <= value <= high:
            raise ValueError(f'{key} must be an integer in {low}..{high}')
        values[key] = value
    roots = req.get('searchmoves', [])
    if not isinstance(roots, list) or len(roots) > 8 or any(not isinstance(move, str) or not re.fullmatch(r'[a-h][1-8][a-h][1-8][qrbn]?', move) for move in roots):
        raise ValueError('Invalid searchmoves')
    values['searchmoves'] = roots
    rating = req.get('ratingElo')
    if rating is not None and (isinstance(rating, bool) or not isinstance(rating, int) or not 800 <= rating <= 3200):
        raise ValueError('ratingElo must be an integer in 800..3200')
    values['ratingElo'] = rating
    new_game = req.get('newGame', False)
    if not isinstance(new_game, bool):
        raise ValueError('newGame must be a boolean')
    values['newGame'] = new_game
    return ' '.join(parts), values


class StockfishRunner:
    def __init__(self, executable_path):
        self.path = executable_path
        self.lock = threading.Lock()
        self.process = None
        self.output = None
        self.start_engine()

    def start_engine(self):
        self.close()
        self.options = {}
        self.engine_name = 'Native Stockfish'
        try:
            self.process = subprocess.Popen([self.path], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL, text=True, bufsize=1, encoding='utf-8',
                creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
            self.output = queue.Queue()
            def read_output(process, output):
                try:
                    for line in process.stdout:
                        output.put(line.strip())
                finally:
                    output.put(None)
            threading.Thread(target=read_output, args=(self.process, self.output), daemon=True).start()
            self._send('uci')
            self._until('uciok', 10)
            self._send('setoption name Threads value 4')
            self._send('setoption name Hash value 64')
            self._send('isready')
            self._until('readyok', 10)
        except Exception:
            self.close()

    def close(self):
        if self.process:
            if self.process.poll() is None:
                self.process.kill()
            self.process.wait(timeout=2)
            if self.process.stdin:
                self.process.stdin.close()
            if self.process.stdout:
                self.process.stdout.close()
        self.process = None

    def _send(self, command):
        if not self.process or self.process.poll() is not None:
            raise RuntimeError('Stockfish is unavailable')
        self.process.stdin.write(command + '\n')
        self.process.stdin.flush()

    def _line(self, deadline):
        try:
            line = self.output.get(timeout=max(0.001, deadline - time.monotonic()))
        except queue.Empty:
            raise TimeoutError('Stockfish timed out')
        if line is None:
            raise RuntimeError('Stockfish exited')
        return line

    def _until(self, expected, timeout):
        deadline = time.monotonic() + timeout
        while True:
            line = self._line(deadline)
            if line == expected:
                return
            if line.startswith('id name '):
                self.engine_name = line[8:]
            option = re.match(r'option name (.+?) type (\w+)(.*)', line)
            if option:
                bounds = re.search(r'\bmin (-?\d+) max (-?\d+)', option[3])
                self.options[option[1]] = (int(bounds[1]), int(bounds[2])) if bounds else None
            if time.monotonic() >= deadline:
                raise TimeoutError('Stockfish initialization timed out')

    def analyze(self, fen, depth=12, multipv=3, movetime=600, searchmoves=None, ratingElo=None, newGame=False):
        if not self.lock.acquire(timeout=5):
            raise TimeoutError('Stockfish is busy')
        try:
            if not self.process or self.process.poll() is not None:
                raise RuntimeError('Stockfish is unavailable; restart the bridge')
            if newGame:
                self._send('ucinewgame')
            rating_supported = 'UCI_Elo' in self.options and 'UCI_LimitStrength' in self.options
            if ratingElo is not None and not rating_supported:
                raise RuntimeError('This engine does not support rating limits')
            if 'UCI_LimitStrength' in self.options:
                self._send('setoption name UCI_LimitStrength value ' + ('true' if ratingElo is not None else 'false'))
            if 'Skill Level' in self.options:
                self._send('setoption name Skill Level value 20')
            applied_elo = None
            if ratingElo is not None:
                low, high = self.options['UCI_Elo']
                applied_elo = max(low, min(high, ratingElo))
                self._send(f'setoption name UCI_Elo value {applied_elo}')
            self._send(f'setoption name MultiPV value {multipv}')
            self._send(f'position fen {fen}')
            roots = ' searchmoves ' + ' '.join(searchmoves) if searchmoves else ''
            self._send(f'go depth {depth} movetime {movetime}' + roots)
            lines = {}
            deadline = time.monotonic() + movetime / 1000 + 2
            while True:
                line = self._line(deadline)
                if line.startswith('bestmove '):
                    return {'lines': [lines[k] for k in sorted(lines)], 'bestmove': line.split()[1],
                        'engineName': self.engine_name, 'ratingSupported': rating_supported, 'appliedElo': applied_elo}
                if not line.startswith('info ') or 'lowerbound' in line or 'upperbound' in line:
                    continue
                score = re.search(r'\bscore\s+(cp|mate)\s+(-?\d+)', line)
                pv = re.search(r'\bpv\s+(.+)$', line)
                if score and pv:
                    mp = re.search(r'\bmultipv\s+(\d+)', line)
                    number = int(mp.group(1)) if mp else 1
                    moves = pv.group(1).split()
                    dep = re.search(r'\bdepth\s+(\d+)', line)
                    lines[number] = {'multipv': number, 'depth': int(dep.group(1)) if dep else 0,
                        'score': {'unit': score.group(1), 'value': int(score.group(2))}, 'uci': moves[0], 'pv': moves}
        except Exception:
            # A timed out process is never reused: late output cannot reach a new request.
            self.close()
            raise
        finally:
            self.lock.release()


class BridgeHandler(BaseHTTPRequestHandler):
    def respond(self, status, data):
        body = json.dumps(data).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def do_OPTIONS(self):
        self.respond(200, {})

    def do_GET(self):
        if self.path != '/health':
            return self.respond(404, {'error': 'Not found'})
        process = self.server.runner.process
        self.respond(200, {'status': 'ok', 'engine': STOCKFISH_PATH,
            'is_active': bool(process and process.poll() is None)})

    def do_POST(self):
        if self.path != '/analyze':
            return self.respond(404, {'error': 'Not found'})
        try:
            length = int(self.headers.get('Content-Length', '0'))
            if not 0 < length <= 8192:
                raise ValueError('Invalid request size')
            self.connection.settimeout(5)
            fen, options = validate_request(json.loads(self.rfile.read(length).decode('utf-8')))
        except (ValueError, UnicodeError, TimeoutError) as error:
            return self.respond(400, {'error': str(error)})
        try:
            self.respond(200, self.server.runner.analyze(fen, **options))
        except Exception as error:
            self.respond(503, {'error': str(error), 'lines': []})

    def log_message(self, *args):
        pass


def run_server(port=5000):
    runner = StockfishRunner(STOCKFISH_PATH)
    server = ThreadingHTTPServer(('127.0.0.1', port), BridgeHandler)
    server.runner = runner
    print(f'Chess Sensei bridge: http://127.0.0.1:{port}; engine: {STOCKFISH_PATH}', flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
        runner.close()


if __name__ == '__main__':
    run_server(int(sys.argv[1]) if len(sys.argv) > 1 else 5000)
