# typesafe-mcp-server

MCP server cho coding agent, dùng TypeSafe System One/Jev để đưa ra các quyết định có schema rõ ràng trong quy trình phát triển phần mềm.

Server này không thay thế Claude Code, Cursor hay Codex trong việc đọc repo, viết code hoặc giải thích thay đổi. Coding agent vẫn thực hiện các tác vụ đó; MCP server chỉ phụ trách các quyết định lặp lại như phân loại change, đánh giá risk, chọn test và merge gate.

## Kiến trúc

```text
Coding agent
    │
    │ MCP over HTTP/SSE
    ▼
typesafe-mcp-server
    │
    │ TypeSafeClient.systemOne()
    ▼
TypeSafe API / Jev
```

Server nhận context explicit từ client. Server không tự đọc filesystem, không chạy git/test/lint/security command và không sửa file.

## Decision output chung

Các tool trả về một decision đã được normalize từ TypeSafe:

```json
{
  "confidence": 0.98,
  "probabilities": {
    "low": 0.98,
    "medium": 0.02,
    "high": 0,
    "critical": 0
  },
  "reasons": [
    "Jev selected 'low' from the typed choice rubric."
  ],
  "needsHumanReview": false
}
```

- `confidence`: mức tin cậy từ `0` đến `1`.
- `probabilities`: phân phối xác suất do TypeSafe trả về nếu answer hỗ trợ field này.
- `reasons`: rationale ngắn do adapter tạo từ kết quả typed; đây không phải free-form explanation từ Jev.
- `needsHumanReview`: `true` nếu confidence thấp hơn `DECISION_CONFIDENCE_THRESHOLD` hoặc decision đã đánh dấu cần review.

Ngưỡng mặc định là `0.97` và có thể cấu hình bằng `DECISION_CONFIDENCE_THRESHOLD`.

Khi input không hợp lệ hoặc TypeSafe lỗi (timeout, 5xx, mất kết nối), tool không trả decision mà trả lỗi có cấu trúc:

```json
{
  "isError": true,
  "content": [
    { "type": "text", "text": "merge_gate failed: Connection error: fetch failed" }
  ]
}
```

Agent nên coi đây là "không có decision", không phải `pass`.

## MCP tools

### 1. `classify_change`

Phân loại một diff để agent biết thay đổi có phải refactor an toàn, behavior change hay cần review đặc biệt.

Input:

```json
{
  "diff": "diff --git a/src/auth.ts b/src/auth.ts ...",
  "changedFiles": ["src/auth.ts", "test/auth.test.ts"],
  "commitMessage": "Refactor token validation"
}
```

Fields:

- `diff` bắt buộc, nội dung unified diff.
- `changedFiles` bắt buộc, danh sách file bị thay đổi.
- `commitMessage` tùy chọn.

Decision chính nằm ở `changeType`:

- `safe_refactor`: thay đổi được đánh giá là không đổi behavior.
- `behavior_change`: thay đổi runtime/product behavior.
- `security_sensitive`: liên quan auth, permission, secret hoặc security control.
- `migration`: thay đổi schema, data hoặc migration.
- `unknown`: không đủ evidence.

### 2. `route_task`

Xác định subsystem phù hợp để xử lý issue hoặc coding task.

Input:

```json
{
  "issue": "Add retry handling to the payment webhook endpoint",
  "repoContext": "Monorepo with React frontend and Go API services",
  "changedFiles": ["services/payment/webhook.go"]
}
```

Decision chính nằm ở `subsystem`:

- `frontend`
- `backend`
- `infra`
- `data`
- `docs`
- `unknown`

`repoContext` và `changedFiles` giúp Jev định tuyến chính xác hơn nhưng không bắt buộc.

### 3. `review_risk`

Đánh giá risk của diff dựa trên thay đổi, file bị ảnh hưởng và kết quả kiểm tra đã có.

Input:

```json
{
  "diff": "diff --git a/migrations/001.sql b/migrations/001.sql ...",
  "changedFiles": ["migrations/001.sql", "src/repository/user.ts"],
  "testResults": "unit tests passed; migration tests not run",
  "securityResults": "no automated security scan available"
}
```

Decision chính nằm ở `riskLevel`:

- `low`: thay đổi nhỏ, cô lập, blast radius thấp.
- `medium`: có risk behavior hoặc integration ở mức vừa.
- `high`: blast radius lớn, behavior nhạy cảm hoặc thiếu test evidence.
- `critical`: có khả năng gây security issue, data loss, production incident hoặc thay đổi khó đảo ngược.

### 4. `select_tests`

Chọn nhóm test nên chạy dựa trên changed files, symbols và repo context.

Input:

```json
{
  "changedFiles": ["src/auth/token.ts", "src/auth/token.test.ts"],
  "changedSymbols": ["verifyToken", "refreshToken"],
  "repoContext": "Node.js service with unit, integration and e2e suites",
  "availableTests": ["unit-auth", "integration-api", "e2e-login", "security-scan"]
}
```

