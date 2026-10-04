import { describe, it, expect } from "vitest";
import { openaiToGeminiRequest } from "../../open-sse/translator/request/openai-to-gemini.js";

// A client (e.g. a subagent runner) may reuse ONE tool_call_id for several
// distinct calls before flushing the results. The translator keys responses by
// tool_call_id; when it did so with a plain id->content map, the later
// occurrence overwrote the earlier one, so the emitted functionResponse carried
// another call's name and content. Gemini requires functionResponse.name to
// match the functionCall with the same id and answers 400 INVALID_ARGUMENT
// ("Request contains an invalid argument."). Once such a pair entered the
// history the whole conversation failed on every account, surfacing as a combo
// 503. Responses are now consumed positionally, each call taking the first
// response that follows it. (prod commit 3a487e9)
function functionResponses(req) {
  return req.contents
    .flatMap((c) => c.parts || [])
    .filter((p) => p.functionResponse)
    .map((p) => ({
      id: p.functionResponse.id,
      name: p.functionResponse.name,
      body: JSON.stringify(p.functionResponse.response),
    }));
}

describe("openai-to-gemini — functionResponse resolves per call, not per id", () => {
  it("keeps each response with the call it follows when a tool_call_id is reused", () => {
    const body = {
      messages: [
        { role: "user", content: "read two files" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            { id: "call_1", type: "function", function: { name: "read_file", arguments: '{"path":"a.txt"}' } },
            { id: "call_1", type: "function", function: { name: "read_file", arguments: '{"path":"b.txt"}' } },
          ],
        },
        { role: "tool", tool_call_id: "call_1", content: "contents-of-a" },
        { role: "tool", tool_call_id: "call_1", content: "contents-of-b" },
      ],
    };

    const responses = functionResponses(openaiToGeminiRequest("gemini-2.5-pro", body, false));

    // Both calls survive (no overwrite) and keep their own response, in order.
    expect(responses.map((r) => r.name)).toEqual(["read_file", "read_file"]);
    expect(responses[0].body).toContain("contents-of-a");
    expect(responses[1].body).toContain("contents-of-b");
  });

  it("takes the response name from the call, so two distinct ids keep their own names", () => {
    const body = {
      messages: [
        { role: "user", content: "go" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            { id: "call_a", type: "function", function: { name: "read_file", arguments: "{}" } },
            { id: "call_b", type: "function", function: { name: "write_file", arguments: "{}" } },
          ],
        },
        { role: "tool", tool_call_id: "call_a", content: "read-ok" },
        { role: "tool", tool_call_id: "call_b", content: "write-ok" },
      ],
    };

    const responses = functionResponses(openaiToGeminiRequest("gemini-2.5-pro", body, false));

    expect(responses.map((r) => [r.id, r.name])).toEqual([
      ["call_a", "read_file"],
      ["call_b", "write_file"],
    ]);
  });
});
