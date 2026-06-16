import json
import os
import sys
from datetime import datetime, timezone, timedelta

try:
    import MetaTrader5 as mt5
except Exception as exc:
    print(json.dumps({"ok": False, "error": f"MetaTrader5 Python package missing: {exc}"}))
    sys.exit(2)


MAGIC = int(os.getenv("MT5_MAGIC", "250601"))
DEVIATION = int(os.getenv("MT5_DEVIATION", "20"))
IST_OFFSET_MINUTES = int(os.getenv("TRADING_TIMEZONE_OFFSET_MINUTES", "330"))
PRICE_MATCH_TOLERANCE = float(os.getenv("MT5_PRICE_MATCH_TOLERANCE", "0.05"))


class PendingLevelReached(RuntimeError):
    def __init__(self, symbol, side, level_price, market_price):
        super().__init__(f"{side} level already reached: level={level_price}, market={market_price}")
        self.symbol = symbol
        self.side = side
        self.level_price = level_price
        self.market_price = market_price


def fail(message, code=1):
    print(json.dumps({"ok": False, "error": message}))
    sys.exit(code)


def init():
    terminal = os.getenv("MT5_TERMINAL_PATH") or None
    ok = mt5.initialize(path=terminal) if terminal else mt5.initialize()
    if not ok:
        fail(f"MT5 initialize failed: {mt5.last_error()}")

    login = os.getenv("MT5_LOGIN")
    password = os.getenv("MT5_PASSWORD")
    server = os.getenv("MT5_SERVER")
    if login and password and server:
        if not mt5.login(int(login), password=password, server=server):
            fail(f"MT5 login failed: {mt5.last_error()}")


def ensure_live_enabled():
    if os.getenv("LIVE_TRADING_ENABLED", "false").lower() != "true":
        raise RuntimeError("LIVE_TRADING_ENABLED must be true before broker orders are sent")


def symbol_candidates(symbol):
    aliases = [s.strip() for s in os.getenv("MT5_SYMBOL_ALIASES", "GOLD.i#,GAUUSD.i#,XAUUSD,XAUUSDm,XAUUSD.,GOLDm").split(",") if s.strip()]
    values = [symbol] + aliases
    seen = set()
    return [s for s in values if not (s in seen or seen.add(s))]


def resolve_symbol(symbol):
    for candidate in symbol_candidates(symbol):
        info = mt5.symbol_info(candidate)
        if info:
            if not info.visible:
                mt5.symbol_select(candidate, True)
            return candidate

    all_symbols = mt5.symbols_get()
    needle = symbol.upper().replace(".", "").replace("#", "")
    for item in all_symbols or []:
        compact = item.name.upper().replace(".", "").replace("#", "")
        is_gold_cfd = (
            compact.startswith("XAUUSD")
            or compact.startswith("GAUUSD")
            or compact.startswith("GOLDI")
            or compact in ("GOLD", "XAU")
        )
        if compact == needle or is_gold_cfd:
            mt5.symbol_select(item.name, True)
            return item.name
    raise RuntimeError(f"Symbol not found in MT5 Market Watch: {symbol}")


def filling_mode(symbol):
    requested = os.getenv("MT5_FILLING_MODE", "auto").upper()
    if requested == "FOK":
        return mt5.ORDER_FILLING_FOK
    if requested == "RETURN":
        return mt5.ORDER_FILLING_RETURN
    return mt5.ORDER_FILLING_IOC


def filling_modes(symbol):
    requested = os.getenv("MT5_FILLING_MODE", "auto").upper()
    if requested != "AUTO":
        return [filling_mode(symbol)]
    return [mt5.ORDER_FILLING_IOC, mt5.ORDER_FILLING_FOK, mt5.ORDER_FILLING_RETURN]


def deal_price(symbol, side):
    tick_info = mt5.symbol_info_tick(symbol)
    if tick_info is None:
        raise RuntimeError(f"No tick for {symbol}: {mt5.last_error()}")
    return tick_info.ask if side == "BUY" else tick_info.bid


def parse_positive(value, name):
    try:
        number = float(value)
    except (TypeError, ValueError):
        raise RuntimeError(f"{name} is required before broker orders are sent")
    if number <= 0:
        raise RuntimeError(f"{name} must be greater than 0 before broker orders are sent")
    return number


def normalize_price(symbol, price):
    info = mt5.symbol_info(symbol)
    digits = info.digits if info and info.digits is not None else 2
    return round(float(price), digits)


