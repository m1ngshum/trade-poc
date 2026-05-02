import OpenAI from "openai";
import type { ChatCompletionCreateParamsNonStreaming } from "openai/resources/chat/completions";
import { CONFIG } from "../../config.js";
import type { Provider } from "./types.js";

let _client: OpenAI | null = null;

function client(): OpenAI {
  if (_client) return _client;
  if (!CONFIG.OPENROUTER_API_KEY) {
    throw new Error("OPENROUTER_API_KEY is required when LLM_PROVIDER=openrouter");
  }
  _client = new OpenAI({
    apiKey: CONFIG.OPENROUTER_API_KEY,
    baseURL: "https://openrouter.ai/api/v1",
    defaultHeaders: {
      "HTTP-Referer": "https://github.com/m1ngshum/trade-poc",
      "X-Title": "crypto-agent-cli",
    },
  });
  return _client;
}

export const openrouterProvider: Provider = async (
  _packet,
  systemPrompt,
  userMessage,
) => {
  // OpenRouter forwards Anthropic `cache_control` hints when the system
  // message is sent as a content-block array. The OpenAI SDK's public types
  // don't include cache_control, so we cast at the boundary.
  const params = {
    model: CONFIG.LLM_MODEL,
    temperature: 0.3,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: [
          {
            type: "text",
            text: systemPrompt,
            cache_control: { type: "ephemeral" },
          },
        ],
      },
      { role: "user", content: userMessage },
    ],
  } as unknown as ChatCompletionCreateParamsNonStreaming;

  const completion = await client().chat.completions.create(params);

  return {
    raw: completion.choices[0]?.message?.content ?? "",
    usage: {
      prompt_tokens: completion.usage?.prompt_tokens ?? 0,
      completion_tokens: completion.usage?.completion_tokens ?? 0,
    },
  };
};
