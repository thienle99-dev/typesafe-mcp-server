import { z } from "zod";

const confidence = z.number().min(0).max(1);

const MAX_DIFF_CHARS = 200_000;
const MAX_TEXT_CHARS = 50_000;
const MAX_LIST_ITEMS = 500;

const diffText = z.string().min(1).max(MAX_DIFF_CHARS);
const text = z.string().max(MAX_TEXT_CHARS);
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

const checkStatus = z.enum(["pass", "fail", "not_run"]);

export const mergeGateInput = z.object({
  checks: z.object({
    tests: checkStatus.optional(),
    lint: checkStatus.optional(),
    security: checkStatus.optional(),
  }).optional(),
  changeClassification: z.record(z.unknown()).optional(),
  riskReview: z.record(z.unknown()).optional(),
  routeDecision: z.record(z.unknown()).optional(),
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
  | z.infer<typeof mergeGateInput>;
