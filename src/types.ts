export type DecisionTool =
  | "classify_change"
  | "route_task"
  | "review_risk"
  | "select_tests"
  | "triage_error"
  | "dependency_action"
  | "merge_gate";

export interface DecisionEnvelope {
  confidence: number;
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
