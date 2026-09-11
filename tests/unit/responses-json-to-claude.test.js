import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/usageDb.js", () => ({
  appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async () => {}),
  saveRequestUsage: vi.fn(async () => {})
}));

const { FORMATS } = await import("../../open-sse/translator/formats.js");
const { translateNonStreamingResponse } = await import("../../open-sse/handlers/chatCore/nonStreamingHandler.js");

// A Responses-API (Codex-style) provider body, returned as plain JSON.
const CODEX_JSON_BODY = {
  id: "resp_abc",
  object: "response",
  created_at: 1700000000,
  model: "gpt-6-astra",
  status: "completed",
  output: [
    { type: "reasoning", summary: [{ type: "summary_text", text: "thinking..." }] },
    { type: "message", role: "assistant", content: [{ type: "output_text", text: "hello", annotations: [] }] },
    { type: "function_call", id: "fc_1", call_id: "call_1", name: "Read", arguments: "{\"file_path\":\"/a\"}" }
  ],
  usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 }
};

describe("Responses provider JSON -> Claude client (non-stream retry)", () => {
  it("converts a Responses body into a Claude Message", () => {
    const out = translateNonStreamingResponse(CODEX_JSON_BODY, FORMATS.OPENAI_RESPONSES, FORMATS.CLAUDE);
    expect(out.type).toBe("message");
    expect(out.role).toBe("assistant");
    expect(out.content.find((c) => c.type === "text")?.text).toBe("hello");
    const tool = out.content.find((c) => c.type === "tool_use");
    expect(tool?.name).toBe("Read");
    expect(tool?.input).toEqual({ file_path: "/a" });
    expect(out.usage.input_tokens).toBe(10);
    expect(out.usage.output_tokens).toBe(5);
  });

  it("maps a Responses custom_tool_call (freeform input) to a Claude tool_use", () => {
    const body = structuredClone(CODEX_JSON_BODY);
    body.output = [{
      type: "custom_tool_call", id: "ctc_1", call_id: "call_x", name: "exec",
      input: "return await tools.shell({command: 'pwd'});"
    }];
    const out = translateNonStreamingResponse(body, FORMATS.OPENAI_RESPONSES, FORMATS.CLAUDE);
    const tool = out.content.find((c) => c.type === "tool_use");
    expect(tool?.name).toBe("exec");
    expect(tool?.input).toEqual({ input: "return await tools.shell({command: 'pwd'});" });
  });

  it("converts a Responses body into the Responses shape for a Responses client", () => {
    const out = translateNonStreamingResponse(CODEX_JSON_BODY, FORMATS.OPENAI_RESPONSES, FORMATS.OPENAI_RESPONSES);
    expect(out).toBe(CODEX_JSON_BODY); // same-format short-circuit
  });

  it("converts a Responses body into chat.completion for a plain OpenAI client", () => {
    const out = translateNonStreamingResponse(CODEX_JSON_BODY, FORMATS.OPENAI_RESPONSES, FORMATS.OPENAI);
    expect(out.object).toBe("chat.completion");
    expect(out.choices[0].message.content).toBe("hello");
    expect(out.choices[0].message.tool_calls[0].function.name).toBe("Read");
    expect(out.choices[0].finish_reason).toBe("tool_calls");
  });
});