def protective_prices(symbol, side, entry_price, stop_loss, take_profit_points):
    sl = normalize_price(symbol, stop_loss)
    tp_distance = parse_positive(take_profit_points, "Take profit")
    tp = normalize_price(symbol, entry_price + tp_distance if side == "BUY" else entry_price - tp_distance)

    if side == "BUY" and sl >= entry_price:
        raise RuntimeError(f"BUY stop loss must be below market price: sl={sl}, price={entry_price}")
    if side == "SELL" and sl <= entry_price:
        raise RuntimeError(f"SELL stop loss must be above market price: sl={sl}, price={entry_price}")
    if side == "BUY" and tp <= entry_price:
        raise RuntimeError(f"BUY target must be above market price: tp={tp}, price={entry_price}")
    if side == "SELL" and tp >= entry_price:
        raise RuntimeError(f"SELL target must be below market price: tp={tp}, price={entry_price}")

    return sl, tp


def send_market_deal(symbol, side, volume, comment, position=None, stop_loss=None, take_profit_points=None):
    normalized_volume = normalize_volume(symbol, volume)
    is_open = position is None
    if is_open:
        stop_loss = parse_positive(stop_loss, "Stop loss")
        parse_positive(take_profit_points, "Take profit")
    last_error = None
    for _attempt in range(3):
        for fill_mode in filling_modes(symbol):
            price = deal_price(symbol, side)
            request = {
                "action": mt5.TRADE_ACTION_DEAL,
                "symbol": symbol,
                "volume": normalized_volume,
                "type": order_type(side),
                "price": price,
                "deviation": DEVIATION,
                "magic": MAGIC,
                "comment": comment,
                "type_time": mt5.ORDER_TIME_GTC,
                "type_filling": fill_mode,
            }
            if is_open:
                sl, tp = protective_prices(symbol, side, price, stop_loss, take_profit_points)
                request["sl"] = sl
                request["tp"] = tp
            if position is not None:
                request["position"] = position

            result = mt5.order_send(request)
            if result is not None and result.retcode == mt5.TRADE_RETCODE_DONE:
                return result
            last_error = f"{result} / {mt5.last_error()}"
    raise RuntimeError(f"Market order failed after retries: {last_error}")


def normalize_volume(symbol, volume):
    info = mt5.symbol_info(symbol)
    if info is None:
        raise RuntimeError(f"Symbol info missing: {symbol}")
    step = info.volume_step or 0.01
    min_volume = info.volume_min or step
    max_volume = info.volume_max or volume
    normalized = round(round(float(volume) / step) * step, 8)
    return max(min_volume, min(normalized, max_volume))


def tick(symbol):
    real_symbol = resolve_symbol(symbol)
    info = mt5.symbol_info_tick(real_symbol)
    if info is None:
        raise RuntimeError(f"No tick for {real_symbol}: {mt5.last_error()}")
    return {
        "symbol": real_symbol,
        "bid": info.bid,
        "ask": info.ask,
        "last": info.last or (info.bid + info.ask) / 2,
        "time": datetime.fromtimestamp(info.time, timezone.utc).isoformat()
    }


def account():
    info = mt5.account_info()
    if info is None:
        raise RuntimeError(f"No account info: {mt5.last_error()}")
    return {
        "balance": info.balance,
        "equity": info.equity,
        "floatingPnl": info.profit,
        "dailyRealizedPnl": 0
    }


def ist_day_bounds():
    now_utc = datetime.now(timezone.utc)
    shifted = now_utc + timedelta(minutes=IST_OFFSET_MINUTES)
    start_shifted = datetime(shifted.year, shifted.month, shifted.day, tzinfo=timezone.utc)
    start_utc = start_shifted - timedelta(minutes=IST_OFFSET_MINUTES)
    return shifted.date().isoformat(), start_utc, now_utc


def day_range(symbol):
    real_symbol = resolve_symbol(symbol)
    rates = mt5.copy_rates_from_pos(real_symbol, mt5.TIMEFRAME_D1, 0, 1)
    if rates is None or len(rates) == 0:
        raise RuntimeError(f"No D1 candle for {real_symbol}: {mt5.last_error()}")
    row = rates[0]
    day_open = float(row["open"])
    day_high = float(row["high"])
    day_low = float(row["low"])
    if day_open <= 0 or day_high <= 0 or day_low <= 0 or day_high < day_low:
        raise RuntimeError(f"Invalid D1 candle for {real_symbol}: open={day_open}, high={day_high}, low={day_low}")
    day = datetime.fromtimestamp(int(row["time"]), timezone.utc).date().isoformat()
    return {
        "adaptiveHigh": day_high,
        "adaptiveLow": day_low,
        "dayOpen": day_open,
        "day": day
    }


