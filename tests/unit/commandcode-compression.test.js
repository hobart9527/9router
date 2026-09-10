// Regression guard: commandcode (and any non-message-flat target) nests its
// translated payload under `params`, so a token saver that runs AFTER
// translateRequest silently no-ops on it. Tool-schema compaction and headroom
// must run on the SOURCE body before translation.
// See https://github.com/decolua/9router/issues/2620
import { describe, it, expect, vi, beforeEach } from "vitest";

const { executeMock } = vi.hoisted(() => ({ executeMock: vi.fn() }));

vi.mock("../../open-sse/executors/index.js", () => ({
  getExecutor: () => ({ noAuth: true, execute: executeMock }),
}));

vi.mock("../../open-sse/utils/requestLogger.js", () => ({
  createRequestLogger: async () => ({
    logClientRawRequest: vi.fn(),
    logRawRequest: vi.fn(),
    logTargetRequest: vi.fn(),
    logProviderResponse: vi.fn(),
    logConvertedResponse: vi.fn(),
    logError: vi.fn(),
  }),
}));

vi.mock("../../open-sse/utils/stream.js", () => ({
  COLORS: { red: "", reset: "" },
  createPassthroughStreamWithLogger: vi.fn(() => new TransformStream()),
  createSSETransformStreamWithLogger: vi.fn(() => new TransformStream()),
}));

vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: vi.fn(),
  appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async () => {}),
}));

const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");

function longTool() {
  return {
    name: "Read",
    description: "Reads a file. " + "More prose that should be dropped. ".repeat(30),
    input_schema: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      title: "Read",
      type: "object",
      properties: { file_path: { type: "string", description: "Path. " + "Extra. ".repeat(30) } },
      required: ["file_path"],
    },
  };
}

function claudeBody() {
  return {
    model: "deepseek-v4-flash",
    stream: false,
    messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    tools: [longTool()],
  };
}

describe("tool-schema compaction runs before translation (commandcode coverage)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    global.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ messages: [] }) }));
    executeMock.mockResolvedValue({
      response: new Response(JSON.stringify({
        id: "chatcmpl-test",
        object: "chat.completion",
        choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop", index: 0 }],
      }), { status: 200, headers: { "content-type": "application/json" } }),
      url: "https://api.commandcode.ai/alpha/generate",
      headers: {},
      transformedBody: null,
    });
  });

  it("compacts tools on the source body for a commandcode target", async () => {
    const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), line: vi.fn(), fmtThink: vi.fn() };
    const body = claudeBody();

    await handleChatCore({
      body,
      modelInfo: { provider: "commandcode", model: "deepseek/deepseek-v4.1-flash" },
      credentials: { apiKey: "user_test", providerSpecificData: {} },
      log,
      connectionId: "test-conn",
      rtkEnabled: false,
      headroomEnabled: false,
      toolSchemaCompactEnabled: true,
      toolSchemaDescMaxChars: 200,
      cavemanEnabled: false,
      ponytailEnabled: false,
      clientRawRequest: { endpoint: "/v1/messages", body: {}, headers: {} },
    });

    // The source body is compacted in place before translateRequest runs.
    expect(body.tools[0].input_schema).not.toHaveProperty("$schema");
    expect(body.tools[0].input_schema).not.toHaveProperty("title");
    expect(log.info).toHaveBeenCalledWith("TOOLSCHEMA", expect.stringContaining("keys="));
  });

  it("does not compact when the setting is off", async () => {
    const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), line: vi.fn(), fmtThink: vi.fn() };
    const body = claudeBody();

    await handleChatCore({
      body,
      modelInfo: { provider: "commandcode", model: "deepseek/deepseek-v4.1-flash" },
      credentials: { apiKey: "user_test", providerSpecificData: {} },
      log,
      connectionId: "test-conn",
      rtkEnabled: false,
      headroomEnabled: false,
      toolSchemaCompactEnabled: false,
      cavemanEnabled: false,
      ponytailEnabled: false,
      clientRawRequest: { endpoint: "/v1/messages", body: {}, headers: {} },
    });

    expect(body.tools[0].input_schema).toHaveProperty("$schema");
    expect(log.info).not.toHaveBeenCalledWith("TOOLSCHEMA", expect.anything());
  });

  it("gives headroom the source body, not the translated commandcode envelope", async () => {
    const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), line: vi.fn(), fmtThink: vi.fn() };
    const body = claudeBody();

    await handleChatCore({
      body,
      modelInfo: { provider: "commandcode", model: "deepseek/deepseek-v4.1-flash" },
      credentials: { apiKey: "user_test", providerSpecificData: {} },
      log,
      connectionId: "test-conn",
      rtkEnabled: false,
      headroomEnabled: true,
      headroomUrl: "http://headroom.test",
      headroomCompressUserMessages: false,
      headroomTimeoutMs: 3000,
      toolSchemaCompactEnabled: false,
      cavemanEnabled: false,
      ponytailEnabled: false,
      clientRawRequest: { endpoint: "/v1/messages", body: {}, headers: {} },
    });

    const compressCall = global.fetch.mock.calls.find(([url]) => String(url).includes("/v1/compress"));
    expect(compressCall, "headroom must be called for commandcode requests").toBeTruthy();
    const sent = JSON.parse(compressCall[1].body);
    // A source claude body translates to OpenAI messages for the proxy — never
    // an empty/unsupported shape, and never the params-nested envelope.
    expect(Array.isArray(sent.messages)).toBe(true);
    expect(sent.messages.length).toBeGreaterThan(0);
    expect(sent.params).toBeUndefined();
  });
});
