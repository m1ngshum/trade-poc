import { spawn } from "node:child_process";
import { CONFIG } from "../../config.js";
import type { Provider } from "./types.js";

interface ClaudeCliResult {
  type: string;
  subtype: string;
  is_error: boolean;
  result: string;
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
 * Useful when you want to run on a Claude.ai subscription instead of an API key.
 *
 * Trade-offs vs OpenRouter:
 *   - Higher latency (process spawn + harness boot per call)
 *   - Each self-consistency sample = a separate subprocess
 *   - Auth comes from whatever `claude` is locally configured with
 */
export const claudeCliProvider: Provider = async (
  _packet,
  systemPrompt,
  userMessage,
) => {
  const args = [
    "-p",
    "--bare",
    "--tools",
    "",
    "--no-session-persistence",
    "--dangerously-skip-permissions",
    "--output-format",
    "json",
    "--system-prompt",
    systemPrompt,
    "--model",
    CONFIG.LLM_MODEL,
    userMessage,
  ];

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

  return {
    raw: parsed.result,
    usage: {
      prompt_tokens: parsed.usage?.input_tokens ?? 0,
      completion_tokens: parsed.usage?.output_tokens ?? 0,
    },
  };
};