def order_type(side):
    return mt5.ORDER_TYPE_BUY if side == "BUY" else mt5.ORDER_TYPE_SELL


def pending_order_type(side):
    return mt5.ORDER_TYPE_BUY_LIMIT if side == "BUY" else mt5.ORDER_TYPE_SELL_LIMIT


def pending_is_waiting(side, level_price, market_price):
    return (side == "BUY" and level_price < market_price) or (side == "SELL" and level_price > market_price)


def skipped_reached_level(symbol, side, level_price, market_price):
    return {
        "ok": True,
        "skipped": True,
        "reason": f"{side} level already reached: level={level_price}, market={market_price}",
        "price": level_price,
        "symbol": symbol
    }


def level_comment(side, level_index):
    if not level_index:
        return "ag-grid"
    side_code = "B" if side == "BUY" else "S"
    return f"ag-{side_code}-{level_index}"


def legacy_comment(side):
    return f"adaptive-grid-{side}"[:15]


def price_matches(left, right):
    return abs(float(left) - float(right)) <= PRICE_MATCH_TOLERANCE


def existing_pending_order(symbol, side, comment, level_price=None):
    orders = [
        order
        for order in mt5.orders_get(symbol=symbol) or []
        if order.magic == MAGIC and pending_order_side(order) == side
    ]
    if level_price is not None:
        for order in orders:
            if order.comment == comment and price_matches(order.price_open, level_price):
                return order
        for order in orders:
            if price_matches(order.price_open, level_price):
                return order
    for order in orders:
        if order.comment == comment:
            return order
    for order in orders:
        if order.comment == legacy_comment(side):
            return order
    return None


def pending_order_side(order):
    return "BUY" if order.type in (mt5.ORDER_TYPE_BUY_LIMIT, mt5.ORDER_TYPE_BUY_STOP, mt5.ORDER_TYPE_BUY_STOP_LIMIT) else "SELL"


def position_side(position):
    return "BUY" if position.type == mt5.POSITION_TYPE_BUY else "SELL"


def cancel_pending_order(order):
    request = {
        "action": mt5.TRADE_ACTION_REMOVE,
        "order": order.ticket,
        "symbol": order.symbol,
        "magic": MAGIC,
        "comment": "adaptive-grid-cancel",
    }
    result = mt5.order_send(request)
    if result is None or result.retcode != mt5.TRADE_RETCODE_DONE:
        raise RuntimeError(f"Pending cancel failed: {result} / {mt5.last_error()}")
    return result


def send_pending_limit(symbol, side, volume, level_price, comment, stop_loss, take_profit_points):
    normalized_volume = normalize_volume(symbol, volume)
    price = normalize_price(symbol, parse_positive(level_price, "Level price"))
    current_price = deal_price(symbol, side)
    if not pending_is_waiting(side, price, current_price):
        raise PendingLevelReached(symbol, side, price, current_price)
    sl = parse_positive(stop_loss, "Stop loss")
    parse_positive(take_profit_points, "Take profit")
    sl, tp = protective_prices(symbol, side, price, sl, take_profit_points)

    request = {
        "action": mt5.TRADE_ACTION_PENDING,
        "symbol": symbol,
        "volume": normalized_volume,
        "type": pending_order_type(side),
        "price": price,
        "sl": sl,
        "tp": tp,
        "deviation": DEVIATION,
        "magic": MAGIC,
        "comment": comment,
        "type_time": mt5.ORDER_TIME_GTC,
        "type_filling": filling_mode(symbol),
    }
    result = mt5.order_send(request)
    placed_retcode = getattr(mt5, "TRADE_RETCODE_PLACED", mt5.TRADE_RETCODE_DONE)
    invalid_price_retcode = getattr(mt5, "TRADE_RETCODE_INVALID_PRICE", 10015)
    if result is not None and result.retcode == invalid_price_retcode:
        raise PendingLevelReached(symbol, side, price, deal_price(symbol, side))
    if result is None or result.retcode not in (mt5.TRADE_RETCODE_DONE, placed_retcode):
        raise RuntimeError(f"Pending order failed: {result} / {mt5.last_error()}")
    return result


