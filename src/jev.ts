import { choice, noul, TypeSafeClient } from "@typesafe-ai/sdk";
import type { DecisionEnvelope, DecisionProvider, DecisionTool } from "./types.js";

// Running an extra test group is cheap and missing one is costly, so a group is
// selected from 0.3 up (not 0.5). Groups in [SELECT_THRESHOLD, BORDERLINE_MAX) are
// reported as uncertain; confidence only reflects how sure we are about skipped groups.
const SELECT_THRESHOLD = 0.3;
const BORDERLINE_MAX = 0.7;
const ROUTE_SUBSYSTEMS = ["frontend", "backend", "infra", "data", "docs"] as const;
const ROUTE_THRESHOLD = 0.5;
const SPLIT_STRATEGIES = ["contracts_first", "subsystem_slices", "migration_first", "vertical_slices", "unknown"] as const;

// classify_change also asks one yes/no question per label so a change can carry several.
const CHANGE_LABEL_QUESTIONS = {
  behavior_change: "Does this change alter runtime or product behavior?",
  security_sensitive: "Does this change touch authentication, authorization, secrets, or security controls?",
  migration: "Does this change schema, data, or migration behavior?",
} as const;
const LABEL_PREFIX = "label_";
// Missing a security or migration flag costs more than a spurious one, while
// behavior_change is flagged often enough that a low threshold would only add noise.
const LABEL_THRESHOLDS: Record<keyof typeof CHANGE_LABEL_QUESTIONS, number> = {
  behavior_change: 0.5,
  security_sensitive: 0.3,
  migration: 0.3,
};

type Question = ReturnType<typeof choice> | ReturnType<typeof noul>;

interface TypeSafeAnswer {
  type: "choice" | "score" | "noul";
  choice?: string;
  score?: number;
  noul?: number;
  confidence?: number;
  probabilities?: Record<string, number>;
}

export interface JevConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
  maxRetries: number;
}

export function loadJevConfig(env: NodeJS.ProcessEnv = process.env): JevConfig {
  const apiKey = env.TYPESAFE_API_KEY ?? env.JEV_API_KEY;
  if (!apiKey) throw new Error("TYPESAFE_API_KEY is required");

  const timeoutMs = Number(env.TYPESAFE_TIMEOUT_MS ?? env.JEV_TIMEOUT_MS ?? "10000");
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("TYPESAFE_TIMEOUT_MS must be a positive number");
  }

  const maxRetries = Number(env.TYPESAFE_MAX_RETRIES ?? "3");
  if (!Number.isInteger(maxRetries) || maxRetries < 0) {
    throw new Error("TYPESAFE_MAX_RETRIES must be a non-negative integer");
  }

  return {
    baseUrl: normalizeBaseUrl(env.TYPESAFE_API_URL ?? env.JEV_API_URL ?? "https://api.typesafe.ai"),
    apiKey,
    model: env.TYPESAFE_MODEL ?? env.JEV_MODEL ?? "jev-latest",
    timeoutMs,
    maxRetries,
  };
}

export class JevHttpProvider implements DecisionProvider {
  private readonly client: TypeSafeClient;

  public constructor(config: JevConfig) {
    this.client = new TypeSafeClient({
      apiKey: config.apiKey,
      baseURL: config.baseUrl,
      defaultModel: config.model,
      timeout: config.timeoutMs,
      retry: { maxRetries: config.maxRetries },
    });
  }

  public async decide<T extends DecisionEnvelope>(input: {
    tool: DecisionTool;
    payload: unknown;
  }): Promise<T> {
    const request = toTypeSafeRequest(input.tool, input.payload, this.client.defaultModel);
    let response: { answers: Record<string, TypeSafeAnswer> };
    try {
      response = await this.client.systemOne(request as any) as unknown as typeof response;
    } catch (error) {
      if (error instanceof Error && error.message.includes("max_tokens_exceeded")) {
        throw new Error("Input is too large for TypeSafe (max_tokens_exceeded); send a smaller diff or fewer files.");
      }
      throw error;
    }
    return fromTypeSafeResponse(input.tool, response) as T;
  }
}

