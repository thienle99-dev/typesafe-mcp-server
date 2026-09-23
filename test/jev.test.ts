import { describe, expect, it, vi } from "vitest";
import { JevHttpProvider } from "../src/jev.js";

describe("JevHttpProvider", () => {
  it("maps a valid decision response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ decision: "pass", confidence: 0.99 }),
    }));

    const provider = new JevHttpProvider({
      apiUrl: "https://jev.test/decide",
      model: "jev",
      timeoutMs: 1000,
    });
    await expect(provider.decide({ tool: "merge_gate", payload: {} })).resolves.toMatchObject({
      decision: "pass",
      confidence: 0.99,
    });
  });

  it("rejects malformed decisions", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ decision: "pass", confidence: 2 }),
    }));

    const provider = new JevHttpProvider({
      apiUrl: "https://jev.test/decide",
      model: "jev",
      timeoutMs: 1000,
    });
    await expect(provider.decide({ tool: "merge_gate", payload: {} })).rejects.toThrow("confidence");
  });
});