def modify_pending_order(order, symbol, level_price, stop_loss, take_profit_points):
    price = normalize_price(symbol, parse_positive(level_price, "Level price"))
    sl, tp = protective_prices(symbol, pending_order_side(order), price, stop_loss, take_profit_points)
    request = {
        "action": mt5.TRADE_ACTION_MODIFY,
        "order": order.ticket,
        "symbol": symbol,
        "price": price,
        "sl": sl,
        "tp": tp,
        "magic": MAGIC,
        "comment": order.comment,
        "type_time": mt5.ORDER_TIME_GTC,
    }
    result = mt5.order_send(request)
    if result is None or result.retcode != mt5.TRADE_RETCODE_DONE:
        raise RuntimeError(f"Pending order modify failed: {result} / {mt5.last_error()}")
    return result, sl, tp


def replace_pending_order(symbol, side, level_index, current_level_price, next_level_price=None, volume=None, stop_loss=None, take_profit_points=None):
    ensure_live_enabled()
    real_symbol = resolve_symbol(symbol)
    comment = level_comment(side, level_index)
    if volume is None:
        volume = next_level_price
        next_level_price = current_level_price
    pending = existing_pending_order(real_symbol, side, comment, current_level_price)
    if pending is None:
        raise RuntimeError(f"Pending order not found for {side} leg {level_index}")

    normalized_volume = normalize_volume(real_symbol, volume)
    next_price = normalize_price(real_symbol, parse_positive(next_level_price, "Level price"))
    next_sl = stop_loss if stop_loss is not None else pending.sl
    if take_profit_points is None:
        take_profit_points = abs(float(pending.price_open) - float(pending.tp))
    desired_sl, desired_tp = protective_prices(real_symbol, side, next_price, next_sl, take_profit_points)

    same_volume = abs(float(pending.volume_current) - normalized_volume) < 1e-8
    if same_volume and price_matches(pending.price_open, next_price) and price_matches(pending.sl, desired_sl) and price_matches(pending.tp, desired_tp):
        return {
            "ok": True,
            "skipped": True,
            "pending": True,
            "brokerOrderId": str(pending.ticket),
            "price": pending.price_open,
            "volume": pending.volume_current,
            "symbol": real_symbol
        }
    if same_volume:
        _result, _sl, _tp = modify_pending_order(pending, real_symbol, next_price, next_sl, take_profit_points)
        return {
            "ok": True,
            "pending": True,
            "brokerOrderId": str(pending.ticket),
            "price": next_price,
            "volume": normalized_volume,
            "symbol": real_symbol
        }

    old_volume = pending.volume_current
    price = pending.price_open
    old_stop_loss = pending.sl
    old_take_profit_points = abs(float(pending.price_open) - float(pending.tp))
    cancel_pending_order(pending)
    try:
        result = send_pending_limit(
            real_symbol,
            side,
            normalized_volume,
            next_price,
            comment,
            next_sl,
            take_profit_points
        )
    except Exception as replacement_error:
        try:
            send_pending_limit(
                real_symbol,
                side,
                old_volume,
                price,
                comment,
                old_stop_loss,
                old_take_profit_points
            )
        except Exception as rollback_error:
            raise RuntimeError(
                f"Pending lot update failed and rollback failed: update={replacement_error}; rollback={rollback_error}"
            )
        raise RuntimeError(f"Pending lot update failed; original order restored: {replacement_error}")

    return {
        "ok": True,
        "pending": True,
        "brokerOrderId": str(result.order),
        "price": next_price,
        "volume": normalized_volume,
        "symbol": real_symbol
    }


