import type { DecisionProvider, DecisionTool } from "./types.js";
import { findDenyReasons } from "./commandRules.js";
import { applyPolicy } from "./policy.js";
import { redactPayload } from "./redact.js";
import {
  assessTaskScopeInput,
  checkBreakingChangeInput,
  classifyChangeInput,
  commandSafetyInput,
  dependencyActionInput,
  mergeGateInput,
  reviewRiskInput,
  routeTaskInput,
  selectTestsInput,
  triageErrorInput,
} from "./schemas.js";
import type { DecisionEnvelope, PolicyConfig } from "./types.js";
import type { z } from "zod";

export function createDecisionHandlers(provider: DecisionProvider, policy: PolicyConfig) {
  return {
    classify_change: (input: unknown) => run("classify_change", classifyChangeInput.parse(input), provider, policy),
    route_task: (input: unknown) => run("route_task", routeTaskInput.parse(input), provider, policy),
    review_risk: (input: unknown) => run("review_risk", reviewRiskInput.parse(input), provider, policy),
    select_tests: (input: unknown) => run("select_tests", selectTestsInput.parse(input), provider, policy),
    triage_error: (input: unknown) => run("triage_error", triageErrorInput.parse(input), provider, policy),
    dependency_action: (input: unknown) => run("dependency_action", dependencyActionInput.parse(input), provider, policy),
    merge_gate: (input: unknown) => mergeGate(mergeGateInput.parse(input), provider, policy),
    command_safety: (input: unknown) => commandSafety(commandSafetyInput.parse(input), provider, policy),
    check_breaking_change: (input: unknown) => run("check_breaking_change", checkBreakingChangeInput.parse(input), provider, policy),
    assess_task_scope: (input: unknown) => run("assess_task_scope", assessTaskScopeInput.parse(input), provider, policy),
  };
}

async function run(tool: DecisionTool, payload: unknown, provider: DecisionProvider, policy: PolicyConfig) {
  return applyPolicy(await provider.decide({ tool, payload: redactPayload(payload) }), policy);
}

async function mergeGate(
  input: z.infer<typeof mergeGateInput>,
  provider: DecisionProvider,
  policy: PolicyConfig,
): Promise<DecisionEnvelope> {
  const failed = Object.entries(input.checks ?? {}).filter(([, status]) => status === "fail").map(([name]) => name);
  if (failed.length === 0) return run("merge_gate", input, provider, policy);
  return applyPolicy({
    decision: "block",
    value: "block",
    confidence: 1,
    probabilities: { pass: 0, review: 0, block: 1 },
    reasons: [`Blocked by failing check(s): ${failed.join(", ")}.`],
  }, policy);
}

async function commandSafety(
  input: z.infer<typeof commandSafetyInput>,
  provider: DecisionProvider,
  policy: PolicyConfig,
): Promise<DecisionEnvelope> {
  const reasons = findDenyReasons(input.command);
  if (reasons.length === 0) return run("command_safety", input, provider, policy);
  return applyPolicy({
    safety: "deny",
    value: "deny",
    confidence: 1,
    probabilities: { safe: 0, confirm: 0, deny: 1 },
    reasons: reasons.map((reason) => `Denied by rule: ${reason}.`),
  }, policy);
}
