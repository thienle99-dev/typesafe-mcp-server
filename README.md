# typesafe-mcp-server

Typed coding-decision MCP server backed by TypeSafe's System One API and Jev.

## Tools

The server exposes `classify_change`, `route_task`, `review_risk`, `select_tests`, `triage_error`, `dependency_action`, and `merge_gate`.

All tools accept explicit JSON context and return a normalized typed decision with `confidence`, probability data, and `needsHumanReview`. Internally, the adapter sends TypeSafe `state` plus typed `choice`, `score`, and `noul` questions to the System One endpoint. The server does not read a repository, run commands, or modify files.

## Run

```bash
npm install
cp .env.example .env
npm run build
npm start
```

Set `TYPESAFE_API_KEY` before starting the server. The default endpoint is `https://api.typesafe.ai/v1/systemone` and the default model is `jev-latest`.

The HTTP/SSE endpoints are `/sse` and `/messages`; `/health` is available for liveness checks.
