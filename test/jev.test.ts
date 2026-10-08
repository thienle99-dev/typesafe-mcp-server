import { describe, expect, it, vi } from "vitest";
import { JevHttpProvider } from "../src/jev.js";

describe("JevHttpProvider", () => {
  it("maps a valid decision response", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
        model: "jev-1.13.0",
        answers: {
          decision: {
            type: "choice",
            choice: "pass",
            confidence: 0.99,
            probabilities: { pass: 0.99, review: 0.01, block: 0 },
          },
        },
      })));
    vi.stubGlobal("fetch", fetchMock);

    const provider = new JevHttpProvider({
      baseUrl: "https://jev.test",
      apiKey: "test-key",
      model: "jev",
      timeoutMs: 1000,
      maxRetries: 0,
    });
    await expect(provider.decide({ tool: "merge_gate", payload: {} })).resolves.toMatchObject({
      decision: "pass",
      confidence: 0.99,
      runnerUp: { value: "review", probability: 0.01 },
      reasons: ["Selected 'pass' (99%); runner-up 'review' (1%), margin 98%."],
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://jev.test/v1/systemone",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer test-key" }),
        body: expect.stringContaining('"questions"'),
      }),
    );
  });

  it("rejects malformed decisions", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ model: "jev-1.13.0", answers: "invalid" })),
    ));

    const provider = new JevHttpProvider({
      baseUrl: "https://jev.test",
      apiKey: "test-key",
      model: "jev",
      timeoutMs: 1000,
      maxRetries: 0,
    });
    await expect(provider.decide({ tool: "merge_gate", payload: {} })).rejects.toThrow("missing the decision");
  });

  it("selects test groups and reports uncertain ones", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      model: "jev-1.13.0",
      answers: {
        unit: { type: "noul", noul: 0.99 },
        e2e: { type: "noul", noul: 0.4 },
        lint: { type: "noul", noul: 0.05 },
      },
    }))));
    const provider = new JevHttpProvider({
      baseUrl: "https://jev.test",
      apiKey: "test-key",
      model: "jev",
      timeoutMs: 1000,
      maxRetries: 0,
    });
    await expect(provider.decide({
      tool: "select_tests",
      payload: { changedFiles: ["a.ts"], availableTests: ["unit", "e2e", "lint"] },
    })).resolves.toMatchObject({
      testGroups: ["unit", "e2e"],
      priority: "normal",
      confidence: 0.95,
      uncertainGroups: ["e2e"],
      reasons: [
        "Selected 2 of 3 test group(s): unit, e2e.",
        "Borderline groups (30-70%) included conservatively: e2e.",
      ],
    });
  });

  it.each([
    ["command_safety", "safety", "confirm", ["safe", "confirm", "deny"]],
    ["check_breaking_change", "compatibility", "breaking", ["none", "compatible", "breaking", "unknown"]],
    ["assess_task_scope", "scope", "needs_split", ["small", "needs_split", "needs_clarification"]],
  ] as const)("maps %s to %s", async (tool, field, choiceValue, choices) => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      model: "jev-1.13.0",
      answers: {
        decision: {
          type: "choice",
          choice: choiceValue,
          confidence: 0.9,
          probabilities: Object.fromEntries(choices.map((name) => [name, name === choiceValue ? 0.9 : 0.1 / (choices.length - 1)])),
        },
      },
    })));
    vi.stubGlobal("fetch", fetchMock);
    const provider = new JevHttpProvider({
      baseUrl: "https://jev.test",
      apiKey: "test-key",
      model: "jev",
      timeoutMs: 1000,
      maxRetries: 0,
    });
    await expect(provider.decide({ tool, payload: {} })).resolves.toMatchObject({ [field]: choiceValue, confidence: 0.9 });
    const body = String(fetchMock.mock.calls[0][1].body);
    for (const name of choices) expect(body).toContain(name);
  });

  it.each([
    [{ type: "score", score: 3.5, confidence: 0.9, probabilities: { "3": 0.5, "4": 0.4 } }, "Score 3.5 (confidence 90%)."],
    [{ type: "noul", noul: 0.8 }, "Probability 80% that the answer is yes."],
  ])("describes %j", async (answer, reason) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      model: "jev-1.13.0",
      answers: { decision: answer },
    }))));
    const provider = new JevHttpProvider({
      baseUrl: "https://jev.test",
      apiKey: "test-key",
      model: "jev",
      timeoutMs: 1000,
      maxRetries: 0,
    });
    await expect(provider.decide({ tool: "merge_gate", payload: {} })).resolves.toMatchObject({ reasons: [reason] });
  });

  it("reports full confidence when every group is selected", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      model: "jev-1.13.0",
      answers: { unit: { type: "noul", noul: 0.76 }, e2e: { type: "noul", noul: 0.38 } },
    }))));
    const provider = new JevHttpProvider({
      baseUrl: "https://jev.test",
      apiKey: "test-key",
      model: "jev",
      timeoutMs: 1000,
      maxRetries: 0,
    });
    await expect(provider.decide({
      tool: "select_tests",
      payload: { changedFiles: ["a.ts"], availableTests: ["unit", "e2e"] },
    })).resolves.toMatchObject({ testGroups: ["unit", "e2e"], confidence: 1 });
  });

  it("bases select_tests confidence only on skipped groups", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      model: "jev-1.13.0",
      answers: {
        unit: { type: "noul", noul: 0.95 },
        integration: { type: "noul", noul: 0.2 },
      },
    }))));
    const provider = new JevHttpProvider({
      baseUrl: "https://jev.test",
      apiKey: "test-key",
      model: "jev",
      timeoutMs: 1000,
      maxRetries: 0,
    });
    const result = await provider.decide({
      tool: "select_tests",
      payload: { changedFiles: ["a.ts"], availableTests: ["unit", "integration"] },
    });
    expect(result).toMatchObject({
      testGroups: ["unit"],
      confidence: 0.8,
    });
    expect(result.confidence).not.toBe(0.2);
    expect(result.confidence).not.toBe(0.95);
    expect(result.reasons).toEqual(["Selected 1 of 2 test group(s): unit."]);
  });

  it("rejects a select_tests response without noul answers", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ model: "jev-1.13.0", answers: "invalid" }))));
    const provider = new JevHttpProvider({
      baseUrl: "https://jev.test",
      apiKey: "test-key",
      model: "jev",
      timeoutMs: 1000,
      maxRetries: 0,
    });
    await expect(provider.decide({ tool: "select_tests", payload: { changedFiles: ["a.ts"] } })).rejects.toThrow("missing the test group");
  });

  describe("classify_change labels", () => {
    const config = { baseUrl: "https://jev.test", apiKey: "test-key", model: "jev", timeoutMs: 1000, maxRetries: 0 };
    const decision = {
      type: "choice",
      choice: "behavior_change",
      confidence: 0.95,
      probabilities: { safe_refactor: 0.01, behavior_change: 0.9, security_sensitive: 0.05, migration: 0.02, unknown: 0.02 },
    };

    it("asks one noul question per label next to the choice", async () => {
      const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ model: "jev-1.13.0", answers: { decision } })));
      vi.stubGlobal("fetch", fetchMock);
      await new JevHttpProvider(config).decide({ tool: "classify_change", payload: {} });
      const body = String(fetchMock.mock.calls[0][1].body);
      for (const key of ["decision", "label_behavior_change", "label_security_sensitive", "label_migration"]) {
        expect(body).toContain(`"${key}"`);
      }
    });

    it("returns every label above the threshold and keeps changeType", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
        model: "jev-1.13.0",
        answers: {
          decision,
          label_behavior_change: { type: "noul", noul: 0.92 },
          label_security_sensitive: { type: "noul", noul: 0.41 },
          label_migration: { type: "noul", noul: 0.04 },
        },
      }))));
      const result = await new JevHttpProvider(config).decide({ tool: "classify_change", payload: {} });
      expect(result).toMatchObject({
        changeType: "behavior_change",
        confidence: 0.95,
        labels: ["behavior_change", "security_sensitive"],
        labelProbabilities: { behavior_change: 0.92, security_sensitive: 0.41, migration: 0.04 },
      });
      expect(result.reasons).toContain("Also flagged: security_sensitive (41%).");
    });

    it("still works when label answers are missing", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ model: "jev-1.13.0", answers: { decision } }))));
      const result = await new JevHttpProvider(config).decide({ tool: "classify_change", payload: {} });
      expect(result).toMatchObject({ changeType: "behavior_change" });
      expect(result).not.toHaveProperty("labels");
      expectConcreteReasons(result.reasons);
    });

    it("uses a higher threshold for behavior_change than for security and migration", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
        model: "jev-1.13.0",
        answers: {
          decision: { ...decision, choice: "migration", probabilities: { safe_refactor: 0.01, behavior_change: 0.05, security_sensitive: 0.02, migration: 0.9, unknown: 0.02 } },
          label_behavior_change: { type: "noul", noul: 0.49 },
          label_security_sensitive: { type: "noul", noul: 0.29 },
          label_migration: { type: "noul", noul: 0.3 },
        },
      }))));
      const result = await new JevHttpProvider(config).decide({ tool: "classify_change", payload: {} });
      expect(result).toMatchObject({ labels: ["migration"] });
      expect(result.labels).not.toContain("behavior_change");
      expect(result.labels).not.toContain("security_sensitive");
      expectConcreteReasons(result.reasons);
    });

    it("includes security and migration at 0.3 and behavior_change at 0.5", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
        model: "jev-1.13.0",
        answers: {
          decision: { ...decision, choice: "safe_refactor", confidence: 0.99, probabilities: { safe_refactor: 0.99, behavior_change: 0.01, security_sensitive: 0, migration: 0, unknown: 0 } },
          label_behavior_change: { type: "noul", noul: 0.5 },
          label_security_sensitive: { type: "noul", noul: 0.3 },
          label_migration: { type: "noul", noul: 0.3 },
        },
      }))));
      const result = await new JevHttpProvider(config).decide({ tool: "classify_change", payload: {} });
      expect(result.changeType).toBe("safe_refactor");
      expect(result.labels).toEqual(["behavior_change", "security_sensitive", "migration"]);
      expect(result.labels).not.toContain("safe_refactor");
    });

    it("keeps changeType when that label stays under its threshold", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
        model: "jev-1.13.0",
        answers: {
          decision,
          label_behavior_change: { type: "noul", noul: 0.2 },
          label_security_sensitive: { type: "noul", noul: 0.41 },
          label_migration: { type: "noul", noul: 0.04 },
        },
      }))));
      const result = await new JevHttpProvider(config).decide({ tool: "classify_change", payload: {} });
      expect(result.changeType).toBe("behavior_change");
      expect(result.labels).toEqual(["security_sensitive"]);
      expect(result.labels).not.toContain("behavior_change");
    });
  });

  it("turns max_tokens_exceeded into a readable error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async () =>
      new Response(JSON.stringify({ detail: { error_type: "max_tokens_exceeded" } }), { status: 400 })));
    const provider = new JevHttpProvider({ baseUrl: "https://jev.test", apiKey: "test-key", model: "jev", timeoutMs: 1000, maxRetries: 0 });
    await expect(provider.decide({ tool: "review_risk", payload: {} })).rejects.toThrow("Input is too large for TypeSafe");
  });
});

const REASON_PATTERNS = [
  /^Selected '[^']+'\.$/,
  /^Selected '[^']+' \(\d+%\); runner-up '[^']+' \(\d+%\), margin -?\d+%\.$/,
  /^Score /,
  /^Probability \d+% that the answer is yes\.$/,
  /^Selected \d+ of \d+ test group\(s\): /,
  /^Borderline groups \(30-70%\) included conservatively: /,
  /^Also flagged: /,
];

function expectConcreteReasons(reasons: unknown) {
  expect(Array.isArray(reasons)).toBe(true);
  expect(reasons).not.toHaveLength(0);
  for (const reason of reasons as string[]) {
    expect(reason).not.toMatch(/Jev selected/i);
    expect(REASON_PATTERNS.some((pattern) => pattern.test(reason))).toBe(true);
  }
}
