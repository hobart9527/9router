import { describe, it, expect } from "vitest";
import { checkFallbackError, applyErrorState } from "../../open-sse/services/accountFallback.js";

// A 400 is a request-level rejection: the payload is wrong, the account is fine.
// Before this rule existed it fell through to the transient default (30s) and
// locked the model, so one bad payload made every client request for the next
// 30s fail and surfaced as a false 503. Observed live over 24h: 63 antigravity
// 400s -> 63 model locks -> 189 "all 3 accounts locked" -> client 503.
//
// Fallback must stay enabled: a different account, or the combo's next model,
// can still accept the payload (the combo's second model rescued 966 such
// requests with zero failures). Only the lock is wrong.
describe("HTTP 400 does not lock the account", () => {
  it("keeps falling back (next account/model may accept the payload)", () => {
    const { shouldFallback } = checkFallbackError(400, "Request contains an invalid argument.");
    expect(shouldFallback).toBe(true);
  });

  it("reports no cooldown and flags noLock", () => {
    const { cooldownMs, noLock } = checkFallbackError(400, "Request contains an invalid argument.");
    expect(cooldownMs).toBe(0);
    expect(noLock).toBe(true);
  });

  it("leaves the account unlocked and does not advance backoff", () => {
    const before = { backoffLevel: 2, rateLimitedUntil: null, status: "active" };
    const after = applyErrorState(before, 400, "Invalid schema for function '_create_site'");
    expect(after.rateLimitedUntil).toBeNull();
    // A rejected request is not evidence about the account's health.
    expect(after.backoffLevel).toBe(2);
  });

  it("still locks and backs off for account-level errors", () => {
    for (const status of [401, 402, 403, 404]) {
      const { shouldFallback, cooldownMs, noLock } = checkFallbackError(status, "");
      expect(shouldFallback, `status ${status}`).toBe(true);
      expect(cooldownMs, `status ${status}`).toBeGreaterThan(0);
      expect(noLock, `status ${status}`).toBeFalsy();
    }
  });

  it("still backs off on 429 with exponential growth", () => {
    const first = checkFallbackError(429, "");
    const second = checkFallbackError(429, "", 1);
    expect(first.shouldFallback).toBe(true);
    expect(first.cooldownMs).toBeGreaterThan(0);
    expect(second.cooldownMs).toBeGreaterThan(first.cooldownMs);
  });

  it("still applies a transient cooldown to an unclassified status", () => {
    const { shouldFallback, cooldownMs } = checkFallbackError(500, "upstream exploded");
    expect(shouldFallback).toBe(true);
    expect(cooldownMs).toBe(30_000);
  });

  it("lets a text rule win over the 400 status rule", () => {
    // "rate limit" in the body is real signal even when carried on a 400.
    const { shouldFallback, cooldownMs, noLock } = checkFallbackError(400, "rate limit exceeded");
    expect(shouldFallback).toBe(true);
    expect(cooldownMs).toBeGreaterThan(0);
    expect(noLock).toBeFalsy();
  });
});
