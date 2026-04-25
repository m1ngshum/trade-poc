import { closeDb, getRecentDecisions } from "../journal/db.js";

const N = Number(process.argv[2] ?? "30");
const rows = getRecentDecisions(N);

if (rows.length === 0) {
  // eslint-disable-next-line no-console
  console.log("(journal is empty)");
  closeDb();
  process.exit(0);
}

const header = [
  "timestamp".padEnd(25),
  "symbol".padEnd(10),
  "action".padEnd(7),
  "verdict".padEnd(8),
  "fill".padEnd(12),
  "equity".padEnd(12),
  "tokens".padEnd(8),
  "reason",
].join(" ");

// eslint-disable-next-line no-console
console.log(header);
// eslint-disable-next-line no-console
console.log("-".repeat(header.length));

for (const r of rows.reverse()) {
  let intentAction = "?";
  try {
    intentAction = (JSON.parse(r.intent) as { action: string }).action;
  } catch {
    /* ignore */
  }
  const tokens = (r.prompt_tokens ?? 0) + (r.completion_tokens ?? 0);
  // eslint-disable-next-line no-console
  console.log(
    [
      r.timestamp.padEnd(25),
      r.symbol.padEnd(10),
      intentAction.padEnd(7),
      r.risk_verdict.padEnd(8),
      (r.fill_price != null ? r.fill_price.toFixed(2) : "-").padEnd(12),
      r.equity_after.toFixed(2).padEnd(12),
      tokens.toString().padEnd(8),
      r.reject_reason ?? "",
    ].join(" "),
  );
}

closeDb();
