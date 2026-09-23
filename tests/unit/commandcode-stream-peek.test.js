// Regression: the first-token error check peeks at the head of the upstream stream and stops
// as soon as it sees an event that proves the stream is healthy. That loop used to break out of
// the current read and throw away every remaining event of the same read — the bytes were
// already off the wire, so they were lost for good.
//
// CommandCode flushes `tool-input-start` and `tool-input-delta` in the same read (the huge
// `start-step` event that echoes the request body delays everything after it into one flush).
// Cutting the tail there left the client with a tool call whose arguments were `{}`, which
// Claude Code / opencode reject ("required parameter 'command' is missing", "must have
// required properties command"). The same window also silently truncated reasoning content.
import { describe, expect, it } from "vitest";
import { inspectAndWrapCommandCodeResponse } from "../../open-sse/executors/commandcode.js";

const event = (o) => JSON.stringify(o);

const START_STEP = event({ type: "start-step", request: { body: { prompt: "x".repeat(4000) } } });
const HEAD = [event({ type: "start" }), START_STEP];

const TOOL_EVENTS = [
  event({ type: "reasoning-start", id: "r1" }),
  event({ type: "reasoning-delta", id: "r1", text: "The" }),
  event({ type: "reasoning-delta", id: "r1", text: " answer" }),
  event({ type: "reasoning-end", id: "r1" }),
  event({ type: "tool-input-start", id: "call_1", toolName: "Read" }),
  event({ type: "tool-input-delta", id: "call_1", delta: '{"file_path":"a.py"}' }),
  event({ type: "tool-input-end", id: "call_1" }),
  event({ type: "tool-call", toolCallId: "call_1", toolName: "Read", input: { file_path: "a.py" } }),
  event({ type: "finish-step", finishReason: "tool-calls" }),
  event({ type: "finish" }),
];

function streamOf(chunks) {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

async function wrappedResult(chunks) {
  const response = await inspectAndWrapCommandCodeResponse(new Response(streamOf(chunks)), "test-model");
  const body = await response.text();
  const chunksOut = [];
  for (const line of body.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    chunksOut.push(JSON.parse(payload));
  }

  let reasoning = "";
  let finishReason = null;
  const calls = new Map();
  for (const chunk of chunksOut) {
    const choice = chunk?.choices?.[0];
    if (!choice) continue;
    const delta = choice.delta || {};
    if (typeof delta.reasoning_content === "string") reasoning += delta.reasoning_content;
    for (const toolCall of delta.tool_calls || []) {
      const current = calls.get(toolCall.index) || { name: "", args: "" };
      if (toolCall.function?.name) current.name = toolCall.function.name;
      if (toolCall.function?.arguments) current.args += toolCall.function.arguments;
      calls.set(toolCall.index, current);
    }
    if (choice.finish_reason) finishReason = choice.finish_reason;
  }

  return { status: response.status, reasoning, finishReason, calls: [...calls.values()] };
}

const toolArgs = (result) => JSON.parse(result.calls[0]?.args || "{}");

describe("inspectAndWrapCommandCodeResponse — peeking at the stream head must not drop events", () => {
  it("keeps the tool arguments when the tool events share a read with the first reasoning delta", async () => {
    const result = await wrappedResult([HEAD[0] + "\n", HEAD[1] + "\n" + TOOL_EVENTS.join("\n") + "\n"]);

    expect(result.calls).toHaveLength(1);
    expect(result.calls[0].name).toBe("Read");
    expect(toolArgs(result).file_path).toBe("a.py");
    expect(result.finishReason).toBe("tool_calls");
  });

  it("keeps the tool arguments when the model emits no reasoning at all", async () => {
    const noReasoning = TOOL_EVENTS.filter((line) => !line.includes("reasoning-"));
    const result = await wrappedResult([HEAD[0] + "\n", HEAD[1] + "\n" + noReasoning.join("\n") + "\n"]);

    expect(toolArgs(result).file_path).toBe("a.py");
    expect(result.finishReason).toBe("tool_calls");
  });

  it("keeps every reasoning delta that arrived in the peeked read", async () => {
    const result = await wrappedResult([HEAD[0] + "\n", HEAD[1] + "\n" + TOOL_EVENTS.join("\n") + "\n"]);

    expect(result.reasoning).toBe("The answer");
  });

  it("keeps everything when the stream is split at arbitrary byte boundaries", async () => {
    const all = HEAD[0] + "\n" + HEAD[1] + "\n" + TOOL_EVENTS.join("\n") + "\n";
    const chunks = [];
    for (let i = 0; i < all.length; i += 97) chunks.push(all.slice(i, i + 97));

    const result = await wrappedResult(chunks);

    expect(toolArgs(result).file_path).toBe("a.py");
    expect(result.reasoning).toBe("The answer");
  });

  it("still surfaces a first-token authentication error", async () => {
    const result = await wrappedResult([event({ type: "error", error: { message: "unauthorized", statusCode: 401 } }) + "\n"]);

    expect(result.status).toBe(401);
  });

  it("still maps a rate-limit message to 429", async () => {
    const result = await wrappedResult([event({ type: "error", error: { message: "rate limit exceeded" } }) + "\n"]);

    expect(result.status).toBe(429);
  });
});