def update_position_protection(symbol, side, level_index, level_price, stop_loss, take_profit_points):
    ensure_live_enabled()
    real_symbol = resolve_symbol(symbol)
    comment = level_comment(side, level_index)
    normalized_level = normalize_price(real_symbol, parse_positive(level_price, "Level price"))
    updated = []
    positions = mt5.positions_get(symbol=real_symbol)
    if positions is None:
        raise RuntimeError(f"Could not read positions: {mt5.last_error()}")
    for pos in positions:
        if pos.magic != MAGIC or position_side(pos) != side:
            continue
        if pos.comment != comment and pos.comment != legacy_comment(side):
            continue
        if not price_matches(pos.price_open, normalized_level):
            continue
        sl, tp = protective_prices(real_symbol, side, pos.price_open, stop_loss, take_profit_points)
        if price_matches(pos.sl, sl) and price_matches(pos.tp, tp):
            updated.append(str(pos.ticket))
            continue
        request = {
            "action": mt5.TRADE_ACTION_SLTP,
            "position": pos.ticket,
            "symbol": real_symbol,
            "sl": sl,
            "tp": tp,
            "magic": MAGIC,
            "comment": comment,
        }
        result = mt5.order_send(request)
        if result is None or result.retcode != mt5.TRADE_RETCODE_DONE:
            raise RuntimeError(f"Position protection update failed: {result} / {mt5.last_error()}")
        updated.append(str(pos.ticket))
    if not updated:
        raise RuntimeError(f"Open position not found for {side} leg {level_index}")
    return {"ok": True, "brokerOrderId": ",".join(updated), "symbol": real_symbol}


def open_order(
    symbol,
    side,
    volume,
    level_index=None,
    level_price=None,
    stop_loss=None,
    take_profit_points=None
):
    ensure_live_enabled()
    real_symbol = resolve_symbol(symbol)
    comment = level_comment(side, level_index)
    normalized_level = None
    if level_price is not None and str(level_price).strip():
        normalized_level = normalize_price(real_symbol, parse_positive(level_price, "Level price"))
    if normalized_level is None:
        return {
            "ok": True,
            "skipped": True,
            "reason": "Entry skipped because level price is required; market entry orders are disabled",
            "symbol": real_symbol
        }
    for pos in mt5.positions_get(symbol=real_symbol) or []:
        if (
            pos.magic == MAGIC
            and position_side(pos) == side
            and (pos.comment == comment or pos.comment == legacy_comment(side))
            and price_matches(pos.price_open, normalized_level)
        ):
            return {
                "ok": True,
                "skipped": True,
                "brokerOrderId": str(pos.ticket),
                "price": pos.price_open,
                "symbol": real_symbol
            }

    pending = existing_pending_order(real_symbol, side, comment, normalized_level)
    if pending:
        return {
            "ok": True,
            "skipped": True,
            "pending": True,
            "brokerOrderId": str(pending.ticket),
            "price": pending.price_open,
            "symbol": real_symbol
        }

    current_price = deal_price(real_symbol, side)
    if normalized_level is not None:
        if pending_is_waiting(side, normalized_level, current_price):
            try:
                result = send_pending_limit(real_symbol, side, volume, normalized_level, comment, stop_loss, take_profit_points)
            except PendingLevelReached as reached:
                return skipped_reached_level(real_symbol, side, reached.level_price, reached.market_price)
            return {"ok": True, "pending": True, "brokerOrderId": str(result.order), "price": normalized_level, "symbol": real_symbol}
        return skipped_reached_level(real_symbol, side, normalized_level, current_price)

    return {
        "ok": True,
        "skipped": True,
        "reason": "Entry skipped because market entry orders are disabled",
        "symbol": real_symbol
    }


def open_market_order(symbol, side, volume, level_index=None, level_price=None, stop_loss=None, take_profit_points=None):
    ensure_live_enabled()
    real_symbol = resolve_symbol(symbol)
    comment = level_comment(side, level_index)
    normalized_level = None
    if level_price is not None and str(level_price).strip():
        normalized_level = normalize_price(real_symbol, parse_positive(level_price, "Level price"))

    for pos in mt5.positions_get(symbol=real_symbol) or []:
        if (
            pos.magic == MAGIC
            and position_side(pos) == side
            and (pos.comment == comment or pos.comment == legacy_comment(side))
            and (normalized_level is None or price_matches(pos.price_open, normalized_level))
        ):
            return {
                "ok": True,
                "skipped": True,
                "brokerOrderId": str(pos.ticket),
                "price": pos.price_open,
                "volume": pos.volume,
                "symbol": real_symbol
            }

    pending = existing_pending_order(real_symbol, side, comment, normalized_level)
    if pending:
        return {
            "ok": True,
            "skipped": True,
            "pending": True,
            "brokerOrderId": str(pending.ticket),
            "price": pending.price_open,
            "volume": pending.volume_current,
            "symbol": real_symbol
        }

    result = send_market_deal(real_symbol, side, volume, comment, None, stop_loss, take_profit_points)
    return {
        "ok": True,
        "pending": False,
        "brokerOrderId": str(result.order),
        "price": result.price,
        "volume": result.volume,
        "symbol": real_symbol
    }


