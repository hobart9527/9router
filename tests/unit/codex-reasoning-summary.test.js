// Regression: Codex /responses answers the entire request with
//
//   400 invalid_request_error Missing required parameter: 'input[N].summary'
//
// when an input[] reasoning item carries `encrypted_content` without summary text. Verified
// against the live backend: the same item with summary text is accepted, with the summary
// removed it is rejected, and `summary: []` / `summary: [{ text: "" }]` are rejected too.
//
// Live traffic reaches that shape whenever a turn ends on a tool call (the reasoning item is
// emitted with an encrypted blob and no summary) or when Headroom runs its
// responses->chat->responses round trip, which rebuilds the blob from an assistant message
// that has no reasoning text. The repair keeps the blob when real reasoning text is
// available, and drops the item when there is nothing to summarise.
import { describe, expect, it } from "vitest";
import { normalizeReasoningInputItems } from "../../open-sse/executors/codex.js";

const validItem = {
  type: "reasoning",
  summary: [{ type: "summary_text", text: "**Checking the file listing**" }],
  encrypted_content: "gAAAA-issued-blob",
};

describe("normalizeReasoningInputItems", () => {
  it("leaves a reasoning item that already has summary text alone", () => {
    const body = { input: [structuredClone(validItem), { type: "message", role: "user" }] };

    expect(normalizeReasoningInputItems(body)).toBe(0);
    expect(body.input).toHaveLength(2);
    expect(body.input[0]).toEqual(validItem);
  });

  it("fills the summary from reasoning content and keeps the blob", () => {
    const body = { input: [{ type: "reasoning", summary: [], content: [{ type: "reasoning_text", text: "Let me check the file." }], encrypted_content: "gAAAA-issued-blob" }] };

    expect(normalizeReasoningInputItems(body)).toBe(1);
    expect(body.input[0].summary).toEqual([{ type: "summary_text", text: "Let me check the file." }]);
    expect(body.input[0].encrypted_content).toBe("gAAAA-issued-blob");
  });

  it("drops a blob-only reasoning item that has no text to summarise", () => {
    const body = { input: [{ type: "message", role: "user" }, { type: "reasoning", summary: [], content: [], encrypted_content: "gAAAA-issued-blob" }] };

    expect(normalizeReasoningInputItems(body)).toBe(1);
    expect(body.input).toHaveLength(1);
    expect(body.input[0].type).toBe("message");
  });

  it("drops a blob-only reasoning item whose summary holds only whitespace", () => {
    const body = { input: [{ type: "reasoning", summary: [{ type: "summary_text", text: "  " }], encrypted_content: "gAAAA-issued-blob" }] };

    expect(normalizeReasoningInputItems(body)).toBe(1);
    expect(body.input).toHaveLength(0);
  });

  it("leaves reasoning items without a blob and items of other types alone", () => {
    const body = {
      input: [
        { type: "reasoning", summary: [] },
        { type: "reasoning", summary: [], content: [{ type: "reasoning_text", text: "text without blob" }] },
        { type: "message", role: "user", encrypted_content: "not-a-reasoning-item" },
      ],
    };

    expect(normalizeReasoningInputItems(body)).toBe(0);
    expect(body.input).toHaveLength(3);
    expect(body.input[1].summary).toEqual([]);
  });

  it("tolerates bodies without an input array", () => {
    expect(normalizeReasoningInputItems({})).toBe(0);
    expect(normalizeReasoningInputItems({ input: "plain string" })).toBe(0);
    expect(normalizeReasoningInputItems(null)).toBe(0);
  });
});
