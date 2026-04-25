import { EventEmitter } from "node:events";
import type { MarketStatePacket, Intent } from "./agent/schema.js";
import type { BrainResult } from "./agent/brain.js";
import type { Trade } from "./exchange/paper.js";
import type { Verdict } from "./risk/engine.js";

export interface CycleSnapshot {
  cycleStart: number;
  nextCycleAt: number;
  symbol: string;
  packet: MarketStatePacket;
  intent: Intent;
  brain: BrainResult;
  verdict: Verdict;
  rejectReason?: string;
  fillPrice?: number;
  equityAfter: number;
  trade: Trade | null;
  recentTrades: Trade[];
}

export interface Snapshot {
  startedAt: number;
  cycleNumber: number;
  lastError?: string;
  lastCycle?: CycleSnapshot;
}

export const bus = new EventEmitter();
export const SNAPSHOT: Snapshot = {
  startedAt: Date.now(),
  cycleNumber: 0,
};
