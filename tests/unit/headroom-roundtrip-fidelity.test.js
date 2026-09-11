// Headroom translates a Claude body to OpenAI, compresses, then translates
// back. If that round-trip drops content, headroom's reported "effective" byte
// shrink is an artifact rather than real savings. This pins the round-trip.
import { describe, it, expect } from "vitest";
import { claudeToOpenAIRequest } from "../../open-sse/translator/request/claude-to-openai.js";
import { openaiToClaudeRequest } from "../../open-sse/translator/request/openai-to-claude.js";

function sampleBody() {
  return {
    model: "claude-sonnet-5",
    system: [{ type: "text", text: "You are a coding agent." }],
    messages: [
      { role: "user", content: [{ type: "text", text: "Fix the bug in app.js" }] },
      {
        role: "assistant",
        content: [
          { type: "text", text: "I'll look." },
          { type: "tool_use", id: "toolu_1", name: "Read", input: { file_path: "/a/app.js" } },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_1",
            content: [{ type: "text", text: "const x = 1;\n".repeat(50) }],
          },
        ],
      },
    ],
    tools: [
      {
        name: "Read",
        description: "Reads a file.",
        input_schema: { type: "object", properties: { file_path: { type: "string" } }, required: ["file_path"] },
      },
    ],
  };
}

describe("headroom claude↔openai round-trip fidelity", () => {
  it("preserves message roles, tool calls, tool results and their content", () => {
    const body = sampleBody();
    const oai = claudeToOpenAIRequest("claude-sonnet-5", structuredClone(body), false);
    const back = openaiToClaudeRequest("claude-sonnet-5", oai, false);

    // Same number of turns, same role order.
    expect(back.messages.map((m) => m.role)).toEqual(body.messages.map((m) => m.role));

    // The tool_use call survives as a tool call with its id and name.
    const assistant = back.messages.find((m) => m.role === "assistant");
    const toolUse = assistant.content.find((c) => c.type === "tool_use");
    expect(toolUse.name).toBe("Read");
    expect(toolUse.input).toMatchObject({ file_path: "/a/app.js" });

    // The tool_result content is intact, not dropped or emptied.
    const toolResult = back.messages
      .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
      .find((c) => c.type === "tool_result");
    const text = typeof toolResult.content === "string"
      ? toolResult.content
      : toolResult.content.map((c) => c.text).join("");
    expect(text).toContain("const x = 1;");
  });

  it("does not shrink the message payload through the round-trip", () => {
    const body = sampleBody();
    const before = JSON.stringify(body.messages).length;
    const oai = claudeToOpenAIRequest("claude-sonnet-5", structuredClone(body), false);
    const back = openaiToClaudeRequest("claude-sonnet-5", oai, false);
    const after = JSON.stringify(back.messages).length;
    // A lossy round-trip would show a large drop with no compressor involved.
    expect(after).toBeGreaterThan(before * 0.9);
  });
});
