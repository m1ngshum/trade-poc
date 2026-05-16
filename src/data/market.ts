import * as ccxt from "ccxt";
import { CONFIG } from "../config.js";

export interface Candle {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface TickerSnapshot {
  symbol: string;
  last: number;
  midPrice: number;
  quoteVolume24h: number;
}

type ExchangeCls = new (opts?: Record<string, unknown>) => InstanceType<typeof ccxt.Exchange>;

function makeExchange(): InstanceType<typeof ccxt.Exchange> {
  const id = CONFIG.EXCHANGE;
  const Cls = (ccxt as unknown as Record<string, ExchangeCls>)[id];
  if (!Cls) throw new Error(`unsupported exchange: ${id}`);
  return new Cls({ enableRateLimit: true });
}

const exchange = makeExchange();

export async function fetchOHLCV(symbol: string, limit = 250): Promise<Candle[]> {
  const rows = await exchange.fetchOHLCV(symbol, CONFIG.TIMEFRAME, undefined, limit);
  return rows.map((r: (number | undefined)[]) => ({
    timestamp: Number(r[0]),
    open: Number(r[1]),
    high: Number(r[2]),
    low: Number(r[3]),
    close: Number(r[4]),
    volume: Number(r[5]),
  }));
}

export async function fetchTicker(symbol: string): Promise<TickerSnapshot> {
  const t = await exchange.fetchTicker(symbol);
  const last = Number(t.last ?? t.close ?? 0);
  if (!Number.isFinite(last) || last <= 0) {
    throw new Error(`fetchTicker(${symbol}): invalid last price ${t.last}`);
  }
  const bid = Number(t.bid ?? last);
  const ask = Number(t.ask ?? last);
  const midPrice = (bid > 0 && ask > 0) ? (bid + ask) / 2 : last;
  return {
    symbol,
    last,
    midPrice,
    quoteVolume24h: Number(t.quoteVolume ?? 0),
  };
}
