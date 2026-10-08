import { z } from "zod";

const confidence = z.number().min(0).max(1);

const MAX_DIFF_CHARS = 200_000;
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
