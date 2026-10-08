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