Fields:

- `changedFiles` bắt buộc.
- `changedSymbols`, `repoContext`, `availableTests` tùy chọn.
- Nếu không truyền `availableTests`, server dùng các nhóm mặc định: `unit`, `integration`, `e2e`, `lint`, `security`.

Output đặc thù:

```json
{
  "testGroups": ["unit-auth", "integration-api"],
  "testPatterns": ["unit-auth", "integration-api"],
  "priority": "normal",
  "confidence": 0.93,
  "probabilities": {
    "unit-auth": 0.99,
    "integration-api": 0.88,
    "e2e-login": 0.21,
    "security-scan": 0.35
  },
  "uncertainGroups": ["security-scan"],
  "needsHumanReview": true
}
```

Mỗi test group được hỏi bằng một TypeSafe `noul`. Group được chọn khi xác suất `noul >= 0.5`. `priority` là `fast`, `normal` hoặc `full` dựa trên số nhóm được chọn. `uncertainGroups` liệt kê các group có `noul` trong khoảng 0.3–0.7. `confidence` là giá trị thấp nhất trên mọi group, nên nhiều group dễ kéo confidence xuống dưới threshold.

### 5. `triage_error`

Phân loại lỗi compiler, test hoặc runtime để agent chọn hướng điều tra tiếp theo.

Input:

```json
{
  "error": "Type 'string | undefined' is not assignable to type 'string'",
  "command": "npm run build",
  "changedFiles": ["src/config.ts"],
  "recentChanges": "Made API_KEY optional in the environment schema"
}
```

Decision chính nằm ở `category`:

- `type_error`
- `dependency`
- `flaky_test`
- `config`
- `logic_bug`
- `environment`
- `unknown`

Tool chỉ phân loại nguyên nhân; agent vẫn chịu trách nhiệm đọc stack trace và thực hiện bước sửa lỗi.

### 6. `dependency_action`

Đánh giá request thêm hoặc nâng version dependency trước khi agent chạy package manager.

Input:

```json
{
  "dependency": "zod",
  "requestedVersion": "^3.25.0",
  "packageManager": "npm",
  "reason": "Validate MCP tool input schemas",
  "existingPolicy": "Production dependencies require pinned major versions",
  "changedFiles": ["package.json", "src/schemas.ts"]
}
```

Decision chính nằm ở `action`:

- `allow`: có thể thêm dependency như request.
- `pin`: chỉ cho phép với version cố định hoặc constraint chặt.
- `reject`: không nên thêm dependency.
- `manual_review`: phải có human review trước khi thay đổi.

Tool không tự cài package và không chỉnh `package.json`.

### 7. `merge_gate`

Tổng hợp các decision và kết quả kiểm tra để xác định merge có thể tiếp tục hay không.

Input:

```json
{
  "checks": {
    "tests": "pass",
    "lint": "pass",
    "security": "not_run"
  },
  "changeClassification": {
    "changeType": "behavior_change",
    "confidence": 0.98
  },
  "riskReview": {
    "riskLevel": "medium",
    "confidence": 0.94
  },
  "routeDecision": {
    "subsystem": "backend",
    "confidence": 0.99
  },
  "testResults": "unit passed; integration passed",
  "lintResults": "passed",
  "securityResults": "no findings",
  "changeScope": "3 files, 85 lines changed"
}
```

`checks` là tùy chọn, mỗi giá trị là `pass`, `fail` hoặc `not_run`. Nếu bất kỳ check nào là `fail`, server trả `block` ngay (`confidence: 1`) mà không gọi TypeSafe. Các field dạng text (`testResults`, `lintResults`, `securityResults`) chỉ là context cho Jev, không được server phân tích để suy ra pass/fail.

Decision chính nằm ở `decision`:

- `pass`: evidence hiện có ủng hộ merge.
- `review`: cần human review trước merge.
- `block`: phải xử lý blocker trước khi merge.

`merge_gate` không merge PR, không gọi Git provider và không override branch protection. Nó chỉ trả decision để coding agent hoặc CI pipeline áp dụng policy riêng.

## TypeSafe mapping

MCP adapter sử dụng TypeSafe JavaScript SDK:

- `classify_change`, `route_task`, `review_risk`, `triage_error`, `dependency_action`, `merge_gate`: một câu hỏi `choice`.
- `select_tests`: một `noul` cho mỗi test group.
- SDK chịu trách nhiệm authentication, request tới `/v1/systemone`, timeout và retry.

## Cài đặt và chạy

Requires Node.js 20 or newer.

```bash
npm install
cp .env.example .env
npm run build
npm start
```

Các biến môi trường chính:

