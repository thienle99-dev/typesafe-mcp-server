# typesafe-mcp-server

Typed coding-decision MCP server backed by Jev.

## Tools

The server exposes `classify_change`, `route_task`, `review_risk`, `select_tests`, `triage_error`, `dependency_action`, and `merge_gate`.

All tools accept explicit JSON context and return a typed decision with `confidence` and `needsHumanReview`. The server does not read a repository, run commands, or modify files.

## Run

```bash
npm install
cp .env.example .env
npm run build
npm start
```

The HTTP/SSE endpoints are `/sse` and `/messages`; `/health` is available for liveness checks.
