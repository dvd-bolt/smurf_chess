import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('bridge', Path(__file__).resolve().parents[1] / 'bridge/local_server.py')
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)
START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'

class BridgeTests(unittest.TestCase):
    def test_valid(self):
        fen, options = bridge.validate_request({'fen': START})
        self.assertEqual(fen, START)
        self.assertEqual(options['movetime'], 600)

    def test_invalid(self):
        for request in [None, {'fen': START + '\nquit'}, {'fen': '8/8/8/8/8/8/8/8 w - - 0 1'},
                        {'fen': START, 'depth': 999}, {'fen': START, 'multipv': 0},
                        {'fen': START, 'movetime': -1}, {'fen': START, 'depth': True},
                        {'fen': START, 'searchmoves': ['e2e4\nquit']}, {'fen': START, 'searchmoves': 'e2e4'},
                        {'fen': START, 'ratingElo': True}, {'fen': START, 'ratingElo': 99999},
                        {'fen': START, 'ratingElo': '1000'}, {'fen': START, 'ratingElo': 1000.5}]:
            with self.subTest(request=request), self.assertRaises(ValueError):
                bridge.validate_request(request)
    def test_human_candidates(self):
        _, options = bridge.validate_request({'fen': START, 'multipv': 8, 'searchmoves': ['a2a3']})
        self.assertEqual(options['multipv'], 8)
        self.assertEqual(options['searchmoves'], ['a2a3'])

    def test_rating_request(self):
        _, options = bridge.validate_request({'fen': START, 'ratingElo': 1535})
        self.assertEqual(options['ratingElo'], 1535)
        _, options = bridge.validate_request({'fen': START})
        self.assertIsNone(options['ratingElo'])

    @unittest.skipUnless(Path(bridge.STOCKFISH_PATH).is_file(), 'Native Stockfish not installed')
    def test_real_rating_and_reset(self):
        runner = bridge.StockfishRunner(bridge.STOCKFISH_PATH)
        try:
            limited = runner.analyze(START, depth=12, movetime=100, multipv=4, ratingElo=1535)
            self.assertTrue(limited['ratingSupported'])
            self.assertEqual(limited['appliedElo'], 1535)
            self.assertRegex(limited['bestmove'], r'^[a-h][1-8][a-h][1-8][qrbn]?$')
            unlimited = runner.analyze(START, depth=10, movetime=100, multipv=1)
            self.assertIsNone(unlimited['appliedElo'])
            self.assertTrue(unlimited['lines'])
        finally:
            runner.close()

if __name__ == '__main__':
    unittest.main()
