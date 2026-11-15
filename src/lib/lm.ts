import { fetch as httpFetch } from "@tauri-apps/plugin-http";

export const DEFAULT_LM_ENDPOINT = "http://localhost:1234";

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export type ChatMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

export interface ToolSpec {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface Completion {
  content: string;
  toolCalls: ToolCall[];
}

/** What the DJ needs from a local model server. Faked in tests. */
export interface LmClient {
  models(): Promise<string[]>;
  complete(model: string, messages: ChatMessage[], tools: ToolSpec[]): Promise<Completion>;
}

export type Fetch = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
}>;

/** Reasoning models may put their thinking in the reply between think tags. It is not part of the answer. */
export function stripThinking(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/g, "").replace(/^[\s\S]*<\/think>/, "").trim();
}

const unreachable = (endpoint: string) =>
  `Can't reach LM Studio at ${endpoint}. Start its server (lms server start) and load a model.`;

/** An OpenAI-compatible chat server such as LM Studio. */
export function createLmClient(endpoint: () => string, doFetch: Fetch = httpFetch as Fetch): LmClient {
  const base = () => endpoint().trim().replace(/\/+$/, "") || DEFAULT_LM_ENDPOINT;

  async function request(path: string, body?: unknown): Promise<unknown> {
    let response;
    try {
      response = await doFetch(`${base()}${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: { "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      throw new Error(unreachable(base()));
    }
    const text = await response.text();
    if (!response.ok) {
      let detail = text;
      try {
        detail = JSON.parse(text).error?.message ?? JSON.parse(text).error ?? text;
      } catch {
        // Not JSON: show it as it is.
      }
      throw new Error(`LM Studio answered ${response.status}: ${String(detail).slice(0, 300)}`);
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new Error("LM Studio sent an answer that is not JSON.");
    }
  }

  return {
    async models() {
      const data = (await request("/v1/models")) as { data?: { id: string }[] };
      return (data.data ?? []).map((m) => m.id).filter((id) => !/embed/i.test(id));
    },
    async complete(model, messages, tools) {
      const data = (await request("/v1/chat/completions", {
        model,
        messages,
        tools,
        temperature: 0.7,
        stream: false,
      })) as { choices?: { message?: { content?: string | null; tool_calls?: ToolCall[] } }[] };
      const message = data.choices?.[0]?.message;
      if (!message) throw new Error("LM Studio sent no reply.");
      return { content: stripThinking(message.content ?? ""), toolCalls: message.tool_calls ?? [] };
    },
  };
}
