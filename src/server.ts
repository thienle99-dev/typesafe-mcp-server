import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { createDecisionHandlers } from "./decisions.js";
import { loadJevConfig, JevHttpProvider } from "./jev.js";
import { createHttpApp } from "./httpApp.js";
import { loadHttpConfig } from "./httpAuth.js";
import { loadPolicy } from "./policy.js";
import {
  assessTaskScopeInput,
  checkBreakingChangeInput,
  classifyChangeInput,
  commandSafetyInput,
  dependencyActionInput,
  mergeGateInput,
  reviewRiskInput,
  routeTaskInput,
  selectTestsInput,
  toolOutputs,
  triageErrorInput,
} from "./schemas.js";

const policy = loadPolicy();
const provider = new JevHttpProvider(loadJevConfig());
const handlers = createDecisionHandlers(provider, policy);

function createMcpServer() {
  const server = new McpServer({ name: "typesafe-mcp-server", version: "0.1.0" });

  register(server, "classify_change", "Identify what kind of change the diff makes: behavior change, security-sensitive change, migration, safe refactor or unknown. Use this to label the change itself; `value` and `changeType` carry the same enum result, with additional applicable labels in `labels`.", classifyChangeInput, toolOutputs.classify_change, handlers.classify_change);
  register(server, "route_task", "Route a coding task to every materially involved subsystem (frontend, backend, infra, data, docs). `value` and `subsystem` are the highest-scoring match for compatibility; `subsystems` lists all matches. They may be `unknown` when none has sufficient support.", routeTaskInput, toolOutputs.route_task, handlers.route_task);
  register(server, "review_risk", "Estimate the overall severity and blast radius of a code change (low, medium, high or critical), using the diff and typed `checks` statuses for tests, lint and security. Use this for likelihood and impact of harm; `value` and `riskLevel` carry the same enum result.", reviewRiskInput, toolOutputs.review_risk, handlers.review_risk);
  register(server, "select_tests", "Select test groups based on code changes. A non-empty `diff` is required; changed file names and symbols alone are insufficient evidence. `value` is the selected group array and mirrors `testGroups`; the output also includes per-group `probabilities` and `priority` (fast, normal or full).", selectTestsInput, toolOutputs.select_tests, handlers.select_tests);
  register(server, "triage_error", "Classify the likely root-cause category of a compiler, test or runtime error (type_error, dependency, flaky_test, config, logic_bug, environment, unknown). `value` and `category` carry the same enum result; the agent still investigates and fixes.", triageErrorInput, toolOutputs.triage_error, handlers.triage_error);
  register(server, "dependency_action", "Evaluate a dependency request using repository equivalents, license, security audit and maintenance evidence. Pass these fields when available; missing or inconclusive material evidence should lead to `manual_review`. Call before running a package manager. `value` and `action` carry the same enum result; nothing is installed.", dependencyActionInput, toolOutputs.dependency_action, handlers.dependency_action);
  register(server, "merge_gate", "Aggregate prior decisions and check results into pass, review or block. `value` and `decision` carry the same enum result; this tool does not merge or override branch protection.", mergeGateInput, toolOutputs.merge_gate, handlers.merge_gate);
  register(server, "command_safety", "Check a shell command before execution. Deterministic rules return `confirm` or `deny` without model discretion for covered commands; other commands are assessed by Jev. `value` and `safety` carry the same enum result. The tool does not execute or block commands in the caller's shell, so clients must enforce its result.", commandSafetyInput, toolOutputs.command_safety, handlers.command_safety);
  register(server, "check_breaking_change", "Check only consumer-facing backward compatibility for public APIs, schemas, CLIs and exported types (none, compatible, breaking or unknown). Pass `publicApiContext` to identify public symbols and files. Use this when the question is whether existing consumers still work; `value` and `compatibility` carry the same enum result.", checkBreakingChangeInput, toolOutputs.check_breaking_change, handlers.check_breaking_change);
  register(server, "assess_task_scope", "Assess task scope using task details, changed files, repo context and optional repoStats (sourceFiles, packages, modules). `value` and `scope` carry the same enum result; for `needs_split`, output also includes `splitStrategy` and ordered `suggestedSteps`.", assessTaskScopeInput, toolOutputs.assess_task_scope, handlers.assess_task_scope);

  return server;
}

function register(
  server: McpServer,
  name: string,
  description: string,
  schema: z.AnyZodObject,
  outputSchema: z.AnyZodObject,
  handler: (input: unknown) => Promise<unknown>,
) {
  server.registerTool(
    name,
    {
      description,
      inputSchema: schema.shape,
      outputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (input: Record<string, unknown>): Promise<CallToolResult> => {
      try {
        const result = (await handler(input)) as Record<string, unknown>;
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
const app = createHttpApp(httpConfig, createMcpServer);
const port = Number(process.env.PORT ?? "3000");

if (process.env.MCP_TRANSPORT === "stdio") {
  const transport = new StdioServerTransport();
  await createMcpServer().connect(transport);
} else {
  app.listen(port, httpConfig.host, () => console.log(`typesafe-mcp-server listening on ${httpConfig.host}:${port}`));
}
