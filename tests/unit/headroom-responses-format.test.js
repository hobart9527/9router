// #1998 — Headroom compression treated a Codex (openai-responses) body.input
// array as OpenAI messages: it sent Responses items to /v1/compress and then
// assigned the returned OpenAI messages back to body.input, violating the
// Responses format contract. body.input must stay Responses-shaped.
import { describe, it, expect, vi, afterEach } from "vitest";
import { compressWithHeadroom } from "../../open-sse/rtk/headroom.js";

describe("compressWithHeadroom openai-responses format (#1998)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps body.input in Responses format after compressing an openai-responses request", async () => {
    // Headroom always returns compressed OpenAI-style messages.
    global.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        messages: [{ role: "user", content: "compressed text" }],
        tokens_before: 100,
        tokens_after: 90,
        tokens_saved: 10,
      }),
    }));

    const body = {
      input: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "a long original message ".repeat(20) }],
        },
      ],
    };

    const data = await compressWithHeadroom(body, {
      enabled: true,
      url: "http://headroom.test",
      model: "gpt-5",
      format: "openai-responses",
    });

    expect(data).not.toBeNull();
    // body.input must remain Responses items (type:"message" + content array),
    // NOT the raw OpenAI messages ({ role, content: "<string>" }) the bug produced.
    expect(Array.isArray(body.input)).toBe(true);
    expect(body.input[0]).toMatchObject({ type: "message", role: "user" });
    expect(Array.isArray(body.input[0].content)).toBe(true);
    expect(typeof body.input[0].content).not.toBe("string");
  });

  it("skips only genuinely unmappable Responses items, not tool/reasoning history (#2132)", async () => {
    global.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        messages: [{ role: "user", content: "compressed tool history" }],
        tokens_saved: 10,
      }),
    }));

    // A hosted tool item has no OpenAI-message mapping — the translator drops
    // it, so a round-trip through compress would lose it silently. Skip the body.
    const input = [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "search the web" }],
      },
      { type: "web_search_call", id: "ws_1", status: "completed" },
    ];
    const body = { input: structuredClone(input) };
    const diagnostics = {};

    const data = await compressWithHeadroom(body, {
      enabled: true,
      url: "http://headroom.test",
      model: "gpt-5",
      format: "openai-responses",
      diagnostics,
    });

    expect(data).toBeNull();
    expect(global.fetch).not.toHaveBeenCalled();
    expect(body.input).toEqual(input);
    expect(diagnostics.reason).toBe("skipped: openai-responses tool/reasoning input is not safe to compress");
  });

  it("compresses Responses tool/reasoning history and round-trips it losslessly (#2132)", async () => {
    // Identity compressor: echo back exactly the messages handed to it. A
    // lossless headroom run must then reproduce the original input verbatim.
    global.fetch = vi.fn(async (_url, init) => {
      const sent = JSON.parse(init.body);
      return { ok: true, json: async () => ({ messages: sent.messages, tokens_saved: 0 }) };
    });

    const body = {
      input: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "investigate bug" }],
        },
        {
          type: "reasoning",
          summary: [{ type: "summary_text", text: "Need a plan" }],
        },
        {
          type: "function_call",
          call_id: "call_apply_patch_123",
          name: "apply_patch",
          arguments: "*** Begin Patch\n*** End Patch",
        },
        {
          type: "function_call_output",
          call_id: "call_apply_patch_123",
          output: "ok",
        },
      ],
      tools: [
        {
          type: "custom",
          name: "apply_patch",
          format: { type: "grammar", syntax: "lark", definition: "start: /.+/" },
        },
      ],
    };
    const diagnostics = {};

    const data = await compressWithHeadroom(body, {
      enabled: true,
      url: "http://headroom.test",
      model: "gpt-5",
      format: "openai-responses",
      diagnostics,
    });

    expect(data).not.toBeNull();
    expect(global.fetch).toHaveBeenCalledOnce();
    // body.input stays Responses-shaped — never raw OpenAI messages.
    expect(body.input.every((item) => typeof item.type === "string")).toBe(true);
    const fc = body.input.find((item) => item.type === "function_call");
    expect(fc).toMatchObject({ call_id: "call_apply_patch_123", name: "apply_patch" });
    const fco = body.input.find((item) => item.type === "function_call_output");
    expect(fco).toMatchObject({ call_id: "call_apply_patch_123", output: "ok" });
    expect(body.input.find((item) => item.type === "reasoning")?.summary?.[0]?.text).toBe("Need a plan");
  });
});
