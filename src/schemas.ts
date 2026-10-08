import { z } from "zod";

const confidence = z.number().min(0).max(1);

export const classifyChangeInput = z.object({
  diff: z.string().min(1),
  changedFiles: z.array(z.string()).min(1),
  commitMessage: z.string().optional(),
});

export const routeTaskInput = z.object({
  issue: z.string().min(1),
  repoContext: z.string().optional(),
  changedFiles: z.array(z.string()).optional(),
});

export const reviewRiskInput = z.object({
  diff: z.string().min(1),
  changedFiles: z.array(z.string()).min(1),
  testResults: z.string().optional(),
  securityResults: z.string().optional(),
});

export const selectTestsInput = z.object({
  changedFiles: z.array(z.string()).min(1),
  changedSymbols: z.array(z.string()).optional(),
  repoContext: z.string().optional(),
  availableTests: z.array(z.string()).optional(),
});

export const triageErrorInput = z.object({
  error: z.string().min(1),
  command: z.string().optional(),
  changedFiles: z.array(z.string()).optional(),
  recentChanges: z.string().optional(),
});

export const dependencyActionInput = z.object({
  dependency: z.string().min(1),
  requestedVersion: z.string().optional(),
  packageManager: z.enum(["npm", "pnpm", "yarn", "pip", "go", "cargo", "other"]),
  reason: z.string().min(1),
  existingPolicy: z.string().optional(),
  changedFiles: z.array(z.string()).optional(),
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
  testResults: z.string().optional(),
  lintResults: z.string().optional(),
  securityResults: z.string().optional(),
  changeScope: z.string().optional(),
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
