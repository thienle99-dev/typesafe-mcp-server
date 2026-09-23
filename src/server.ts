import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createDecisionHandlers } from "./decisions.js";
import { loadJevConfig, JevHttpProvider } from "./jev.js";
import { loadPolicy } from "./policy.js";
import {
  classifyChangeInput,
  dependencyActionInput,
  mergeGateInput,
  reviewRiskInput,
  routeTaskInput,
  selectTestsInput,
  triageErrorInput,
} from "./schemas.js";

const policy = loadPolicy();
const provider = new JevHttpProvider(loadJevConfig());
const handlers = createDecisionHandlers(provider, policy);
const transports = new Map<string, SSEServerTransport>();

function createMcpServer() {
  const server = new McpServer({ name: "typesafe-mcp-server", version: "0.1.0" });

  register(server, "classify_change", "Classify a code change", classifyChangeInput, handlers.classify_change);
  register(server, "route_task", "Route a coding task to a subsystem", routeTaskInput, handlers.route_task);
  register(server, "review_risk", "Review diff risk", reviewRiskInput, handlers.review_risk);
  register(server, "select_tests", "Select tests for changed code", selectTestsInput, handlers.select_tests);
  register(server, "triage_error", "Triage a compiler or test error", triageErrorInput, handlers.triage_error);
  register(server, "dependency_action", "Decide how to handle a dependency request", dependencyActionInput, handlers.dependency_action);
  register(server, "merge_gate", "Evaluate a merge gate", mergeGateInput, handlers.merge_gate);

  return server;
}

function register<T extends z.ZodRawShape>(
  server: McpServer,
  name: string,
  description: string,
  schema: z.ZodObject<T>,
  handler: (input: z.infer<z.ZodObject<T>>) => Promise<unknown>,
) {
  server.tool(name, description, schema.shape as any, async (input: any) => ({
    content: [{ type: "text" as const, text: JSON.stringify(await handler(input)) }],
  }));
}

const app = express();
app.use(express.json({ limit: "2mb" }));
app.get("/health", (_req, res) => res.json({ status: "ok", service: "typesafe-mcp-server" }));

app.get("/sse", async (_req, res) => {
  const transport = new SSEServerTransport("/messages", res);
  transports.set(transport.sessionId, transport);
  res.on("close", () => transports.delete(transport.sessionId));
  await createMcpServer().connect(transport);
});

app.post("/messages", async (req, res) => {
  const sessionId = typeof req.query.sessionId === "string" ? req.query.sessionId : undefined;
  const transport = sessionId ? transports.get(sessionId) : undefined;
  if (!transport) {
    res.status(400).json({ error: "Unknown or missing sessionId" });
    return;
  }
  await transport.handlePostMessage(req, res, req.body);
});

const port = Number(process.env.PORT ?? "3000");

if (process.env.MCP_TRANSPORT === "stdio") {
  const transport = new StdioServerTransport();
  await createMcpServer().connect(transport);
} else {
  app.listen(port, () => console.log(`typesafe-mcp-server listening on port ${port}`));
}
