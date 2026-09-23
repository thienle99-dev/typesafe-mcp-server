import type { DecisionEnvelope, PolicyConfig } from "./types.js";

export function loadPolicy(env: NodeJS.ProcessEnv = process.env): PolicyConfig {
  const threshold = Number(env.DECISION_CONFIDENCE_THRESHOLD ?? "0.97");
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
    throw new Error("DECISION_CONFIDENCE_THRESHOLD must be a number between 0 and 1");
  }
  return { confidenceThreshold: threshold };
}

export function applyPolicy<T extends DecisionEnvelope>(
  decision: T,
  config: PolicyConfig,
): T {
  return {
    ...decision,
    needsHumanReview:
      decision.needsHumanReview === true || decision.confidence < config.confidenceThreshold,
  };
}
