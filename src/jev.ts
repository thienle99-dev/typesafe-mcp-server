import type { DecisionEnvelope, DecisionProvider, DecisionTool } from "./types.js";

export interface JevConfig {
  apiUrl: string;
  apiKey?: string;
  model: string;
  timeoutMs: number;
}

export function loadJevConfig(env: NodeJS.ProcessEnv = process.env): JevConfig {
  const apiUrl = env.JEV_API_URL;
  if (!apiUrl) throw new Error("JEV_API_URL is required");

  const timeoutMs = Number(env.JEV_TIMEOUT_MS ?? "10000");
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("JEV_TIMEOUT_MS must be a positive number");
  }

  return {
    apiUrl,
    apiKey: env.JEV_API_KEY,
    model: env.JEV_MODEL ?? "jev",
    timeoutMs,
  };
}

export class JevHttpProvider implements DecisionProvider {
  public constructor(private readonly config: JevConfig) {}

  public async decide<T extends DecisionEnvelope>(input: {
    tool: DecisionTool;
    payload: unknown;
  }): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);

    try {
      const response = await fetch(this.config.apiUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(this.config.apiKey ? { authorization: `Bearer ${this.config.apiKey}` } : {}),
        },
        body: JSON.stringify({ model: this.config.model, tool: input.tool, input: input.payload }),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`Jev returned HTTP ${response.status}`);
      }

      const body: unknown = await response.json();
      if (!isDecisionEnvelope(body)) {
        throw new Error("Jev response must contain confidence between 0 and 1");
      }
      return body as T;
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error(`Jev request timed out after ${this.config.timeoutMs}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
}

function isDecisionEnvelope(value: unknown): value is DecisionEnvelope {
  if (typeof value !== "object" || value === null) return false;
  const confidence = (value as { confidence?: unknown }).confidence;
  return typeof confidence === "number" && confidence >= 0 && confidence <= 1;
}
