import { describe, expect, it, vi } from "vitest";
import { JevHttpProvider } from "../src/jev.js";

describe("JevHttpProvider", () => {
  it("maps a valid decision response", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        model: "jev-1.13.0",
        answers: {
          decision: {
            type: "choice",
            choice: "pass",
            confidence: 0.99,
            probabilities: { pass: 0.99, review: 0.01, block: 0 },
          },
        },
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const provider = new JevHttpProvider({
      apiUrl: "https://jev.test/decide",
      apiKey: "test-key",
      model: "jev",
      timeoutMs: 1000,
      maxRetries: 0,
    });
    await expect(provider.decide({ tool: "merge_gate", payload: {} })).resolves.toMatchObject({
      decision: "pass",
      confidence: 0.99,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://jev.test/decide",
      expect.objectContaining({
        headers: expect.objectContaining({ authorization: "Bearer test-key" }),
        body: expect.stringContaining('"questions"'),
      }),
    );
  });

  it("rejects malformed decisions", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ model: "jev-1.13.0", answers: "invalid" }),
    }));

    const provider = new JevHttpProvider({
      apiUrl: "https://jev.test/decide",
      apiKey: "test-key",
      model: "jev",
      timeoutMs: 1000,
      maxRetries: 0,
    });
    await expect(provider.decide({ tool: "merge_gate", payload: {} })).rejects.toThrow("answers shape");
  });
});
