import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ connections: vi.fn(), settings: vi.fn() }));
vi.mock("@/lib/localDb", () => ({
  getProviderConnections: mocks.connections,
  getSettings: mocks.settings,
  getProxyPools: vi.fn(),
  validateApiKey: vi.fn(),
  updateProviderConnection: vi.fn(),
}));
vi.mock("@/lib/network/connectionProxy", () => ({
  resolveConnectionProxyConfig: vi.fn(async () => ({})), pickProxyPoolId: vi.fn(),
}));
vi.mock("@/sse/utils/logger.js", () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn() }));
const { getProviderCredentials } = await import("@/sse/services/auth.js");

beforeEach(() => { vi.clearAllMocks(); mocks.settings.mockResolvedValue({}); });
const account = (extra) => ({ id: "test-account", apiKey: "mock-key", isActive: true, ...extra });

describe("fork model routing restrictions", () => {
  it("does not allow model suffixes or embedded substrings", async () => {
    mocks.connections.mockResolvedValue([account({ providerSpecificData: { enabledModels: ["gpt-6-sol"] } })]);
    expect(await getProviderCredentials("openai", null, "gpt-6-sol-image")).toBeNull();
    expect(await getProviderCredentials("openai", null, "not-gpt-6-sol")).toBeNull();
    expect(await getProviderCredentials("openai", null, "gpt-6-sol")).toMatchObject({ connectionId: "test-account" });
  });
  it("normalizes IDs, ignores non-string entries, and applies deny lists exactly", async () => {
    mocks.connections.mockResolvedValue([account({ enabledModels: [null, 42, " GPT-6-SOL "] })]);
    expect(await getProviderCredentials("openai", null, "gpt-6-sol")).toMatchObject({ connectionId: "test-account" });
    mocks.connections.mockResolvedValue([account({ disabledModels: [false, {}, " GPT-6-SOL "] })]);
    expect(await getProviderCredentials("openai", null, "gpt-6-sol")).toBeNull();
    expect(await getProviderCredentials("openai", null, "gpt-6-sol-image")).toMatchObject({ connectionId: "test-account" });
  });

  it("applies provider-specific lists across providers and falls back to requestedModel", async () => {
    mocks.connections.mockResolvedValue([account({ providerSpecificData: { enabledModels: ["claude-opus-4-6"] } })]);
    expect(await getProviderCredentials("commandcode", null, null, { requestedModel: "claude-opus-4-6" }))
      .toMatchObject({ connectionId: "test-account" });
    expect(await getProviderCredentials("commandcode", null, null, { requestedModel: "claude-opus-4-6-thinking" }))
      .toBeNull();
  });

});
