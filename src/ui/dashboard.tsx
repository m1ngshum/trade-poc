import React, { useEffect, useState } from "react";
import { Box, render, Text, useApp, useInput } from "ink";
import { CONFIG } from "../config.js";
import { bus, SNAPSHOT, type CycleSnapshot } from "../state.js";

interface DashboardProps {
  onForceCycle: () => void | Promise<void>;
  onQuit: () => void;
}

function fmtPct(n: number): string {
  const sign = n > 0 ? "+" : "";
  return `${sign}${n.toFixed(2)}%`;
}

function fmtMoney(n: number): string {
  return `$${n.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function pad(s: string, w: number): string {
  return s.length >= w ? s.slice(0, w) : s + " ".repeat(w - s.length);
}

const App: React.FC<DashboardProps> = ({ onForceCycle, onQuit }) => {
  const [snap, setSnap] = useState<CycleSnapshot | undefined>(SNAPSHOT.lastCycle);
  const [now, setNow] = useState(Date.now());
  const [error, setError] = useState<string | undefined>(SNAPSHOT.lastError);
  const { exit } = useApp();

  useEffect(() => {
    const onCycle = (s: CycleSnapshot): void => {
      setSnap(s);
      setError(SNAPSHOT.lastError);
    };
    bus.on("cycle", onCycle);
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      bus.off("cycle", onCycle);
      clearInterval(t);
    };
  }, []);

  useInput((input) => {
    if (input === "q") {
      onQuit();
      exit();
    } else if (input === "r") {
      void onForceCycle();
    }
  });

  const remainingMs = snap ? Math.max(0, snap.nextCycleAt - now) : 0;
  const mins = Math.floor(remainingMs / 60_000);
  const secs = Math.floor((remainingMs % 60_000) / 1000);

  if (!snap) {
    return (
      <Box flexDirection="column" padding={1}>
        <Text color="cyan">crypto-agent-cli</Text>
        <Text>Booting first cycle… symbols={CONFIG.SYMBOLS.join(",")}</Text>
        <Text dimColor>[q] quit</Text>
      </Box>
    );
  }

  const p = snap.packet;
  const pos = p.open_position;
  const equityPctFromInit =
    ((snap.equityAfter - CONFIG.INITIAL_EQUITY) / CONFIG.INITIAL_EQUITY) * 100;

  const verdictColor =
    snap.verdict === "ACCEPT"
      ? "green"
      : snap.verdict === "HALT"
      ? "red"
      : "yellow";

  return (
    <Box flexDirection="column" padding={1} borderStyle="round" borderColor="cyan">
      <Box>
        <Text color="cyan" bold>crypto-agent-cli</Text>
        <Text> · cycle #{SNAPSHOT.cycleNumber}</Text>
      </Box>

      <Box marginTop={1}>
        <Text bold>{p.symbol} </Text>
        <Text>{fmtMoney(p.price)} </Text>
        <Text color={p.change_24h_pct >= 0 ? "green" : "red"}>
          {fmtPct(p.change_24h_pct)} (24h)
        </Text>
        <Text>   Regime: </Text>
        <Text color="magenta">{p.regime}</Text>
      </Box>

      <Box marginTop={1}>
        <Text>EQUITY  </Text>
        <Text bold>{fmtMoney(snap.equityAfter)}</Text>
        <Text color={equityPctFromInit >= 0 ? "green" : "red"}>
          {" "}({fmtPct(equityPctFromInit)})
        </Text>
        <Text>   Daily P&L: </Text>
        <Text color={p.daily_pnl_pct >= 0 ? "green" : "red"}>
          {fmtPct(p.daily_pnl_pct)}
        </Text>
      </Box>

      <Box>
        <Text>POSITION </Text>
        {pos.side === "none" ? (
          <Text dimColor>none</Text>
        ) : (
          <>
            <Text color={pos.side === "long" ? "green" : "red"}>
              {pos.side.toUpperCase()}
            </Text>
            <Text>  entry {fmtMoney(pos.entry_price)}  unrealized: </Text>
            <Text color={pos.unrealized_pnl_pct >= 0 ? "green" : "red"}>
              {fmtPct(pos.unrealized_pnl_pct)}
            </Text>
          </>
        )}
      </Box>

      <Box marginTop={1} flexDirection="column">
        <Text bold>INDICATORS</Text>
        <Text>
          {"  "}RSI(14): {p.rsi_14.toFixed(1)}   MACD hist: {p.macd_histogram.toFixed(2)}
          {"   "}EMA200 dist: {fmtPct(p.ema200_distance_pct)}
        </Text>
        <Text>
          {"  "}ATR(14): {p.atr_14.toFixed(2)}   Vol24h: {fmtMoney(p.volume_24h_usd)}
        </Text>
      </Box>

      <Box marginTop={1} flexDirection="column">
        <Text bold>LAST DECISION  [{p.timestamp.slice(11, 19)} UTC]</Text>
        <Text>
          {"  "}
          <Text color="cyan">{snap.intent.action}</Text>
          {"  "}conf: {snap.intent.confidence.toFixed(2)}
          {"  "}size: {snap.intent.size_pct_of_equity.toFixed(1)}%
          {"  "}sl/tp: {snap.intent.stop_loss_pct.toFixed(1)}/{snap.intent.take_profit_pct.toFixed(1)}
        </Text>
        <Text dimColor>{"  \""}{snap.intent.rationale}{"\""}</Text>
        <Text>
          {"  "}Risk: <Text color={verdictColor}>{snap.verdict}</Text>
          {snap.rejectReason ? <Text dimColor> ({snap.rejectReason})</Text> : null}
          {"   "}Tokens: {snap.brain.usage.prompt_tokens + snap.brain.usage.completion_tokens}
          {snap.brain.usage.cost_usd !== undefined ? (
            <Text>   Cost: ${snap.brain.usage.cost_usd.toFixed(4)}</Text>
          ) : null}
          {"   "}Votes: {JSON.stringify(snap.brain.votes)}
        </Text>
      </Box>

      <Box marginTop={1} flexDirection="column">
        <Text bold>LAST {snap.recentTrades.length} TRADES</Text>
        {snap.recentTrades.length === 0 ? (
          <Text dimColor>  (none yet)</Text>
        ) : (
          snap.recentTrades.map((t) => (
            <Text key={t.id}>
              {"  "}
              {pad(t.side.toUpperCase(), 5)} {fmtMoney(t.entryPrice)} → {fmtMoney(t.exitPrice)}{" "}
              <Text color={t.pnlPct >= 0 ? "green" : "red"}>
                {fmtPct(t.pnlPct)} {t.pnlPct >= 0 ? "✓" : "✗"}
              </Text>
            </Text>
          ))
        )}
      </Box>

      {error ? (
        <Box marginTop={1}>
          <Text color="red">last error: {error}</Text>
        </Box>
      ) : null}

      <Box marginTop={1}>
        <Text dimColor>
          Next cycle in: {mins}m {secs.toString().padStart(2, "0")}s    [q] quit  [r] force cycle
        </Text>
      </Box>
    </Box>
  );
};

export function renderDashboard(props: DashboardProps): void {
  render(<App {...props} />);
}
