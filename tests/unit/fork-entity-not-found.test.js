import { describe, expect, it } from "vitest";
import { checkFallbackError } from "../../open-sse/services/accountFallback.js";

describe("entity not found classification", () => {
  it("does not lock healthy accounts for missing request entities", () => {
    expect(checkFallbackError(400, "Requested entity was not found.", 0, "gemini"))
      .toMatchObject({ shouldFallback: true, noLock: true, cooldownMs: 0, requestScoped: true });
  });
  it("keeps existing bounded cooldown for missing models and auth failures", () => {
    for (const status of [401, 403, 404]) {
      expect(checkFallbackError(status, "Requested entity was not found.", 0, "gemini").cooldownMs)
        .toBe(120000);
    }
    expect(checkFallbackError(400, "model is unavailable", 0, "gemini").cooldownMs).toBe(1800000);
  });
});
