import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { createDecisionHandlers } from "./decisions.js";
import { loadJevConfig, JevHttpProvider } from "./jev.js";
import { isAuthorized, loadHttpConfig } from "./httpAuth.js";
import { loadPolicy } from "./policy.js";
import {
  assessTaskScopeInput,
  checkBreakingChangeInput,
  classifyChangeInput,
  commandSafetyInput,
  decisionOutput,
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

  register(server, "classify_change", "Classify a code diff as safe_refactor, behavior_change, security_sensitive, migration or unknown. Call before review or merge. Result is in `changeType`.", classifyChangeInput, handlers.classify_change);
  register(server, "route_task", "Route a coding task or issue to the owning subsystem (frontend, backend, infra, data, docs, unknown). Call before starting work. Result is in `subsystem`.", routeTaskInput, handlers.route_task);
  register(server, "review_risk", "Rate the risk of a diff as low, medium, high or critical using changed files and existing test/security results. Result is in `riskLevel`.", reviewRiskInput, handlers.review_risk);
  register(server, "select_tests", "Select which test groups to run for changed files. Result is `testGroups` plus per-group `probabilities` and a `priority` of fast, normal or full.", selectTestsInput, handlers.select_tests);
  register(server, "triage_error", "Classify the likely root-cause category of a compiler, test or runtime error (type_error, dependency, flaky_test, config, logic_bug, environment, unknown). Result is in `category`; the agent still investigates and fixes.", triageErrorInput, handlers.triage_error);
  register(server, "dependency_action", "Decide whether a dependency request should be allowed, pinned, rejected or sent to manual review. Call before running a package manager. Result is in `action`; nothing is installed.", dependencyActionInput, handlers.dependency_action);
  register(server, "merge_gate", "Aggregate prior decisions and check results into pass, review or block. Result is in `decision`; it does not merge or override branch protection.", mergeGateInput, handlers.merge_gate);
  register(server, "command_safety", "Rate a shell command as safe, confirm or deny before the agent runs it. Result is in `safety`; `confirm` and `deny` mean the agent should stop and ask the user. The command is not executed.", commandSafetyInput, handlers.command_safety);
  register(server, "check_breaking_change", "Decide whether a diff breaks backward compatibility for consumers of a public API, schema, CLI or exported types (none, compatible, breaking, unknown). Result is in `compatibility`.", checkBreakingChangeInput, handlers.check_breaking_change);
  register(server, "assess_task_scope", "Decide before coding whether a task is small, needs_split into steps, or needs_clarification from the user. Result is in `scope`.", assessTaskScopeInput, handlers.assess_task_scope);

  return server;
}

function register(
  server: McpServer,
  name: string,
  description: string,
  schema: z.AnyZodObject,
  handler: (input: unknown) => Promise<unknown>,
) {
  server.registerTool(
    name,
    {
      description,
      inputSchema: schema.shape,
      outputSchema: decisionOutput,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (input: Record<string, unknown>): Promise<CallToolResult> => {
      try {
        const result = (await handler(input)) as z.infer<typeof decisionOutput>;
        return { content: [{ type: "text" as const, text: JSON.stringify(result) }], structuredContent: result };
      } catch (error) {
        return { isError: true, content: [{ type: "text" as const, text: `${name} failed: ${errorMessage(error)}` }] };
      }
    },
  );
}

function errorMessage(error: unknown): string {
  if (error instanceof z.ZodError) {
    return error.issues.map((issue) => `${issue.path.join(".") || "input"}: ${issue.message}`).join("; ");
  }
  return error instanceof Error ? error.message : String(error);
}

const httpConfig = process.env.MCP_TRANSPORT === "stdio" ? { host: "127.0.0.1" } : loadHttpConfig();

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

const port = Number(process.env.PORT ?? "3000");

if (process.env.MCP_TRANSPORT === "stdio") {
  const transport = new StdioServerTransport();
  await createMcpServer().connect(transport);
} else {
  app.listen(port, httpConfig.host, () => console.log(`typesafe-mcp-server listening on ${httpConfig.host}:${port}`));
}
