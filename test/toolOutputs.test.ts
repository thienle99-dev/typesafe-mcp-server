import { describe, expect, it, vi } from "vitest";
import { createDecisionHandlers } from "../src/decisions.js";
import { JevHttpProvider } from "../src/jev.js";
import { toolOutputs } from "../src/schemas.js";

const policy = { confidenceThreshold: 0.97 };
const config = { baseUrl: "https://jev.test", apiKey: "test-key", model: "jev", timeoutMs: 1000, maxRetries: 0 };

const inputs = {
  classify_change: { diff: "d", changedFiles: ["a.ts"] },
  route_task: { issue: "fix button" },
  review_risk: { diff: "d", changedFiles: ["a.ts"] },
  select_tests: { changedFiles: ["a.ts"], diff: "diff --git a/a.ts b/a.ts", availableTests: ["unit", "e2e"] },
  triage_error: { error: "boom" },
  dependency_action: { dependency: "zod", packageManager: "pnpm", reason: "validation" },
  merge_gate: { checks: { tests: "pass" } },
  command_safety: { command: "git status" },
  check_breaking_change: { diff: "d", changedFiles: ["a.ts"] },
  assess_task_scope: { task: "rename a variable" },
  assess_test_sufficiency: { diff: "d", changedFiles: ["a.ts"] },
  assess_migration_safety: { diff: "d", changedFiles: ["migrations/001.sql"] },
  next_action_after_failure: { error: "build failed" },
  split_commit: { diff: "d", changedFiles: ["a.ts"] },
  triage_review_comment: { comment: "Potential null dereference" },
} as const;

function mockResponse(tool: keyof typeof toolOutputs) {
  if (tool === "select_tests") {
    return { unit: { type: "noul", noul: 0.9 }, e2e: { type: "noul", noul: 0.1 } };
  }
  if (tool === "route_task") {
    return {
      frontend: { type: "noul", noul: 0.1 },
      backend: { type: "noul", noul: 0.9 },
      infra: { type: "noul", noul: 0.1 },
      data: { type: "noul", noul: 0.1 },
      docs: { type: "noul", noul: 0.1 },
    };
  }
  const main = Object.entries(toolOutputs[tool].shape).find(([key]) => key !== "labels" && "options" in (toolOutputs[tool].shape as any)[key]);
  const values = (main![1] as unknown as { options: string[] }).options;
  const answers: Record<string, unknown> = {
    decision: {
      type: "choice",
      choice: values[0],
      confidence: 0.9,
      probabilities: Object.fromEntries(values.map((value, index) => [value, index === 0 ? 0.9 : 0.1 / (values.length - 1)])),
    },
  };
  if (tool === "classify_change") {
    Object.assign(answers, {
      label_behavior_change: { type: "noul", noul: 0.9 },
      label_security_sensitive: { type: "noul", noul: 0.4 },
      label_migration: { type: "noul", noul: 0.1 },
    });
  }
  return answers;
}

describe("tool outputs", () => {
  it.each(Object.keys(inputs) as Array<keyof typeof toolOutputs>)("%s result satisfies its output schema", async (tool) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ model: "jev", answers: mockResponse(tool) }))));
    const handlers = createDecisionHandlers(new JevHttpProvider(config), policy);
    const result = await handlers[tool](inputs[tool]);
    expect(toolOutputs[tool].safeParse(result).success).toBe(true);
  });

  it("hard-rule results satisfy their schemas", async () => {
    const handlers = createDecisionHandlers({ decide: vi.fn() }, policy);
    expect(toolOutputs.command_safety.safeParse(await handlers.command_safety({ command: "rm -rf /" })).success).toBe(true);
    expect(toolOutputs.merge_gate.safeParse(await handlers.merge_gate({ checks: { tests: "fail" } })).success).toBe(true);
  });

  it("rejects a value outside the enum", () => {
    expect(toolOutputs.command_safety.safeParse({ confidence: 1, safety: "maybe" }).success).toBe(false);
  });
});