function normalizeBaseUrl(value: string): string {
  return value.replace(/\/v1\/systemone\/?$/, "").replace(/\/$/, "");
}

function toTypeSafeRequest(tool: DecisionTool, payload: unknown, model: string) {
  const state = payload as Record<string, unknown>;
  if (tool === "select_tests") {
    const groups = getTestGroups(state);
    return {
      state,
      model,
      questions: Object.fromEntries(
        groups.map((group) => [group, noul(`Based on the provided diff, should the ${group} test group run for these code changes? Use the diff as evidence; changed file names and symbols alone are not enough.`)]),
      ) as Record<string, Question>,
    };
  }

  if (tool === "route_task") {
    return {
      state,
      model,
      questions: Object.fromEntries(
        ROUTE_SUBSYSTEMS.map((subsystem) => [
          subsystem,
          noul(`Does this task materially involve the ${subsystem} subsystem? Select yes when implementation or review needs to touch it, even if another subsystem is also involved.`),
        ]),
      ) as Record<string, Question>,
    };
  }

  const questions: Record<string, Question> = { decision: questionFor(tool) };
  if (tool === "classify_change") {
    for (const [label, question] of Object.entries(CHANGE_LABEL_QUESTIONS)) {
      questions[`${LABEL_PREFIX}${label}`] = noul(question);
    }
  }
  if (tool === "assess_task_scope") {
    questions.split_plan = choice("If this task needs splitting, which ordered approach best fits the task and repository context?", {
      contracts_first: "Define shared API, schema, or data contracts first, then update producers and consumers, and finish with integration tests",
      subsystem_slices: "Implement one subsystem or package at a time, validate each slice, and integrate them at the end",
      migration_first: "Plan compatibility and data migration first, update dependent services in order, then verify rollout and integrity",
      vertical_slices: "Deliver independently testable end-to-end feature slices, each spanning the layers it needs",
      unknown: "There is not enough detail to choose an ordering strategy",
    });
  }
  return { state, model, questions };
}

