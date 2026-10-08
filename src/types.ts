export type DecisionTool =
  | "classify_change"
  | "route_task"
  | "review_risk"
  | "select_tests"
  | "triage_error"
  | "dependency_action"
  | "merge_gate"
  | "command_safety"
  | "check_breaking_change"
  | "assess_task_scope"
  | "assess_test_sufficiency"
  | "assess_migration_safety"
  | "next_action_after_failure"
  | "split_commit"
  | "triage_review_comment";

export interface DecisionEnvelope {
  confidence: number;
  probabilities?: Record<string, number>;
  reasons?: string[];
  needsHumanReview?: boolean;
  [key: string]: unknown;
}

export interface DecisionProvider {
  decide<T extends DecisionEnvelope>(input: {
    tool: DecisionTool;
    payload: unknown;
  }): Promise<T>;
}

export interface PolicyConfig {
  confidenceThreshold: number;
}
