import * as ccxt from "ccxt";
import type { Exchange, OHLCV } from "ccxt";
import { CONFIG } from "../config.js";
import { logger } from "../logger.js";

export interface Candle {
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface Ticker {
  last: number;
  midPrice: number;
  quoteVolume24h: number;
}

type ExchangeCtor = new (opts: object) => Exchange;

let _exchange: Exchange | null = null;

function getExchange(): Exchange {
  if (_exchange) return _exchange;
  const ctor = (ccxt as unknown as Record<string, ExchangeCtor | undefined>)[
    CONFIG.EXCHANGE
  ];
  if (!ctor) {
    throw new Error(
      `Unknown ccxt exchange "${CONFIG.EXCHANGE}". Examples: binance, kraken, coinbase, bybit, okx`,
    );
  }
  _exchange = new ctor({ enableRateLimit: true });
  return _exchange;
}

/**
 * Fetch the most recent `limit` CLOSED candles. The currently-forming candle
 * is dropped so downstream indicators only see settled bars — without this
 * the last row revises itself every few seconds and decisions become unstable.
 */
export async function fetchOHLCV(
  symbol: string,
  timeframe: string = CONFIG.TIMEFRAME,
  limit = 250,
): Promise<Candle[]> {
  const ex = getExchange();
  const raw = await ex.fetchOHLCV(symbol, timeframe, undefined, limit + 1);
  // Drop the still-forming live candle (always the last one returned).
  const closed = raw.slice(0, -1);
  return closed
    .map((row: OHLCV): Candle | null => {
      if (!row || row.length < 6) return null;
      const ts = Number(row[0]);
      const open = Number(row[1]);
      const high = Number(row[2]);
      const low = Number(row[3]);
      const close = Number(row[4]);
      const volume = Number(row[5]);
      if (![ts, open, high, low, close, volume].every((v) => Number.isFinite(v))) {
        return null;
      }
      return { ts, open, high, low, close, volume };
    })
    .filter((c: Candle | null): c is Candle => c !== null);
}

export async function fetchTicker(symbol: string): Promise<Ticker> {
  const ex = getExchange();
  const t = await ex.fetchTicker(symbol);
  const last = Number(t.last ?? t.close ?? 0);
  const bid = Number(t.bid ?? 0);
  const ask = Number(t.ask ?? 0);
  const midPrice =
    bid > 0 && ask > 0 ? (bid + ask) / 2 : last > 0 ? last : 0;
  if (!(midPrice > 0)) {
    throw new Error(`fetchTicker(${symbol}): no usable price`);
  }
  const quoteVolume24h = Number(
    t.quoteVolume ?? (t.baseVolume && last ? Number(t.baseVolume) * last : 0),
  );
  if (!Number.isFinite(quoteVolume24h)) {
    logger.debug(`fetchTicker(${symbol}): non-finite quoteVolume, defaulting to 0`);
  }
  return {
    last,
    midPrice,
    quoteVolume24h: Number.isFinite(quoteVolume24h) ? quoteVolume24h : 0,
  };
}