function questionFor(tool: Exclude<DecisionTool, "select_tests" | "route_task">): Question {
  switch (tool) {
    case "classify_change":
      return choice("Classify this code change", {
        safe_refactor: "Behavior-preserving refactor",
        behavior_change: "Changes runtime or product behavior",
        security_sensitive: "Touches authentication, authorization, secrets, or security controls",
        migration: "Changes schema, data, or migration behavior",
        unknown: "Insufficient evidence to classify confidently",
      });
    case "review_risk":
      return choice("What is the overall risk level of this diff, considering the structured check statuses first and any free-text results as supporting context? Treat failed checks as risk evidence and not_run checks as missing evidence.", {
        low: "Small, well-isolated change with low blast radius",
        medium: "Moderate behavior or integration risk",
        high: "Large blast radius, sensitive behavior, or weak test evidence",
        critical: "Likely security, data-loss, production, or irreversible risk",
      });
    case "triage_error":
      return choice("What is the most likely root-cause category?", {
        type_error: "Type checking, compiler, or static type mismatch",
        dependency: "Package, module, version, or lockfile issue",
        flaky_test: "Non-deterministic or timing-dependent test failure",
        config: "Configuration, environment variable, or build setup issue",
        logic_bug: "Incorrect application behavior or implementation logic",
        environment: "Machine, service, network, or runtime environment issue",
        unknown: "Insufficient evidence to classify confidently",
      });
    case "dependency_action":
      return choice("Given the repository's existing dependencies, license, security audit and maintenance evidence, what action should be taken for this dependency request? Do not infer package health from its name. Prefer an existing equivalent when appropriate; if material evidence is missing or inconclusive, choose manual_review.", {
        allow: "Evidence supports adding this dependency and requested version",
        pin: "Evidence supports it only with an exact or constrained version",
        reject: "Evidence shows it should not be added",
        manual_review: "Evidence is missing, inconclusive, or needs human review",
      });
    case "merge_gate":
      return choice("What should the merge gate decide?", {
        pass: "All available evidence supports safe merge",
        review: "A human should review before merge",
        block: "Merge must be blocked until blockers are resolved",
      });
    case "command_safety":
      return choice("How safe is it for a coding agent to run this shell command?", {
        safe: "Read-only or easily reversible, limited to the working directory or project",
        confirm: "Modifies or deletes data, installs packages, writes over the network, uses sudo, or has unclear impact; ask the user first",
        deny: "Destructive, irreversible, or broad in scope (for example recursive delete of important paths, force push, dropping data, piping remote scripts to a shell)",
      });
    case "check_breaking_change":
      return choice("Does this diff break backward compatibility for consumers? Use publicApiContext to identify which changed symbols/files are public; callers should provide this context. Inspect explicit export or re-export evidence in the diff when available. Do not assume every changed symbol is public. Return unknown only when public visibility or compatibility impact cannot be established from the diff and context.", {
        none: "No consumer-visible change",
        compatible: "Consumer-visible but backward compatible, such as additive changes",
        breaking: "Removes or changes existing behavior, signatures, schema, or output that consumers may rely on",
        unknown: "Insufficient evidence to decide",
      });
    case "assess_task_scope":
      return choice("How should a coding agent handle this task? Consider task breadth, changed files, repoContext, and repoStats. A large repository alone does not require splitting; weigh coordination and dependency costs.", {
        small: "Well-defined and small enough to implement in one step",
        needs_split: "Large or multi-part; should be split into smaller ordered steps",
        needs_clarification: "Missing requirements, constraints, or acceptance criteria; ask the user before coding",
      });
  }
}

function getTestGroups(state: Record<string, unknown>): string[] {
  const available = state.availableTests;
  if (Array.isArray(available) && available.every((item) => typeof item === "string") && available.length > 0) {
    return available as string[];
  }
  return ["unit", "integration", "e2e", "lint", "security"];
}