def close_order(symbol, side=None, volume=None, level_index=None, level_price=None):
    ensure_live_enabled()
    real_symbol = resolve_symbol(symbol)
    closed = []
    normalized_level = None
    if level_price is not None and str(level_price).strip():
        normalized_level = normalize_price(real_symbol, parse_positive(level_price, "Level price"))
    pending_orders = mt5.orders_get(symbol=real_symbol)
    if pending_orders is None:
        raise RuntimeError(f"Could not read pending orders: {mt5.last_error()}")
    for order in pending_orders:
        order_side = pending_order_side(order)
        expected_comment = level_comment(order_side, level_index) if level_index else None
        if order.magic != MAGIC:
            continue
        if side and order_side != side:
            continue
        if expected_comment:
            comment_matches = order.comment == expected_comment or order.comment == legacy_comment(order_side)
            level_matches = normalized_level is not None and price_matches(order.price_open, normalized_level)
            if not ((comment_matches and (normalized_level is None or level_matches)) or level_matches):
                continue
        elif normalized_level is not None and not price_matches(order.price_open, normalized_level):
            continue
        result = cancel_pending_order(order)
        closed.append(str(result.order or order.ticket))
        if level_index or volume:
            break

    positions = mt5.positions_get(symbol=real_symbol)
    if positions is None:
        raise RuntimeError(f"Could not read positions: {mt5.last_error()}")
    for pos in positions:
        pos_side = position_side(pos)
        if side and pos_side != side:
            continue
        expected_comment = level_comment(pos_side, level_index) if level_index else None
        if expected_comment:
            comment_matches = pos.comment == expected_comment or pos.comment == legacy_comment(pos_side)
            level_matches = normalized_level is not None and price_matches(pos.price_open, normalized_level)
            if not (comment_matches and (normalized_level is None or level_matches)):
                continue
        elif normalized_level is not None and not price_matches(pos.price_open, normalized_level):
            continue
        close_side = "SELL" if pos_side == "BUY" else "BUY"
        close_volume = normalize_volume(real_symbol, min(float(volume or pos.volume), pos.volume))
        try:
            result = send_market_deal(real_symbol, close_side, close_volume, "adaptive-grid-close", pos.ticket)
        except RuntimeError:
            remaining = mt5.positions_get(ticket=pos.ticket)
            if remaining is not None and len(remaining) == 0:
                closed.append(str(pos.ticket))
                if volume:
                    break
                continue
            raise
        closed.append(str(result.order))
        if volume:
            break
    return {"ok": True, "brokerOrderId": ",".join(closed), "symbol": real_symbol}


def parse_bool(value):
    return str(value).strip().lower() in ("1", "true", "yes", "y", "on")


def clear_orders(symbol, clear_pending=True, clear_positions=True):
    ensure_live_enabled()
    real_symbol = resolve_symbol(symbol)
    closed = []

    if parse_bool(clear_pending):
        pending_orders = mt5.orders_get(symbol=real_symbol)
        if pending_orders is None:
            raise RuntimeError(f"Could not read pending orders: {mt5.last_error()}")
        for order in pending_orders:
            if order.magic != MAGIC:
                continue
            result = cancel_pending_order(order)
            closed.append(str(result.order or order.ticket))

    if parse_bool(clear_positions):
        positions = mt5.positions_get(symbol=real_symbol)
        if positions is None:
            raise RuntimeError(f"Could not read positions: {mt5.last_error()}")
        for pos in positions:
            if pos.magic != MAGIC:
                continue
            close_side = "SELL" if position_side(pos) == "BUY" else "BUY"
            result = send_market_deal(real_symbol, close_side, pos.volume, "adaptive-grid-close", pos.ticket)
            closed.append(str(result.order))

    return {"ok": True, "brokerOrderId": ",".join(closed), "symbol": real_symbol}


def symbols():
    rows = []
    for item in mt5.symbols_get() or []:
        name = item.name.upper()
        if "XAU" in name or "GOLD" in name or "USD" in name:
            rows.append(item.name)
    return {"ok": True, "symbols": rows[:300]}


