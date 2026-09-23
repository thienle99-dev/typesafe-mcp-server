import type { DecisionEnvelope, DecisionProvider, DecisionTool } from "./types.js";

type Question =
  | { type: "choice"; instructions: string; criteria: Record<string, string> }
  | { type: "score"; instructions: string; criteria: string[] }
  | { type: "noul"; instructions: string };

interface TypeSafeResponse {
  model: string;
  answers: Record<string, TypeSafeAnswer>;
  usage?: { input_tokens?: number; output_tokens?: number };
}

type TypeSafeAnswer =
  | { type: "choice"; choice: string; probabilities: Record<string, number>; confidence: number }
  | { type: "score"; score: number; probabilities: Record<string, number>; confidence: number }
  | { type: "noul"; noul: number };

export interface JevConfig {
  apiUrl: string;
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
    apiUrl: env.TYPESAFE_API_URL ?? env.JEV_API_URL ?? "https://api.typesafe.ai/v1/systemone",
    apiKey,
    model: env.TYPESAFE_MODEL ?? env.JEV_MODEL ?? "jev-latest",
    timeoutMs,
    maxRetries,
  };
}

export class JevHttpProvider implements DecisionProvider {
  public constructor(private readonly config: JevConfig) {}

  public async decide<T extends DecisionEnvelope>(input: {
    tool: DecisionTool;
    payload: unknown;
  }): Promise<T> {
    const response = await this.request(toTypeSafeRequest(input.tool, input.payload, this.config.model));
    return fromTypeSafeResponse(input.tool, response) as T;
  }

  private async request(body: { state: unknown; model: string; questions: Record<string, Question> }) {
    for (let attempt = 0; ; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);

      try {
        const response = await fetch(this.config.apiUrl, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${this.config.apiKey}`,
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });

        if ((response.status === 429 || response.status === 529) && attempt < this.config.maxRetries) {
          await delay(250 * 2 ** attempt);
          continue;
        }

        if (!response.ok) throw new Error(`TypeSafe returned HTTP ${response.status}`);
        const json: unknown = await response.json();
        if (!isTypeSafeResponse(json)) throw new Error("TypeSafe response has an invalid answers shape");
        return json;
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") {
          throw new Error(`TypeSafe request timed out after ${this.config.timeoutMs}ms`);
        }
        throw error;
      } finally {
        clearTimeout(timeout);
      }
    }
  }
}

function toTypeSafeRequest(tool: DecisionTool, payload: unknown, model: string) {
  const state = payload as Record<string, unknown>;
  if (tool === "select_tests") {
    const groups = getTestGroups(state);
    return {
      state,
      model,
      questions: Object.fromEntries(
        groups.map((group) => [group, {
          type: "noul",
          instructions: `Should the ${group} test group run for these changes?`,
        } satisfies Question]),
      ),
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

function choice(instructions: string, criteria: Record<string, string>): Question {
  return { type: "choice", instructions, criteria };
}

function getTestGroups(state: Record<string, unknown>): string[] {
  const available = state.availableTests;
  if (Array.isArray(available) && available.every((item) => typeof item === "string") && available.length > 0) {
    return available as string[];
  }
  return ["unit", "integration", "e2e", "lint", "security"];
}

function fromTypeSafeResponse(tool: DecisionTool, response: TypeSafeResponse): DecisionEnvelope {
  if (tool === "select_tests") {
    const noulAnswers = Object.entries(response.answers)
      .filter((entry): entry is [string, { type: "noul"; noul: number }] => entry[1].type === "noul");
    const selected = noulAnswers
      .filter(([, answer]) => answer.noul >= 0.5)
      .map(([group]) => group);
    const probabilities = Object.fromEntries(
      noulAnswers
        .map(([group, answer]) => [group, answer.noul]),
    );
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

  if (answer.type === "choice") {
    return {
      value: answer.choice,
      confidence: answer.confidence,
      probabilities: answer.probabilities,
      reasons: [`Jev selected '${answer.choice}' from the typed choice rubric.`],
      ...fieldFor(tool, answer.choice),
    };
  }

  if (answer.type === "score") {
    return {
      value: answer.score,
      confidence: answer.confidence,
      probabilities: answer.probabilities,
      reasons: ["Jev returned a probability-weighted score."],
    };
  }

  return {
    value: answer.noul,
    confidence: answer.noul,
    probabilities: { "0": 1 - answer.noul, "1": answer.noul },
    reasons: ["Jev returned a noul probability."],
  };
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
    ? Math.max(answer.noul, 1 - answer.noul)
    : answer.confidence);
  return values.length === 0 ? 0 : Math.min(...values);
}

function isTypeSafeResponse(value: unknown): value is TypeSafeResponse {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { answers?: unknown };
  return typeof candidate.answers === "object" && candidate.answers !== null;
}

function delay(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}
