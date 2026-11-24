import { expect, it, vi } from "vitest";
import { BaseExecutor } from "../../open-sse/executors/base.js";
import { DefaultExecutor } from "../../open-sse/executors/default.js";

it("keeps Claude concurrency at two after merging Gemini continuation execution", async () => {
  const release = [];
  const execute = vi.spyOn(BaseExecutor.prototype, "execute").mockImplementation(() =>
    new Promise((resolve) => release.push(() => resolve({ response: { ok: true } })))
  );
  const executor = new DefaultExecutor("claude");
  const args = { credentials: { connectionId: "fork-concurrency-test" } };
  const pending = [executor.execute(args), executor.execute(args), executor.execute(args)];
  try {
    expect(execute).toHaveBeenCalledTimes(2);
    release.shift()();
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(3));
  } finally {
    release.splice(0).forEach((resolve) => resolve());
    await Promise.all(pending);
    execute.mockRestore();
  }
});
