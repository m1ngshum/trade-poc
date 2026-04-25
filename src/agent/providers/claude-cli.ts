import { spawn } from "node:child_process";
import { CONFIG } from "../../config.js";
import { INTENT_JSON_SCHEMA } from "../schema.js";
import type { Provider } from "./types.js";

interface ClaudeCliResult {
  type: string;
  subtype: string;
  is_error: boolean;
  result: string;
  structured_output?: unknown;
  total_cost_usd?: number;
  duration_ms?: number;
  num_turns?: number;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
}

const SPAWN_TIMEOUT_MS = 90_000;

/**
 * Drives the local `claude` CLI in non-interactive print mode.
 *
 * Lockdown posture:
 *   --bare                       no hooks/skills/MCP/CLAUDE.md auto-discovery
 *   --no-session-persistence     leaves no junk session files behind
 *   --permission-mode dontAsk    deny anything not in the allowlist
 *   --allowedTools ""            empty allowlist → model has no tools
 *   --json-schema <Intent>       harness-level structured output enforcement
 *
 * Billing: `--bare` skips OAuth and keychain reads, so this provider always
 * runs against ANTHROPIC_API_KEY (Anthropic Console credits). Subscription
 * (Pro/Max) auth is not supported by this path and not endorsed by Anthropic
 * for automated agents. config.ts enforces ANTHROPIC_API_KEY at startup.
 */
export const claudeCliProvider: Provider = async (
  _packet,
  systemPrompt,
  userMessage,
) => {
  const args = [
    "-p",
    "--bare",
    "--no-session-persistence",
    "--permission-mode",
    "dontAsk",
    "--allowedTools",
    "",
    "--output-format",
    "json",
    "--json-schema",
    JSON.stringify(INTENT_JSON_SCHEMA),
    "--system-prompt",
    systemPrompt,
    "--model",
    CONFIG.LLM_MODEL,
  ];
  if (CONFIG.LLM_FALLBACK_MODEL) {
    args.push("--fallback-model", CONFIG.LLM_FALLBACK_MODEL);
  }
  args.push(userMessage);

  const stdout = await new Promise<string>((resolve, reject) => {
    const child = spawn(CONFIG.CLAUDE_CLI_PATH, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`claude CLI timed out after ${SPAWN_TIMEOUT_MS}ms`));
    }, SPAWN_TIMEOUT_MS);

    child.stdout.on("data", (chunk: Buffer) => {
      out += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      err += chunk.toString("utf8");
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(new Error(`failed to spawn claude CLI: ${e.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`claude CLI exited ${code}: ${err.slice(0, 500)}`));
        return;
      }
      resolve(out);
    });
  });

  let parsed: ClaudeCliResult;
  try {
    parsed = JSON.parse(stdout) as ClaudeCliResult;
  } catch (e) {
    throw new Error(
      `claude CLI returned non-JSON: ${(e as Error).message}: ${stdout.slice(0, 200)}`,
    );
  }

  if (parsed.is_error || parsed.subtype !== "success") {
    throw new Error(`claude CLI error: ${parsed.result.slice(0, 300)}`);
  }

  // Prefer the schema-validated structured output. Fall back to free-text
  // result if the CLI didn't produce one (older versions, or schema reject).
  const raw =
    parsed.structured_output !== undefined
      ? JSON.stringify(parsed.structured_output)
      : parsed.result;

  return {
    raw,
    usage: {
      prompt_tokens: parsed.usage?.input_tokens ?? 0,
      completion_tokens: parsed.usage?.output_tokens ?? 0,
    },
    costUsd: parsed.total_cost_usd,
  };
};
