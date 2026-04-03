import type { Config, ContentBlock, Message } from "../types";

const CONNECT_TIMEOUT_MS = 30_000;
const MAX_RETRIES = 3;
const RETRY_DELAYS = [1000, 3000, 8000];

const ANTHROPIC_VERSION = "2024-06-01";

function isRetryable(status: number): boolean {
  return status === 429 || status === 502 || status === 503 || status === 504;
}

function isNetworkError(err: unknown): boolean {
  if (err instanceof TypeError) return true;
  const msg = err instanceof Error ? err.message : "";
  return msg.includes("ECONNREFUSED") || msg.includes("fetch failed");
}

// format specific helper

function getUrl(config: Config): string {
  return config.apiFormat === "openai"
    ? `${config.apiUrl}/v1/chat/completions`
    : `${config.apiUrl}/v1/messages`;
}

function getHeaders(config: Config): Record<string, string> {
  if (config.apiFormat === "openai") {
    return {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiKey}`,
    };
  }
  // claude 已经不再使用, 改为默认选项了
  //"prompt-caching-2024-07-31"
  const betaFeatures: string[] = [];
  if (config.thinkingBudge > 0) {
    betaFeatures.push("interleaved-thinking-2025-05-14");
  }
  return {
    "Content-Type": "application/json",
    "x-api-key": config.apiKey,
    "anthropic-version": ANTHROPIC_VERSION,
    "anthropic-beta": betaFeatures.join(","),
  };
}

// convert anthropic request body to Open ai format
// function toOpenAiBody(body: Record<string, unknown>): Record<string, unknown> {
//   const messages: Array<Record<string, unknown>> = [];
//   const system = body.system;
//   if (typeof system === "string") {
//     messages.push({ role: "system", content: system });
//   } else if (Array.isArray(system)) {
//     const text = (system as Array<Record<string, unknown>>)
//       .filter((b) => b.type === "text")
//       .map((b) => b.text as string)
//       .join("\n");
//     if (text) messages.push({ role: "system", content: text });
//   }
//   // convert messages
//   const srcMessages = (body.messages ?? []) as Message[];
//   for (const m of srcMessages) {
//     if (typeof m.content === "string") {
//       messages.push({ role: m.role, content: m.content });
//     } else {
//       const blocks = m.content as ContentBlock[];
//       const textParts = blocks
//         .filter((b) => b.type === "text")
//         .map((b) => b.text)
//         .join("\n");
//
//       // handle tool use blocks -> openai function calls
//       const toolCalls = blocks
//         .filter((b) => b.type === "tool_use")
//         .map((b) => ({
//           id: b.id ?? "call_0",
//           type: "function" as const,
//           function: {
//             name: b.name ?? "",
//             arguments: JSON.stringify(b.input ?? {}),
//           },
//         }));
//       // handle tool_result blocks -> openai tool messages
//       const toolResults = blocks.filter((b) => b.type === "tool_result");
//       if (toolResults.length > 0) {
//         for (const tr of toolResults) {
//           messages.push({
//             role: "tool",
//             tool_call_id: tr.tool_use_id ?? "call_0",
//             content:
//               typeof tr.content === "string"
//                 ? tr.content
//                 : JSON.stringify(tr.content),
//           });
//         }
//       } else if (toolCalls.length > 0) {
//         messages.push({
//           role: "assistant",
//           content: textParts || null,
//           tool_calls: toolCalls,
//         });
//       } else {
//         messages.push({ role: m.role, content: textParts });
//       }
//     }
//   }
//   // convert tools definitions
//   const tools = body.tools as
//     | Array<{
//       name: string;
//       description: string;
//       input_schema: Record<string, unknown>;
//     }>
//     | undefined;
//   const openaiTools = tools?.map((t) => ({
//     type: "function" as const,
//     function: {
//       name: t.name,
//       description: t.description,
//       parameters: t.input_schema,
//     },
//   }));
//   return {
//     model: body.model,
//     messages,
//     stream: true,
//     stream_options: { include_usage: true },
//     max_tokens: body.max_tokens,
//     ...(openaiTools?.length ? { tools: openaiTools } : {}),
//   };
// }

/** convert a single open ai streaming chunk to anthroopic-like event  */
// function* translateOpenAIChunk(
//   chunk: Record<string, unknown>,
//   state: {
//     blockStarted: boolean;
//     toolCallAccum: Map<
//       number,
//       {
//         id: string;
//         name: string;
//         args: string;
//       }
//     >;
//   },
// ): Generator<Record<string, unknown>> {
//   // openai streaming chunk example:
//   // {
//   //   "choices": [
//   //     {
//   //       "delta": { "content": "Hello" },
//   //       "index": 0,
//   //       "finish_reason": null
//   //     }
//   //   ]
//   // }
//   const choices = chunk.choices as Array<Record<string, unknown>> | undefined;
//   if (!choices || choices.length === 0) return;
//   const choice = choices[0];
//   const delta = choice.delta as Record<string, unknown>;
//   const finishReason = choice.finish_reason as string | null;
//   if (delta) {
//     if (typeof delta.content === "string") {
//       if (!state.blockStarted) {
//         yield {
//           type: "content_block_start",
//           content_block: {
//             type: "text",
//             text: "",
//           },
//           index: 0,
//         };
//         state.blockStarted = true;
//       }
//       yield {
//         type: "content_block_delta",
//         index: 0,
//         delta: {
//           type: "text_delta",
//           text: delta.content,
//         },
//       };
//     }
//     // tool calls
//     const toolCalls = delta.tool_calls as
//       | Array<Record<string, unknown>>
//       | undefined;
//     if (toolCalls) {
//       for (const tc of toolCalls) {
//         const idx = (tc.index as number) ?? 0;
//         const fn = tc.function as Record<string, unknown> | undefined;
//
//         if (!state.toolCallAccum.has(idx)) {
//           state.toolCallAccum.set(idx, {
//             id: (tc.id as string) ?? "",
//             name: (fn?.name as string) ?? "",
//             args: "",
//           });
//         }
//         const accum = state.toolCallAccum.get(idx)!;
//         if (fn?.name) accum.name = fn.name as string;
//         if (fn?.arguments) accum.args += fn.arguments as string;
//       }
//     }
//   }
//   if (finishReason) {
//     if (state.blockStarted) {
//       yield {
//         type: "content_block_end",
//         index: 0,
//       };
//     }
//
//     // emit tool use blocks from accumlated tool calls
//     if (finishReason == "tool_calls" || state.toolCallAccum.size > 0) {
//       let toolIdx = state.blockStarted ? 1 : 0;
//       for (const [, tc] of state.toolCallAccum) {
//         let parsedArgs: Record<string, unknown> = {};
//         try { parsedArgs = JSON.parse(tc.args || "{}") as Record<string, unknown>; } catch {/**/ }
//         yield {
//           type: "content_block_start",
//           index: toolIdx,
//           content_block: {
//             type: "tool_use",
//             id: tc.id,
//             name: tc.name,
//             input: {}
//           },
//         };
//         yield {
//           type: "content_block_delta",
//           index: toolIdx,
//           delta: { type: "input_json_delta", partial_json: JSON.stringify(parsedArgs) },
//         };
//         yield {
//           type: "content_block_stop",
//           index: toolIdx,
//         };
//         toolIdx++;
//       }
//     }
//   }
//
//   // usage from openai
//   const usage = chunk.usage as Record<string, number> | undefined;
//   yield {
//     type: "message_start",
//     message: {
//       usage: {
//         input_tokens: usage?.prompt_tokens ?? 0,
//         output_tokens: 0,
//       },
//     }
//   };
//   yield {
//     type: "message_delta",
//     delta: {
//       stop_season: finishReason === "tool_calls" ? "tool_use" : "end_turn",
//     },
//     usage: {
//       output_tokens: usage?.completion_tokens ?? 0,
//     }
//   }
// }

// main streaming funciotn
export async function* streamRequest(
  config: Config,
  body: Record<string, unknown>,
  signal?: AbortSignal
): AsyncGenerator<Record<string, unknown>> {
  // 不处理 openai的格式， 只处理 anthropic的格式

  // const isOpenAI = config.apiFormat === "openai";
  const requestBody = { ...body, stream: true };
  let lastError: unknown
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      const delay = RETRY_DELAYS[Math.min(attempt - 1, RETRY_DELAYS.length - 1)];
      await new Promise(r => setTimeout(r, delay));
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    }
    let response: Response;
    try {
      response = await fetch(getUrl(config), {
        method: "POST",
        headers: getHeaders(config),
        body: JSON.stringify(requestBody),
        signal: signal ?? AbortSignal.timeout(CONNECT_TIMEOUT_MS),
      });
    } catch (err) {
      lastError = err;
      if (signal?.aborted) throw err;
      if (isNetworkError(err) && attempt < MAX_RETRIES) continue;
      throw err;
    }

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      if (isRetryable(response.status) && attempt < MAX_RETRIES) {
        lastError = new Error(`API ${response.status}: ${text.slice(0, 300)}`);
        continue;
      }
      throw new Error(`API ${response.status}: ${text.slice(0, 300)}`);
    }
    if (!response.body) throw new Error("Empty response body");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.startsWith("data:")) continue;
          const data = line.slice(6).trim();
          if (data === "[DONE]") return;
          try {
            const parsed = JSON.parse(data) as Record<string, unknown>;
            yield parsed;
          }
          catch { }
        }
      }
    } finally {
      reader.releaseLock();
    }
    return;
  }
  throw lastError ?? new Error("Request failed after retries");
}

// Non streaming request
export async function apiRequest(
  config: Config,
  body: Record<string, unknown>,
): Promise<{ content: Array<{ type: string; text?: string }> }> {

  const requestBody = body;
  const response = await fetch(getUrl(config), {
    method: "POST",
    headers: getHeaders(config),
    body: JSON.stringify(requestBody),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`API ${response.status}: ${text.slice(0, 300)}`);
  }
  return response.json() as Promise<{ content: Array<{ type: string; text?: string }> }>;
}

