const REDACTED = "[REDACTED]";

const SECRET_PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g,
  /\bsk-[A-Za-z0-9_-]{20,}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  /\b(Bearer\s+)[A-Za-z0-9._~+/=-]{16,}/gi,
  /\b[sr]k_(?:live|test)_[A-Za-z0-9]{16,}\b/g,
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
  /\bnpm_[A-Za-z0-9]{36}\b/g,
];

const CREDENTIAL_URL = /(\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:)[^\s/@]+(@)/gi;

const SECRET_NAME = "(?:password|passwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key)";
const QUOTED_SECRET = new RegExp(`\\b(${SECRET_NAME}["']?\\s*[:=]\\s*)(["'])[^"'\\n]+\\2`, "gi");
const ENV_LINE_SECRET = /^([+\-\s]*(?:export\s+)?[A-Z][A-Z0-9_]*(?:PASSWORD|PASSWD|SECRET|TOKEN|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY)[A-Z0-9_]*\s*=\s*)(?!\d+\s*$)(?!\[REDACTED\])\S+/gm;
const LONG_TOKEN = /\b[A-Za-z0-9+/_-]{32,}={0,2}/g;
const ENTROPY_THRESHOLD = 4.2;

const SENSITIVE_PATH = /(^|\/)(\.env(\.(?!example$|sample$|template$)[^/]*)?|[^/]+\.(pem|key|p12|pfx|jks)|id_(rsa|dsa|ecdsa|ed25519)|credentials(\.json)?|\.npmrc|\.netrc)$/i;

const ASSIGNED_SECRET = /\b((?:password|passwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key)["']?\s*[:=]\s*["']?)[^\s"',;]{8,}/gi;

function entropy(value: string): number {
  const counts = new Map<string, number>();
  for (const char of value) counts.set(char, (counts.get(char) ?? 0) + 1);
  let total = 0;
  for (const count of counts.values()) {
    const p = count / value.length;
    total -= p * Math.log2(p);
  }
  return total;
}

function dropSensitiveFileDiffs(text: string): string {
  if (!text.includes("diff --git ")) return text;
  return text.split(/^(?=diff --git )/m).map((section) => {
    const path = /^diff --git a\/(.+?) b\//.exec(section)?.[1];
    if (!path || !SENSITIVE_PATH.test(path)) return section;
    return `${section.split("\n", 1)[0]}\n[REDACTED: content of sensitive file]\n`;
  }).join("");
}

export function redactSecrets(text: string): string {
  let result = dropSensitiveFileDiffs(text);
  for (const pattern of SECRET_PATTERNS) {
    result = result.replace(pattern, (_match, prefix) => (typeof prefix === "string" ? prefix : "") + REDACTED);
  }
  return result
    .replace(CREDENTIAL_URL, `$1${REDACTED}$2`)
    .replace(QUOTED_SECRET, `$1$2${REDACTED}$2`)
    .replace(ASSIGNED_SECRET, `$1${REDACTED}`)
    .replace(ENV_LINE_SECRET, `$1${REDACTED}`)
    .replace(LONG_TOKEN, (token) =>
      /[a-z]/.test(token) && /[A-Z]/.test(token) && /\d/.test(token) && entropy(token) > ENTROPY_THRESHOLD ? REDACTED : token);
}

export function redactPayload<T>(value: T): T {
  if (typeof value === "string") return redactSecrets(value) as T;
  if (Array.isArray(value)) return value.map(redactPayload) as T;
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactPayload(item)])) as T;
  }
  return value;
}
