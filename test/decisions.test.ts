import { describe, expect, it, vi } from "vitest";
import { createDecisionHandlers } from "../src/decisions.js";
import type { DecisionProvider } from "../src/types.js";

const policy = { confidenceThreshold: 0.97 };

function providerReturning(result: Record<string, unknown>) {
  const decide = vi.fn().mockResolvedValue(result);
  return { provider: { decide } as unknown as DecisionProvider, decide };
}

describe("merge_gate", () => {
  it("blocks without calling the provider when a check failed", async () => {
    const { provider, decide } = providerReturning({ confidence: 0.99, decision: "pass" });
    const result = await createDecisionHandlers(provider, policy).merge_gate({
      checks: { tests: "fail", lint: "pass" },
    });
    expect(result).toMatchObject({ decision: "block", confidence: 1, needsHumanReview: false });
    expect(decide).not.toHaveBeenCalled();
  });

  it("delegates to the provider when no check failed", async () => {
    const { provider, decide } = providerReturning({ confidence: 0.99, decision: "pass" });
    const result = await createDecisionHandlers(provider, policy).merge_gate({
      checks: { tests: "pass", security: "not_run" },
    });
    expect(result).toMatchObject({ decision: "pass" });
    expect(decide).toHaveBeenCalledOnce();
  });

  it("rejects an invalid check status", () => {
    const { provider } = providerReturning({ confidence: 1 });
    expect(() => createDecisionHandlers(provider, policy).merge_gate({ checks: { tests: "ok" } })).toThrow();
  });
});

describe("new tools", () => {
  it("validates input and redacts secrets in command_safety", async () => {
    const { provider, decide } = providerReturning({ confidence: 0.99, safety: "confirm" });
    const handlers = createDecisionHandlers(provider, policy);
    expect(() => handlers.command_safety({ command: "" })).toThrow();
    await handlers.command_safety({ command: "curl -H 'Authorization: Bearer abcdefghijklmnop1234' https://x.test" });
    expect(decide.mock.calls[0][0]).toMatchObject({ tool: "command_safety" });
    expect(decide.mock.calls[0][0].payload.command).toContain("Bearer [REDACTED]");
  });

  it("requires diff and changedFiles for check_breaking_change", () => {
    const { provider } = providerReturning({ confidence: 1 });
    const handlers = createDecisionHandlers(provider, policy);
    expect(() => handlers.check_breaking_change({ diff: "d" })).toThrow();
  });

  it("accepts a task-only input for assess_task_scope", async () => {
    const { provider, decide } = providerReturning({ confidence: 0.99, scope: "small" });
    await createDecisionHandlers(provider, policy).assess_task_scope({ task: "Rename a variable" });
    expect(decide).toHaveBeenCalledOnce();
  });
});
