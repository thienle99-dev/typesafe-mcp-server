import express, { type Express } from "express";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { isAuthorized, type HttpConfig } from "./httpAuth.js";

export function createHttpApp(httpConfig: HttpConfig, createMcpServer: () => McpServer): Express {
  const transports = new Map<string, SSEServerTransport>();
  const app = express();
  app.use(express.json({ limit: "2mb" }));
  app.get("/health", (_req, res) => res.json({ status: "ok", service: "typesafe-mcp-server" }));

  const requireAuth: express.RequestHandler = (req, res, next) => {
    if (isAuthorized(req.headers.authorization, httpConfig.authToken)) {
      next();
      return;
    }
    res.status(401).json({ error: "Unauthorized" });
  };

  app.get("/sse", requireAuth, async (_req, res) => {
    const transport = new SSEServerTransport("/messages", res);
    transports.set(transport.sessionId, transport);
    res.on("close", () => transports.delete(transport.sessionId));
    await createMcpServer().connect(transport);
  });

  app.post("/messages", requireAuth, async (req, res) => {
    const sessionId = typeof req.query.sessionId === "string" ? req.query.sessionId : undefined;
    const transport = sessionId ? transports.get(sessionId) : undefined;
    if (!transport) {
      res.status(400).json({ error: "Unknown or missing sessionId" });
      return;
    }
    await transport.handlePostMessage(req, res, req.body);
  });

  return app;
}
