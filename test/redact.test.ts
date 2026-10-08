import { describe, expect, it, vi } from "vitest";
import { createDecisionHandlers } from "../src/decisions.js";
import { redactPayload, redactSecrets } from "../src/redact.js";
import { classifyChangeInput, mergeGateInput } from "../src/schemas.js";
import type { DecisionProvider } from "../src/types.js";

describe("redactSecrets", () => {
  it.each([
    ["AWS key", "key AKIAIOSFODNN7EXAMPLE end"],
    ["GitHub token", `x ghp_${"a".repeat(36)} y`],
    ["Bearer token", "Authorization: Bearer abcdefghijklmnop1234"],
    ["assigned secret", '+API_KEY="s3cr3t-value-123"'],
    ["short quoted secret", 'password: "abc1"'],
    ["env line", "+DB_PASSWORD=abc1"],
    ["credential URL", "DATABASE=postgres://admin:hunter22@db.local:5432/app"],
    ["Stripe key", "k = sk_live_abcdefghijklmnop1234"],
    ["high-entropy token", "id = aB3dE5gH7jK9mN1pQ3sT5vW7yZ9bC1dE3fG"],
    ["private key", "-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----"],
  ])("redacts %s", (_name, input) => {
    expect(redactSecrets(input)).toContain("[REDACTED]");
    expect(redactSecrets(input)).not.toMatch(/AKIAIOSFODNN7EXAMPLE|ghp_a{36}|abcdefghijklmnop1234|s3cr3t-value-123|abc\n|abc1|hunter22|aB3dE5gH7jK9mN1pQ3sT5vW7yZ9bC1dE3fG/);
  });

  it("keeps ordinary code unchanged", () => {
    const code = "const token: string = getToken();\nfunction add(a: number) { return a + 1; }";
    expect(redactSecrets(code)).toBe(code);
  });

  it("keeps ordinary code unchanged with numeric and type-only values", () => {
    const code = "MAX_TOKENS=100\nconst commit = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';";
    expect(redactSecrets(code)).toBe(code);
  });

  it("keeps long import paths, identifiers and lock URLs", () => {
    const code = [
      "import { UserProfileAvatar2 } from '../../components/UserProfile2/Avatar-Image-Large/index';",
      "const veryLongFunctionNameForCalculatingTotalPrice2024 = 1;",
      '"resolved": "https://registry.npmjs.org/@types/node/-/node-22.15.0.tgz",',
    ].join("\n");
    expect(redactSecrets(code)).toBe(code);
  });

  it("drops diffs of sensitive files but keeps others and .env.example", () => {
    const diff = [
      "diff --git a/.env b/.env", "+FOO=bar",
      "diff --git a/src/a.ts b/src/a.ts", "+const a = 1;",
      "diff --git a/.env.example b/.env.example", "+FOO=",
      "",
    ].join("\n");
    const result = redactSecrets(diff);
    expect(result).not.toContain("+FOO=bar");
    expect(result).toContain("[REDACTED: content of sensitive file]");
    expect(result).toContain("+const a = 1;");
    expect(result).toContain("+FOO=");
  });

  it("redacts nested payload strings and leaves other values", () => {
    expect(redactPayload({ a: ["Bearer abcdefghijklmnop1234"], n: 3, ok: true })).toEqual({
      a: ["Bearer [REDACTED]"],
      n: 3,
      ok: true,
    });
  });
});

describe("handlers", () => {
  it("sends redacted payload to the provider", async () => {
    const decide = vi.fn().mockResolvedValue({ confidence: 1 });
    const handlers = createDecisionHandlers({ decide } as unknown as DecisionProvider, { confidenceThreshold: 0.97 });
    await handlers.classify_change({ diff: "+password = hunter2hunter2", changedFiles: ["a.ts"] });
    expect(decide.mock.calls[0][0].payload.diff).toBe("+password = [REDACTED]");
  });
});

describe("input limits", () => {
  it("rejects an oversized diff", () => {
    expect(classifyChangeInput.safeParse({ diff: "x".repeat(200_001), changedFiles: ["a.ts"] }).success).toBe(false);
  });

  it("rejects an oversized merge_gate record but accepts a small one", () => {
    expect(mergeGateInput.safeParse({ riskReview: { riskLevel: "low" } }).success).toBe(true);
    expect(mergeGateInput.safeParse({ riskReview: { note: "x".repeat(50_001) } }).success).toBe(false);
  });
});
