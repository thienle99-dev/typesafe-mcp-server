import { describe, expect, it } from "vitest";
import { applyPolicy } from "../src/policy.js";

describe("confidence policy", () => {
  it("requires review below the configured threshold", () => {
    const result = applyPolicy({ confidence: 0.8 }, { confidenceThreshold: 0.97 });
    expect((result as { needsHumanReview?: boolean }).needsHumanReview).toBe(true);
  });

  it("preserves an explicit review requirement", () => {
    const result = applyPolicy(
      { confidence: 0.99, needsHumanReview: true },
      { confidenceThreshold: 0.97 },
    );
    expect(result.needsHumanReview).toBe(true);
  });
});