def positions(symbol):
    real_symbol = resolve_symbol(symbol)
    rows = []
    tick_info = mt5.symbol_info_tick(real_symbol)
    bid = tick_info.bid if tick_info else None
    ask = tick_info.ask if tick_info else None
    for pos in mt5.positions_get(symbol=real_symbol) or []:
        if pos.magic != MAGIC:
            continue
        side = "BUY" if pos.type == mt5.POSITION_TYPE_BUY else "SELL"
        current_price = bid if side == "BUY" else ask
        rows.append({
            "brokerOrderId": str(pos.ticket),
            "symbol": real_symbol,
            "side": side,
            "volume": pos.volume,
            "entryPrice": pos.price_open,
            "currentPrice": current_price,
            "stopLoss": pos.sl,
            "takeProfit": pos.tp,
            "profit": pos.profit,
            "swap": pos.swap,
            "comment": pos.comment,
            "openedAt": datetime.fromtimestamp(pos.time, timezone.utc).isoformat() if pos.time else None
        })
    return rows


def pending_orders(symbol):
    real_symbol = resolve_symbol(symbol)
    rows = []
    for order in mt5.orders_get(symbol=real_symbol) or []:
        if order.magic != MAGIC:
            continue
        rows.append({
            "brokerOrderId": str(order.ticket),
            "symbol": real_symbol,
            "side": pending_order_side(order),
            "volume": order.volume_current,
            "price": order.price_open,
            "stopLoss": order.sl,
            "takeProfit": order.tp,
            "orderType": str(order.type),
            "comment": order.comment,
            "placedAt": datetime.fromtimestamp(order.time_setup, timezone.utc).isoformat() if order.time_setup else None
        })
    return rows


def live_snapshot(symbol):
    return {
        "tick": tick(symbol),
        "account": account(),
        "market": day_range(symbol),
        "positions": positions(symbol),
        "pendingOrders": pending_orders(symbol)
    }


def dispatch(args):
    cmd = args[0]
    if cmd == "tick":
        return tick(args[1])
    if cmd == "account":
        return account()
    if cmd == "day_range":
        return day_range(args[1])
    if cmd == "open":
        return open_order(
            args[1],
            args[2],
            args[3],
            args[4] if len(args) > 4 else None,
            args[5] if len(args) > 5 else None,
            args[6] if len(args) > 6 else None,
            args[7] if len(args) > 7 else None
        )
    if cmd == "open_market":
        return open_market_order(
            args[1],
            args[2],
            args[3],
            args[4] if len(args) > 4 else None,
            args[5] if len(args) > 5 else None,
            args[6] if len(args) > 6 else None,
            args[7] if len(args) > 7 else None
        )
    if cmd == "close":
        return close_order(
            args[1],
            args[2] if len(args) > 2 else None,
            args[3] if len(args) > 3 else None,
            args[4] if len(args) > 4 else None,
            args[5] if len(args) > 5 else None
        )
    if cmd == "clear":
        return clear_orders(
            args[1],
            args[2] if len(args) > 2 else True,
            args[3] if len(args) > 3 else True
        )
    if cmd == "symbols":
        return symbols()
    if cmd == "positions":
        return positions(args[1])
    if cmd == "pending_orders":
        return pending_orders(args[1])
    if cmd == "replace_pending":
        return replace_pending_order(
            args[1],
            args[2],
            args[3],
            args[4],
            args[5] if len(args) > 5 else None,
            args[6] if len(args) > 6 else None,
            args[7] if len(args) > 7 else None,
            args[8] if len(args) > 8 else None
        )
    if cmd == "update_position_protection":
        return update_position_protection(args[1], args[2], args[3], args[4], args[5], args[6])
    if cmd == "live_snapshot":
        return live_snapshot(args[1])
    raise RuntimeError(f"Unknown command: {cmd}")


def serve():
    for line in sys.stdin:
        try:
            msg = json.loads(line)
            response = {"id": msg.get("id"), "ok": True, "data": dispatch(msg.get("args", []))}
        except Exception as exc:
            response = {"id": msg.get("id") if "msg" in locals() else None, "ok": False, "error": str(exc)}
        print(json.dumps(response), flush=True)


def main():
    init()
    if len(sys.argv) > 1 and sys.argv[1] == "serve":
        serve()
        return
    try:
        print(json.dumps(dispatch(sys.argv[1:])))
    except Exception as exc:
        fail(str(exc))


if __name__ == "__main__":
    main()
