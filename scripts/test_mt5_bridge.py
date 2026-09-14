import importlib.util
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

# No terminal connection or broker orders are allowed in these tests.
fake_mt5 = SimpleNamespace(POSITION_TYPE_BUY=0, ORDER_TYPE_BUY_LIMIT=2,
                          ORDER_TYPE_BUY_STOP=4, ORDER_TYPE_BUY_STOP_LIMIT=6)
spec = importlib.util.spec_from_file_location("bridge_under_test", Path(__file__).with_name("mt5_bridge.py"))
bridge = importlib.util.module_from_spec(spec)
with patch.dict(sys.modules, {"MetaTrader5": fake_mt5}):
    spec.loader.exec_module(bridge)


class TakeProfitTests(unittest.TestCase):
    def test_points_and_percentage_targets_for_both_sides(self):
        with patch.object(bridge, "normalize_price", side_effect=lambda s, p: round(float(p), 2)):
            for side, stop, target in [("BUY", 4200, 4404.4), ("SELL", 4600, 4395.6)]:
                self.assertEqual(bridge.protective_prices("GOLD", side, 4400, stop, "0.1%"), (stop, target))
            self.assertEqual(bridge.protective_prices("GOLD", "BUY", 4400, 4200, 5), (4200, 4405))
            self.assertEqual(bridge.protective_prices("GOLD", "BUY", 4500, 4200, "0.1%")[1], 4504.5)


class DuplicateProtectionTests(unittest.TestCase):
    def setUp(self):
        self.pos = SimpleNamespace(ticket=2310297631, identifier=2310297631,
                                   symbol="GOLD.i#", magic=bridge.MAGIC, type=0,
                                   comment="ag-B-3", price_open=4346.03, volume=0.01)
        fake_mt5.positions_get = Mock(return_value=[self.pos])
        fake_mt5.orders_get = Mock(return_value=[])
        fake_mt5.history_orders_get = Mock(return_value=[SimpleNamespace(
            symbol="GOLD.i#", magic=bridge.MAGIC, price_open=4346.1)])
        fake_mt5.last_error = Mock(return_value="test error")
        fake_mt5.order_send = Mock(side_effect=AssertionError("No orders allowed"))

    def test_slipped_fill_blocks_duplicate_pending_and_market_entries(self):
        with patch.object(bridge, "ensure_live_enabled"), patch.object(bridge, "resolve_symbol", return_value="GOLD.i#"), patch.object(bridge, "normalize_price", side_effect=lambda s, p: float(p)):
            for opener in (bridge.open_order, bridge.open_market_order):
                result = opener("GOLD.i#", "BUY", 0.01, 3, 4346.1, 4200, 5)
                self.assertTrue(result["skipped"])
                self.assertEqual(result["brokerOrderId"], "2310297631")
        fake_mt5.order_send.assert_not_called()

    def test_different_grid_price_with_same_comment_remains_distinct(self):
        self.assertIsNone(bridge.existing_position("GOLD.i#", "BUY", "ag-B-3", 4340))

    def test_failed_reads_are_not_empty_accounts(self):
        fake_mt5.positions_get.return_value = None
        with self.assertRaisesRegex(RuntimeError, "Could not read positions"):
            bridge.read_positions("GOLD.i#")
        fake_mt5.orders_get.return_value = None
        with self.assertRaisesRegex(RuntimeError, "Could not read pending"):
            bridge.existing_pending_order("GOLD.i#", "BUY", "ag-B-3", 4346.1)

    def test_missing_history_blocks_entry_instead_of_guessing(self):
        for history in (None, []):
            fake_mt5.history_orders_get.return_value = history
            with self.assertRaises(RuntimeError):
                bridge.existing_position("GOLD.i#", "BUY", "ag-B-3", 4346.1)

    def test_snapshot_reads_pending_before_positions_to_cover_fill_transition(self):
        calls = []
        with patch.object(bridge, "pending_orders", side_effect=lambda s: calls.append("pending") or []), patch.object(bridge, "positions", side_effect=lambda s: calls.append("positions") or [self.pos]), patch.object(bridge, "tick"), patch.object(bridge, "account"), patch.object(bridge, "day_range"):
            snapshot = bridge.live_snapshot("GOLD.i#")
        self.assertEqual(calls, ["pending", "positions"])
        self.assertEqual(snapshot["positions"], [self.pos])

    def test_daily_extremes_use_current_and_previous_completed_candles(self):
        fake_mt5.TIMEFRAME_D1 = 1440
        fake_mt5.copy_rates_from_pos = Mock(return_value=[
            {"time": 1789084800, "open": 4330, "high": 4350, "low": 4300},
            {"time": 1789171200, "open": 4340, "high": 4352, "low": 4298}
        ])
        with patch.object(bridge, "resolve_symbol", return_value="GOLD.i#"):
            market = bridge.day_range("GOLD.i#")
        self.assertEqual(market["todayHigh"], 4352)
        self.assertEqual(market["todayLow"], 4298)
        self.assertEqual(market["previousDayHigh"], 4350)
        self.assertEqual(market["previousDayLow"], 4300)
        fake_mt5.copy_rates_from_pos.assert_called_once_with("GOLD.i#", 1440, 0, 2)

    def test_absent_previous_candle_does_not_substitute_today(self):
        fake_mt5.TIMEFRAME_D1 = 1440
        fake_mt5.copy_rates_from_pos = Mock(return_value=[
            {"time": 1789171200, "open": 4340, "high": 4352, "low": 4298}
        ])
        with patch.object(bridge, "resolve_symbol", return_value="GOLD.i#"):
            market = bridge.day_range("GOLD.i#")
        self.assertIsNone(market["previousDayHigh"])
        self.assertIsNone(market["previousDayLow"])

    def test_breakout_cancel_cannot_close_a_filled_position(self):
        with patch.object(bridge, "ensure_live_enabled"), patch.object(bridge, "resolve_symbol", return_value="GOLD.i#"):
            result = bridge.cancel_pending_ticket("GOLD.i#", self.pos.ticket)
        self.assertTrue(result["skipped"])
        fake_mt5.order_send.assert_not_called()


if __name__ == "__main__":
    unittest.main()
