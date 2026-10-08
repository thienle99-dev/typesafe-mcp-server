import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { createHttpApp } from "../src/httpApp.js";

async function withServer(run: (baseUrl: string) => Promise<void>) {
  const app = createHttpApp({ host: "127.0.0.1", authToken: "secret" }, () => {
    throw new Error("MCP server should not start for these auth checks");
  });
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const { port } = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

describe("HTTP routes", () => {
  it("leaves /health open and rejects /sse without a valid bearer token", async () => {
    await withServer(async (baseUrl) => {
      const health = await fetch(`${baseUrl}/health`);
      expect(health.status).toBe(200);
      expect(await health.json()).toEqual({ status: "ok", service: "typesafe-mcp-server" });

      const missing = await fetch(`${baseUrl}/sse`);
      expect(missing.status).toBe(401);
      expect(await missing.json()).toEqual({ error: "Unauthorized" });

      const wrong = await fetch(`${baseUrl}/sse`, { headers: { Authorization: "Bearer wrong" } });
      expect(wrong.status).toBe(401);
    });
  });

  it("rejects /messages before session lookup, then returns 400 after auth", async () => {
    await withServer(async (baseUrl) => {
      const missing = await fetch(`${baseUrl}/messages`, { method: "POST" });
      expect(missing.status).toBe(401);

      const authed = await fetch(`${baseUrl}/messages`, {
        method: "POST",
        headers: { Authorization: "Bearer secret" },
      });
      expect(authed.status).toBe(400);
      expect(await authed.json()).toEqual({ error: "Unknown or missing sessionId" });
    });
  });
});
