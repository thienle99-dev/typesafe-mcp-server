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
      testGroups: ["unit"],
      priority: "normal",
      uncertainGroups: ["e2e"],
      reasons: [
        "Selected 1 of 3 test group(s): unit.",
        "Borderline (30-70%), consider running: e2e.",
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
});
