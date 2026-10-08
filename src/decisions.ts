import type { DecisionProvider, DecisionTool } from "./types.js";
import { findConfirmReasons, findDenyReasons } from "./commandRules.js";
import { applyPolicy } from "./policy.js";
import { redactPayload } from "./redact.js";
import {
  assessTaskScopeInput,
  assessTestSufficiencyInput,
  assessMigrationSafetyInput,
  checkBreakingChangeInput,
  classifyChangeInput,
  commandSafetyInput,
  dependencyActionInput,
  MAX_PAYLOAD_CHARS,
  mergeGateInput,
  nextActionAfterFailureInput,
  reviewRiskInput,
  routeTaskInput,
  selectTestsInput,
  splitCommitInput,
  triageReviewCommentInput,
  triageErrorInput,
} from "./schemas.js";
import type { DecisionEnvelope, PolicyConfig } from "./types.js";
import type { z } from "zod";

export function createDecisionHandlers(provider: DecisionProvider, policy: PolicyConfig) {
  return {
    classify_change: (input: unknown) => classifyChange(classifyChangeInput.parse(input), provider, policy),
    route_task: (input: unknown) => run("route_task", routeTaskInput.parse(input), provider, policy),
    review_risk: (input: unknown) => run("review_risk", reviewRiskInput.parse(input), provider, policy),
    select_tests: (input: unknown) => run("select_tests", selectTestsInput.parse(input), provider, policy),
    triage_error: (input: unknown) => run("triage_error", triageErrorInput.parse(input), provider, policy),
    dependency_action: (input: unknown) => run("dependency_action", dependencyActionInput.parse(input), provider, policy),
    merge_gate: (input: unknown) => mergeGate(mergeGateInput.parse(input), provider, policy),
    command_safety: (input: unknown) => commandSafety(commandSafetyInput.parse(input), provider, policy),
    check_breaking_change: (input: unknown) => run("check_breaking_change", checkBreakingChangeInput.parse(input), provider, policy),
    assess_task_scope: (input: unknown) => run("assess_task_scope", assessTaskScopeInput.parse(input), provider, policy),
    assess_test_sufficiency: (input: unknown) => run("assess_test_sufficiency", assessTestSufficiencyInput.parse(input), provider, policy),
    assess_migration_safety: (input: unknown) => run("assess_migration_safety", assessMigrationSafetyInput.parse(input), provider, policy),
    next_action_after_failure: (input: unknown) => run("next_action_after_failure", nextActionAfterFailureInput.parse(input), provider, policy),
    split_commit: (input: unknown) => run("split_commit", splitCommitInput.parse(input), provider, policy),
    triage_review_comment: (input: unknown) => run("triage_review_comment", triageReviewCommentInput.parse(input), provider, policy),
  };
}

function prepare(payload: unknown): unknown {
  const redacted = redactPayload(payload);
  const size = textLength(redacted);
  if (size > MAX_PAYLOAD_CHARS) {
    throw new Error(`Input is too large (${size} characters, limit ${MAX_PAYLOAD_CHARS}); send a smaller diff or fewer files.`);
  }
  return redacted;
}

function textLength(value: unknown): number {
  if (typeof value === "string") return value.length;
  if (Array.isArray(value)) return value.reduce((sum: number, item) => sum + textLength(item), 0);
  if (value !== null && typeof value === "object") {
    return Object.values(value).reduce((sum: number, item) => sum + textLength(item), 0);
  }
  return 0;
}

async function run(tool: DecisionTool, payload: unknown, provider: DecisionProvider, policy: PolicyConfig) {
  return applyPolicy(await provider.decide({ tool, payload: prepare(payload) }), policy);
}

async function mergeGate(
  input: z.infer<typeof mergeGateInput>,
  provider: DecisionProvider,
  policy: PolicyConfig,
): Promise<DecisionEnvelope> {
  const failed = Object.entries(input.checks ?? {}).filter(([, status]) => status === "fail").map(([name]) => name);
  if (failed.length === 0) return guardPass(input, await run("merge_gate", input, provider, policy));
  return applyPolicy({
    decision: "block",
    value: "block",
    confidence: 1,
    probabilities: { pass: 0, review: 0, block: 1 },
    reasons: [`Blocked by failing check(s): ${failed.join(", ")}.`],
  }, policy);
}

// A model "pass" is only trusted when nothing upstream asked for a closer look.
function guardPass(input: z.infer<typeof mergeGateInput>, decision: DecisionEnvelope): DecisionEnvelope {
  if (decision.decision !== "pass") return decision;
  const reasons: string[] = [];
  const notRun = Object.entries(input.checks ?? {}).filter(([, status]) => status === "not_run").map(([name]) => name);
  if (notRun.length > 0) reasons.push(`Check(s) not run: ${notRun.join(", ")}.`);
  const upstream = { changeClassification: input.changeClassification, riskReview: input.riskReview, routeDecision: input.routeDecision };
  for (const [name, value] of Object.entries(upstream)) {
    if (value?.needsHumanReview === true) reasons.push(`${name} requires human review.`);
  }
  const labels = input.changeClassification?.labels;
  if (Array.isArray(labels) && labels.includes("security_sensitive")) reasons.push("Change is labelled security_sensitive.");
  if (reasons.length === 0) return decision;
  return {
    ...decision,
    decision: "review",
    value: "review",
    needsHumanReview: true,
    reasons: [...(decision.reasons ?? []), `Downgraded from pass to review: ${reasons.join(" ")}`],
  };
}

async function commandSafety(
  input: z.infer<typeof commandSafetyInput>,
  provider: DecisionProvider,
  policy: PolicyConfig,
): Promise<DecisionEnvelope> {
  const reasons = findDenyReasons(input.command);
  if (reasons.length > 0) {
    return applyPolicy({
      safety: "deny",
      value: "deny",
      confidence: 1,
      probabilities: { safe: 0, confirm: 0, deny: 1 },
      reasons: reasons.map((reason) => `Denied by rule: ${reason}.`),
    }, policy);
  }

  const confirmReasons = findConfirmReasons(input.command);
  if (confirmReasons.length > 0) {
    return applyPolicy({
      safety: "confirm",
      value: "confirm",
      confidence: 1,
      needsHumanReview: true,
      probabilities: { safe: 0, confirm: 1, deny: 0 },
      reasons: confirmReasons.map((reason) => `Confirmation required by rule: ${reason}.`),
    }, policy);
  }

  return run("command_safety", input, provider, policy);
}

async function classifyChange(
  input: z.infer<typeof classifyChangeInput>,
  provider: DecisionProvider,
  policy: PolicyConfig,
): Promise<DecisionEnvelope> {
  const decision = await provider.decide({ tool: "classify_change", payload: prepare(input) });
  const securityFlagged = Array.isArray(decision.labels) && decision.labels.includes("security_sensitive");
  if (!securityFlagged) return applyPolicy(decision, policy);
  return applyPolicy({
    ...decision,
    needsHumanReview: true,
    reasons: [...(decision.reasons ?? []), "Flagged security_sensitive; human review required regardless of the primary label."],
  }, policy);
}
