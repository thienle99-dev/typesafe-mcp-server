import { timingSafeEqual } from "node:crypto";

export interface HttpConfig {
  host: string;
  authToken?: string;
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

export function loadHttpConfig(env: NodeJS.ProcessEnv = process.env): HttpConfig {
  const host = env.HOST ?? "127.0.0.1";
  const authToken = env.MCP_AUTH_TOKEN || undefined;
  if (!LOOPBACK_HOSTS.has(host) && !authToken) {
    throw new Error("MCP_AUTH_TOKEN is required when HOST is not a loopback address");
  }
  return { host, authToken };
}

export function isAuthorized(authorization: string | undefined, token: string | undefined): boolean {
  if (!token) return true;
  const expected = Buffer.from(`Bearer ${token}`);
  const actual = Buffer.from(authorization ?? "");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