function fromTypeSafeResponse(tool: DecisionTool, response: { answers: Record<string, TypeSafeAnswer> }): DecisionEnvelope {
  if (tool === "route_task") {
    const missing = ROUTE_SUBSYSTEMS.filter((subsystem) => {
      const answer = response.answers[subsystem];
      return answer?.type !== "noul" || typeof answer.noul !== "number";
    });
    if (missing.length > 0) throw new Error(`TypeSafe response is missing route subsystem answers: ${missing.join(", ")}`);

    const probabilities = Object.fromEntries(
      ROUTE_SUBSYSTEMS.map((subsystem) => [subsystem, response.answers[subsystem]!.noul!]),
    );
    const selected = ROUTE_SUBSYSTEMS.filter((subsystem) => probabilities[subsystem] >= ROUTE_THRESHOLD);
    const ordered = selected.sort((a, b) => probabilities[b] - probabilities[a]);
    const subsystems = ordered.length > 0 ? ordered : ["unknown"];
    const confidence = Math.round(Math.min(...ROUTE_SUBSYSTEMS.map((subsystem) => Math.max(probabilities[subsystem], 1 - probabilities[subsystem]))) * 10_000) / 10_000;
    const borderline = ROUTE_SUBSYSTEMS.filter((subsystem) => probabilities[subsystem] >= 0.3 && probabilities[subsystem] < 0.7);
    return {
      value: subsystems[0],
      subsystem: subsystems[0],
      subsystems,
      confidence,
      probabilities,
      reasons: [
        `Subsystems selected: ${subsystems.join(", ")}.`,
        ...(borderline.length > 0 ? [`Borderline subsystem scores (30-70%): ${borderline.map((subsystem) => `${subsystem} (${Math.round(probabilities[subsystem] * 100)}%)`).join(", ")}.`] : []),
      ],
    };
  }

  if (tool === "select_tests") {
    const noulAnswers = Object.entries(response.answers)
      .filter((entry): entry is [string, TypeSafeAnswer & { type: "noul"; noul: number }] => entry[1].type === "noul" && typeof entry[1].noul === "number");
    if (noulAnswers.length === 0) throw new Error("TypeSafe response is missing the test group answers");
    const selected = noulAnswers.filter(([, answer]) => answer.noul >= SELECT_THRESHOLD).map(([group]) => group);
    const probabilities = Object.fromEntries(noulAnswers.map(([group, answer]) => [group, answer.noul]));
    const uncertainGroups = noulAnswers.filter(([, answer]) => answer.noul >= SELECT_THRESHOLD && answer.noul < BORDERLINE_MAX).map(([group]) => group);
    return {
      value: selected,
      testGroups: selected,
      testPatterns: selected,
      priority: selected.length > 2 ? "full" : selected.length > 0 ? "normal" : "fast",
      confidence: skippedGroupsConfidence(noulAnswers),
      probabilities,
      uncertainGroups,
      reasons: describeTestSelection(selected, uncertainGroups, noulAnswers.length),
    };
  }

  const answer = response.answers.decision;
  if (!answer) throw new Error("TypeSafe response is missing the decision answer");

  if (answer.type === "choice" && answer.choice && answer.probabilities && typeof answer.confidence === "number") {
    const described = describeChoice(answer.choice, answer.probabilities);
    const labels = tool === "classify_change" ? describeLabels(answer.choice, response.answers) : {};
    const splitPlan = tool === "assess_task_scope" ? suggestSplitPlan(answer.choice, response.answers.split_plan) : {};
    return {
      value: answer.choice,
      confidence: answer.confidence,
      probabilities: answer.probabilities,
      ...described,
      ...labels,
      ...splitPlan,
      reasons: [...described.reasons, ...(labels.reasons ?? []), ...(splitPlan.reasons ?? [])],
      ...fieldFor(tool, answer.choice),
    };
  }

  if (answer.type === "score" && typeof answer.score === "number" && answer.probabilities && typeof answer.confidence === "number") {
    return {
      value: answer.score,
      confidence: answer.confidence,
      probabilities: answer.probabilities,
      reasons: [`Score ${answer.score} (confidence ${Math.round(answer.confidence * 100)}%).`],
    };
  }

  if (answer.type === "noul" && typeof answer.noul === "number") {
    return {
      value: answer.noul,
      confidence: answer.noul,
      probabilities: { "0": 1 - answer.noul, "1": answer.noul },
      reasons: [`Probability ${Math.round(answer.noul * 100)}% that the answer is yes.`],
    };
  }

  throw new Error("TypeSafe response contains an invalid answer");
}

function suggestSplitPlan(scope: string, answer: TypeSafeAnswer | undefined) {
  if (scope !== "needs_split") return {};

  const strategy = answer?.type === "choice" && SPLIT_STRATEGIES.includes(answer.choice as typeof SPLIT_STRATEGIES[number])
    ? answer.choice as typeof SPLIT_STRATEGIES[number]
    : "unknown";
  const steps: Record<typeof SPLIT_STRATEGIES[number], string[]> = {
    contracts_first: [
      "Confirm shared API, schema, or data contracts and acceptance criteria.",
      "Implement the contract and its owning service or data layer.",
      "Update dependent packages and consumers in dependency order.",
      "Run focused tests for each package, then integration tests across the boundary.",
    ],
    subsystem_slices: [
      "List the affected subsystems and their dependencies.",
      "Implement one subsystem at a time, with focused validation after each slice.",
      "Integrate the slices and run cross-subsystem regression tests.",
    ],
    migration_first: [
      "Define migration compatibility, rollout order, and rollback conditions.",
      "Apply the schema or data migration while preserving compatibility.",
      "Update dependent services and clients in dependency order.",
      "Verify data integrity, rollout behavior, and regression tests.",
    ],
    vertical_slices: [
      "Define independently verifiable end-to-end slices and acceptance checks.",
      "Implement the first slice across the layers it touches and validate it.",
      "Repeat for remaining slices, then run integration and regression tests.",
    ],
    unknown: [
      "List the independently verifiable parts and dependencies in the task.",
      "Order prerequisites and shared contracts before dependent implementation.",
      "Validate each part separately, then run integration tests.",
    ],
  };
  return {
    splitStrategy: strategy,
    suggestedSteps: steps[strategy],
    reasons: [`Suggested split strategy: ${strategy}.`],
  };
}

