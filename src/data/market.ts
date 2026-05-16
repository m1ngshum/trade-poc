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

function safeNumber(v: unknown, fallback = 0): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

let _exchange: InstanceType<typeof ccxt.Exchange> | null = null;

function getExchange(): InstanceType<typeof ccxt.Exchange> {
  if (_exchange) return _exchange;
  const id = CONFIG.EXCHANGE;
  const Cls = (ccxt as unknown as Record<string, ExchangeCls>)[id];
  if (!Cls) throw new Error(`unsupported exchange: ${id}`);
  _exchange = new Cls({ enableRateLimit: true });
  return _exchange;
}

export async function fetchOHLCV(symbol: string, limit = 250): Promise<Candle[]> {
  const rows = await getExchange().fetchOHLCV(symbol, CONFIG.TIMEFRAME, undefined, limit);
  return rows.map((r: (number | undefined)[]) => {
    const close = safeNumber(r[4]);
    return {
      timestamp: safeNumber(r[0]),
      open: safeNumber(r[1], close),
      high: safeNumber(r[2], close),
      low: safeNumber(r[3], close),
      close,
      volume: safeNumber(r[5]),
    };
  });
}

export async function fetchTicker(symbol: string): Promise<TickerSnapshot> {
  const t = await getExchange().fetchTicker(symbol);
  const last = safeNumber(t.last ?? t.close);
  if (last <= 0) {
    throw new Error(`fetchTicker(${symbol}): invalid last price ${t.last}`);
  }
  const bid = safeNumber(t.bid, last);
  const ask = safeNumber(t.ask, last);
  const midPrice = (bid > 0 && ask > 0) ? (bid + ask) / 2 : last;
  return {
    symbol,
    last,
    midPrice,
    quoteVolume24h: safeNumber(t.quoteVolume),
  };
}