```env
TYPESAFE_API_URL=https://api.typesafe.ai
TYPESAFE_API_KEY=your_api_key
TYPESAFE_MODEL=jev-latest
TYPESAFE_TIMEOUT_MS=10000
TYPESAFE_MAX_RETRIES=3
DECISION_CONFIDENCE_THRESHOLD=0.97
PORT=3000
```

HTTP/SSE endpoints:

- `GET /health`: liveness check.
- `GET /sse`: mở MCP SSE session.
- `POST /messages?sessionId=...`: gửi MCP messages cho session.

Codex, Cursor và Claude Code đều dùng stdio. Chạy các lệnh dưới đây từ thư mục repo sau `npm run build`. `SERVER` là đường dẫn checkout; client không expand biến này trong file JSON, nên Cursor cần đường dẫn tuyệt đối.

```bash
SERVER="$(pwd)"
```

API key đọc từ `.env` qua `--env-file`. Không ghi key vào `config.toml`, `mcp.json`, hoặc command line.

### Codex

`codex mcp add` ghi vào `~/.codex/config.toml` và áp dụng cho mọi project:

```bash
codex mcp add typesafe-code \
  --env MCP_TRANSPORT=stdio \
  -- node --env-file="$SERVER/.env" "$SERVER/dist/src/server.js"
```

### Cursor

Thêm server vào `~/.cursor/mcp.json` để dùng ở mọi workspace. Thay `/path/to/typesafe-mcp-server` bằng giá trị của `$SERVER`:

```json
{
  "mcpServers": {
    "typesafe-code": {
      "command": "node",
      "args": [
        "--env-file=/path/to/typesafe-mcp-server/.env",
        "/path/to/typesafe-mcp-server/dist/src/server.js"
      ],
      "env": {
        "MCP_TRANSPORT": "stdio"
      }
    }
  }
}
```

Sau khi sửa file, bật lại `typesafe-code` trong Cursor Settings → MCP.

### Claude Code

`--scope user` ghi vào cấu hình user và áp dụng cho mọi project:

```bash
claude mcp add --scope user \
  -e MCP_TRANSPORT=stdio \
  typesafe-code -- \
  node --env-file="$SERVER/.env" "$SERVER/dist/src/server.js"
```

### Quy tắc agent

Thêm cùng một rule vào file instruction global của client: `~/.codex/AGENTS.md`, Cursor User Rules, hoặc `~/.claude/CLAUDE.md`.

Agent gọi `typesafe-code` cho decision lặp lại (`classify_change`, `route_task`, `review_risk`, `select_tests`, `triage_error`, `dependency_action`, `merge_gate`) và tự làm theo kết quả khi `confidence >= 0.70`:

- Từ `0.70`: tiếp tục với `pass` hoặc `allow`; `pin` chỉ khi version được siết chặt; dừng nếu decision là `block`, `reject`, hoặc `manual_review`.
- Dưới `0.70`: dừng và hỏi người dùng.
- Không dùng cờ `needsHumanReview` cho ngưỡng này. Cờ đó vẫn theo `DECISION_CONFIDENCE_THRESHOLD` (mặc định `0.97`).

## Development

```bash
npm run dev
npm run build
npm test
```

Test mặc định mock TypeSafe response, không cần API key production. Server thật yêu cầu `TYPESAFE_API_KEY`.

## Giới hạn và safety

- Input phải do client cung cấp; server không tự suy luận changed files từ git.
- Confidence thấp hơn threshold luôn đặt `needsHumanReview=true`.
- Decision không phải authorization cuối cùng cho merge, dependency install hoặc production deploy.
- Không gửi API key trong MCP payload; cấu hình key bằng environment variable.
- Trước khi gửi sang TypeSafe, server che secret trong mọi string của payload bằng `[REDACTED]`: private key, AWS/GitHub/Slack/Stripe/Google/npm token, key `sk-`, JWT, `Bearer ...`, URL kèm `user:password@`, giá trị trong dấu nháy gán cho `password`/`secret`/`token`/`api_key` (mọi độ dài), dòng kiểu `.env` (`DB_PASSWORD=...`) và chuỗi base64 dài có entropy cao. Diff của file nhạy cảm (`.env`, `*.pem`, `*.key`, `id_rsa`, `credentials`, `.npmrc`; trừ `.env.example`) bị bỏ toàn bộ nội dung. Đây là lớp giảm thiểu theo pattern, không đảm bảo bắt hết: secret ngắn không dấu nháy, không đặt tên rõ (ví dụ `x = abc123`) hoặc ở định dạng lạ vẫn có thể lọt. Đừng đưa secret vào diff hay log gửi cho tool.
- Giới hạn input: `diff` tối đa 200.000 ký tự, các string khác tối đa 50.000 ký tự, mỗi danh sách tối đa 500 phần tử. Input vượt giới hạn bị từ chối, không bị cắt.
- Lỗi từ tool (input sai, TypeSafe timeout hoặc 5xx) trả về `isError: true` kèm message ngắn.
