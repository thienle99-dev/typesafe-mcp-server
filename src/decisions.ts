import type { DecisionProvider, DecisionTool } from "./types.js";
import { applyPolicy } from "./policy.js";
import {
  classifyChangeInput,
  dependencyActionInput,
  mergeGateInput,
  reviewRiskInput,
  routeTaskInput,
  selectTestsInput,
  triageErrorInput,
} from "./schemas.js";
import type { PolicyConfig } from "./types.js";

export function createDecisionHandlers(provider: DecisionProvider, policy: PolicyConfig) {
  return {
    classify_change: (input: unknown) => run("classify_change", classifyChangeInput.parse(input), provider, policy),
    route_task: (input: unknown) => run("route_task", routeTaskInput.parse(input), provider, policy),
    review_risk: (input: unknown) => run("review_risk", reviewRiskInput.parse(input), provider, policy),
    select_tests: (input: unknown) => run("select_tests", selectTestsInput.parse(input), provider, policy),
    triage_error: (input: unknown) => run("triage_error", triageErrorInput.parse(input), provider, policy),
    dependency_action: (input: unknown) => run("dependency_action", dependencyActionInput.parse(input), provider, policy),
    merge_gate: (input: unknown) => run("merge_gate", mergeGateInput.parse(input), provider, policy),
  };
}

async function run(tool: DecisionTool, payload: unknown, provider: DecisionProvider, policy: PolicyConfig) {
  return applyPolicy(await provider.decide({ tool, payload }), policy);
}
