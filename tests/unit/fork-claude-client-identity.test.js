import { describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("undici", async () => ({ ...await vi.importActual("undici"), fetch: mocks.fetch }));
import { DefaultExecutor } from "../../open-sse/executors/default.js";

describe("fork Claude client identity", () => {
  it("preserves real client UA through outbound transport instead of applying spoof version", async () => {
    mocks.fetch.mockResolvedValue(new Response(JSON.stringify({ id: "mock" }), {
      status: 200, headers: { "Content-Type": "application/json" },
    }));
    const executor = new DefaultExecutor("claude");
    const ua = "claude-cli/2.1.200 (external, sdk-cli)";
    await executor.execute({
      model: "claude-opus-4-6", body: { messages: [] }, stream: false,
      credentials: { accessToken: "mock", rawHeaders: { "user-agent": ua } },
    });
    expect(mocks.fetch).toHaveBeenCalledOnce();
    expect(mocks.fetch.mock.calls[0][1].headers["User-Agent"]).toBe(ua);
  });
});
