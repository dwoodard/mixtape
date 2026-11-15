import { describe, expect, it, vi } from "vitest";
import { createLmClient, stripThinking } from "./lm";

const reply = (body: unknown, status = 200) => ({ ok: status < 300, status, text: async () => (typeof body === "string" ? body : JSON.stringify(body)) });

describe("lm client", () => {
  it("lists models and leaves out embedding models", async () => {
    const doFetch = vi.fn(async () => reply({ data: [{ id: "qwen/qwen3" }, { id: "text-embedding-nomic" }] }));
    const client = createLmClient(() => "http://localhost:1234/", doFetch);
    expect(await client.models()).toEqual(["qwen/qwen3"]);
    expect(doFetch).toHaveBeenCalledWith("http://localhost:1234/v1/models", expect.objectContaining({ method: "GET" }));
  });

  it("posts the conversation with tools and returns the text and tool calls", async () => {
    const calls = [{ id: "1", type: "function", function: { name: "get_queue", arguments: "{}" } }];
    const doFetch = vi.fn(async () => reply({ choices: [{ message: { content: "<think>hm</think>Sure.", tool_calls: calls } }] }));
    const client = createLmClient(() => "http://localhost:1234", doFetch);

    const out = await client.complete("m", [{ role: "user", content: "hi" }], []);

    expect(out).toEqual({ content: "Sure.", toolCalls: calls });
    const [url, init] = doFetch.mock.calls[0] as unknown as [string, { method: string; body: string }];
    expect(url).toBe("http://localhost:1234/v1/chat/completions");
    expect(JSON.parse(init.body)).toMatchObject({ model: "m", stream: false, messages: [{ role: "user", content: "hi" }] });
  });

  it("explains how to start the server when it cannot be reached", async () => {
    const client = createLmClient(() => "http://localhost:1234", async () => {
      throw new Error("connection refused");
    });
    await expect(client.models()).rejects.toThrow(/Can't reach LM Studio.*lms server start/);
  });

  it("shows the server's own error message", async () => {
    const client = createLmClient(() => "http://localhost:1234", async () => reply({ error: { message: "model not loaded" } }, 400));
    await expect(client.complete("m", [], [])).rejects.toThrow("400: model not loaded");
  });

  it("strips reasoning, including a missing opening tag", () => {
    expect(stripThinking("<think>a\nb</think>\n\nHello")).toBe("Hello");
    expect(stripThinking("thinking...</think>Hello")).toBe("Hello");
    expect(stripThinking("Hello")).toBe("Hello");
  });
});