function describeChoice(choice: string, probabilities: Record<string, number>) {
  const chosen = probabilities[choice];
  const runnerUp = Object.entries(probabilities)
    .filter(([name]) => name !== choice)
    .sort((a, b) => b[1] - a[1])[0];
  const percent = (value: number) => `${Math.round(value * 100)}%`;
  if (chosen === undefined || !runnerUp) {
    return { reasons: [`Selected '${choice}'.`] };
  }
  const margin = Math.round((chosen - runnerUp[1]) * 10_000) / 10_000;
  return {
    runnerUp: { value: runnerUp[0], probability: runnerUp[1] },
    margin,
    reasons: [`Selected '${choice}' (${percent(chosen)}); runner-up '${runnerUp[0]}' (${percent(runnerUp[1])}), margin ${percent(margin)}.`],
  };
}

function describeLabels(primary: string, answers: Record<string, TypeSafeAnswer>) {
  const entries = (Object.keys(CHANGE_LABEL_QUESTIONS) as Array<keyof typeof CHANGE_LABEL_QUESTIONS>).flatMap((label) => {
    const answer = answers[`${LABEL_PREFIX}${label}`];
    return answer?.type === "noul" && typeof answer.noul === "number" ? [[label, answer.noul] as const] : [];
  });
  if (entries.length === 0) return {} as { labels?: string[]; labelProbabilities?: Record<string, number>; reasons?: string[] };
  const flagged = entries.filter(([label, probability]) => probability >= LABEL_THRESHOLDS[label]);
  const labels = flagged.map(([label]) => label);
  const extra = flagged.filter(([label]) => label !== primary);
  return {
    labels,
    labelProbabilities: Object.fromEntries(entries),
    reasons: extra.length > 0
      ? [`Also flagged: ${extra.map(([label, probability]) => `${label} (${Math.round(probability * 100)}%)`).join(", ")}.`]
      : [],
  };
}

function describeTestSelection(selected: string[], uncertain: string[], total: number): string[] {
  const reasons = [`Selected ${selected.length} of ${total} test group(s): ${selected.join(", ") || "none"}.`];
  if (uncertain.length > 0) reasons.push(`Borderline groups (30-70%) included conservatively: ${uncertain.join(", ")}.`);
  return reasons;
}

function fieldFor(tool: DecisionTool, value: string): Record<string, unknown> {
  const fields: Record<DecisionTool, string> = {
    classify_change: "changeType",
    route_task: "subsystem",
    review_risk: "riskLevel",
    select_tests: "priority",
    triage_error: "category",
    dependency_action: "action",
    merge_gate: "decision",
    command_safety: "safety",
    check_breaking_change: "compatibility",
    assess_task_scope: "scope",
  };
  return { [fields[tool]]: value };
}

function skippedGroupsConfidence(answers: Array<[string, { noul: number }]>): number {
  const skipped = answers.filter(([, answer]) => answer.noul < SELECT_THRESHOLD);
  if (skipped.length === 0) return 1;
  return Math.round(Math.min(...skipped.map(([, answer]) => 1 - answer.noul)) * 10_000) / 10_000;
}
