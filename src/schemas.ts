import { z } from "zod";

const confidence = z.number().min(0).max(1);

// TypeSafe rejects requests above its token limit; ~100k chars of code was the largest size verified to pass.
export const MAX_PAYLOAD_CHARS = 100_000;
const MAX_DIFF_CHARS = MAX_PAYLOAD_CHARS;
const MAX_TEXT_CHARS = 50_000;
const MAX_LIST_ITEMS = 500;

const diffText = z.string().min(1).max(MAX_DIFF_CHARS);
const text = z.string().max(MAX_TEXT_CHARS);
const boundedRecord = z.record(z.unknown()).refine(
  (value) => JSON.stringify(value).length <= MAX_TEXT_CHARS,
  { message: `must serialize to at most ${MAX_TEXT_CHARS} characters` },
);
const fileList = z.array(z.string().max(1_000)).max(MAX_LIST_ITEMS);

export const classifyChangeInput = z.object({
  diff: diffText,
  changedFiles: fileList.min(1),
  commitMessage: text.optional(),
});

export const routeTaskInput = z.object({
  issue: text.min(1),
  repoContext: text.optional(),
  changedFiles: fileList.optional(),
});

export const reviewRiskInput = z.object({
  diff: diffText,
  changedFiles: fileList.min(1),
  testResults: text.optional(),
  securityResults: text.optional(),
});

export const selectTestsInput = z.object({
  changedFiles: fileList.min(1),
  diff: diffText,
  changedSymbols: fileList.optional(),
  repoContext: text.optional(),
  availableTests: fileList.optional(),
});

export const triageErrorInput = z.object({
  error: text.min(1),
  command: text.optional(),
  changedFiles: fileList.optional(),
  recentChanges: text.optional(),
});

export const dependencyActionInput = z.object({
  dependency: text.min(1),
  requestedVersion: text.optional(),
  packageManager: z.enum(["npm", "pnpm", "yarn", "pip", "go", "cargo", "other"]),
  reason: text.min(1),
  existingPolicy: text.optional(),
  existingDependencies: fileList.optional(),
  license: text.optional(),
  auditResults: text.optional(),
  maintenanceStatus: text.optional(),
  changedFiles: fileList.optional(),
});

export const commandSafetyInput = z.object({
  command: text.min(1),
  cwd: text.optional(),
  purpose: text.optional(),
  repoContext: text.optional(),
});

export const checkBreakingChangeInput = z.object({
  diff: diffText,
  changedFiles: fileList.min(1),
  publicApiContext: text.optional(),
  commitMessage: text.optional(),
});

export const assessTaskScopeInput = z.object({
  task: text.min(1),
  repoContext: text.optional(),
  changedFiles: fileList.optional(),
});

const checkStatus = z.enum(["pass", "fail", "not_run"]);

export const mergeGateInput = z.object({
  checks: z.object({
    tests: checkStatus.optional(),
    lint: checkStatus.optional(),
    security: checkStatus.optional(),
  }).optional(),
  changeClassification: boundedRecord.optional(),
  riskReview: boundedRecord.optional(),
  routeDecision: boundedRecord.optional(),
  testResults: text.optional(),
  lintResults: text.optional(),
  securityResults: text.optional(),
  changeScope: text.optional(),
});

export const decisionOutput = z.object({
  confidence,
  needsHumanReview: z.boolean().optional(),
  reasons: z.array(z.string()).optional(),
}).passthrough();

const choiceOutput = <V extends [string, ...string[]]>(field: string, values: V) =>
  decisionOutput.extend({ [field]: z.enum(values) } as Record<string, z.ZodEnum<V>>);

// Per-tool results, so clients can see which values the main field may take.
export const toolOutputs = {
  classify_change: decisionOutput.extend({
    changeType: z.enum(["safe_refactor", "behavior_change", "security_sensitive", "migration", "unknown"]),
    labels: z.array(z.enum(["behavior_change", "security_sensitive", "migration"])).optional(),
  }),
  route_task: choiceOutput("subsystem", ["frontend", "backend", "infra", "data", "docs", "unknown"]),
  review_risk: choiceOutput("riskLevel", ["low", "medium", "high", "critical"]),
  select_tests: decisionOutput.extend({
    testGroups: z.array(z.string()),
    priority: z.enum(["fast", "normal", "full"]),
  }),
  triage_error: choiceOutput("category", ["type_error", "dependency", "flaky_test", "config", "logic_bug", "environment", "unknown"]),
  dependency_action: choiceOutput("action", ["allow", "pin", "reject", "manual_review"]),
  merge_gate: choiceOutput("decision", ["pass", "review", "block"]),
  command_safety: choiceOutput("safety", ["safe", "confirm", "deny"]),
  check_breaking_change: choiceOutput("compatibility", ["none", "compatible", "breaking", "unknown"]),
  assess_task_scope: choiceOutput("scope", ["small", "needs_split", "needs_clarification"]),
} as const;

export type ToolInput =
  | z.infer<typeof classifyChangeInput>
  | z.infer<typeof routeTaskInput>
  | z.infer<typeof reviewRiskInput>
  | z.infer<typeof selectTestsInput>
  | z.infer<typeof triageErrorInput>
  | z.infer<typeof dependencyActionInput>
  | z.infer<typeof mergeGateInput>
  | z.infer<typeof commandSafetyInput>
  | z.infer<typeof checkBreakingChangeInput>
  | z.infer<typeof assessTaskScopeInput>;
