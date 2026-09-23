import { choice, noul, TypeSafeClient } from "@typesafe-ai/sdk";
import type { DecisionEnvelope, DecisionProvider, DecisionTool } from "./types.js";

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
    const response = await this.client.systemOne(request as any) as unknown as {
      answers: Record<string, TypeSafeAnswer>;
    };
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
        groups.map((group) => [group, noul(`Should the ${group} test group run for these changes?`)]),
      ) as Record<string, Question>,
    };
  }

  return { state, model, questions: { decision: questionFor(tool) } };
}

function questionFor(tool: DecisionTool): Question {
  switch (tool) {
    case "classify_change":
      return choice("Classify this code change", {
        safe_refactor: "Behavior-preserving refactor",
        behavior_change: "Changes runtime or product behavior",
        security_sensitive: "Touches authentication, authorization, secrets, or security controls",
        migration: "Changes schema, data, or migration behavior",
        unknown: "Insufficient evidence to classify confidently",
      });
    case "route_task":
      return choice("Which subsystem should own this task?", {
        frontend: "UI, browser, client application, or presentation code",
        backend: "API, service, server-side, or business logic code",
        infra: "Deployment, CI/CD, cloud, networking, or operations code",
        data: "Database, schema, ETL, analytics, or data pipeline code",
        docs: "Documentation or non-executable content",
        unknown: "Insufficient evidence to route confidently",
      });
    case "review_risk":
      return choice("What is the overall risk level of this diff?", {
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
      return choice("What action should be taken for this dependency request?", {
        allow: "Dependency is safe and can be added as requested",
        pin: "Allow only with an exact or constrained version",
        reject: "Do not add the dependency",
        manual_review: "Require human review before changing dependencies",
      });
    case "merge_gate":
      return choice("What should the merge gate decide?", {
        pass: "All available evidence supports safe merge",
        review: "A human should review before merge",
        block: "Merge must be blocked until blockers are resolved",
      });
    case "select_tests":
      return choice("Which test group is the highest priority?", {
        fast: "Fast unit and focused checks",
        normal: "Relevant unit and integration checks",
        full: "Full repository test suite",
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
  if (tool === "select_tests") {
    const noulAnswers = Object.entries(response.answers)
      .filter((entry): entry is [string, TypeSafeAnswer & { type: "noul"; noul: number }] => entry[1].type === "noul" && typeof entry[1].noul === "number");
    const selected = noulAnswers.filter(([, answer]) => answer.noul >= 0.5).map(([group]) => group);
    const probabilities = Object.fromEntries(noulAnswers.map(([group, answer]) => [group, answer.noul]));
    return {
      testGroups: selected,
      testPatterns: selected,
      priority: selected.length > 2 ? "full" : selected.length > 0 ? "normal" : "fast",
      confidence: confidenceFor(response.answers),
      probabilities,
      reasons: [`Selected ${selected.length} test group(s) using Jev noul probabilities.`],
    };
  }

  const answer = response.answers.decision;
  if (!answer) throw new Error("TypeSafe response is missing the decision answer");

  if (answer.type === "choice" && answer.choice && answer.probabilities && typeof answer.confidence === "number") {
    return {
      value: answer.choice,
      confidence: answer.confidence,
      probabilities: answer.probabilities,
      reasons: [`Jev selected '${answer.choice}' from the typed choice rubric.`],
      ...fieldFor(tool, answer.choice),
    };
  }

  if (answer.type === "score" && typeof answer.score === "number" && answer.probabilities && typeof answer.confidence === "number") {
    return {
      value: answer.score,
      confidence: answer.confidence,
      probabilities: answer.probabilities,
      reasons: ["Jev returned a probability-weighted score."],
    };
  }

  if (answer.type === "noul" && typeof answer.noul === "number") {
    return {
      value: answer.noul,
      confidence: answer.noul,
      probabilities: { "0": 1 - answer.noul, "1": answer.noul },
      reasons: ["Jev returned a noul probability."],
    };
  }

  throw new Error("TypeSafe response contains an invalid answer");
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
  };
  return { [fields[tool]]: value };
}

function confidenceFor(answers: Record<string, TypeSafeAnswer>): number {
  const values = Object.values(answers).map((answer) => answer.type === "noul"
    ? Math.max(answer.noul ?? 0, 1 - (answer.noul ?? 0))
    : answer.confidence ?? 0);
  return values.length === 0 ? 0 : Math.min(...values);
}
