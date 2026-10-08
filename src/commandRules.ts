const PROTECTED_TARGETS = new Set([
  "/", "~", "$HOME", "${HOME}",
  "/bin", "/boot", "/etc", "/home", "/lib", "/opt", "/root", "/sbin", "/srv", "/usr", "/usr/local", "/var",
  "/Users", "/System", "/Library", "/Applications",
]);

const PATTERN_RULES: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\bgit\s+push\b[^;&|\n]*\s(?:-[a-zA-Z]*f[a-zA-Z]*|--force(?:-with-lease|-if-includes)?)(?:[\s=]|$)/, reason: "git force push" },
  { pattern: /\b(?:curl|wget)\b[^|\n]*\|\s*(?:sudo\s+)?(?:ba|z|da|k)?sh\b/, reason: "piping a remote script into a shell" },
  { pattern: /(?:\b(?:ba|z|da|k)?sh|\bsource|\.)\s+<\(\s*(?:curl|wget)\b/, reason: "executing a remote script via process substitution" },
  { pattern: /\b(?:(?:ba|z|da|k)?sh\s+-c|eval)\b[^;&|\n]*\$\(\s*(?:curl|wget)\b/, reason: "executing a remote script via command substitution" },
  { pattern: /\bgit\s+push\b[^;&|\n]*\s(?:\+\S|:[^\s:]\S*|--delete\b|--mirror\b)/, reason: "git push that overwrites or deletes remote refs" },
  { pattern: /\bdrop\s+(?:database|table|schema)\b/i, reason: "dropping database objects" },
  { pattern: /\bmkfs(?:\.\w+)?\b/, reason: "formatting a filesystem" },
  { pattern: /\bdd\b[^;&|\n]*\bof=\/dev\//, reason: "writing directly to a device" },
  { pattern: /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/, reason: "fork bomb" },
  { pattern: /\b(?:chmod|chown)\s+(?:-[a-zA-Z]*R[a-zA-Z]*|--recursive)\s[^;&|\n]*\s\/(?:\s|$)/, reason: "recursive permission change on /" },
  { pattern: /--no-preserve-root\b/, reason: "disabling root deletion protection" },
];

const CONFIRM_PATTERN_RULES: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\bgit\s+reset\b[^;&|\n]*\s--hard(?:\s|$)/, reason: "git reset --hard can discard local changes" },
  { pattern: /\bgit\s+clean\b[^;&|\n]*(?:\s-[a-zA-Z]*f[a-zA-Z]*|\s--force)(?:\s|$)/, reason: "forced git clean can delete untracked files" },
  { pattern: /\bgit\s+rebase\b/, reason: "git rebase rewrites commit history" },
  { pattern: /\bgit\s+cherry-pick\b/, reason: "git cherry-pick changes repository history" },
  { pattern: /\bdocker\s+system\s+prune\b/, reason: "docker system prune removes unused Docker data" },
];

const SUDO_REASON = "sudo runs a command with elevated privileges";
const COMMAND_WRAPPERS = new Set(["command", "env", "exec", "nice", "nohup", "time"]);

function normalizeTarget(token: string): string {
  const target = token.replace(/^["']|["']$/g, "").replace(/\/\*?$/, "");
  return target === "" ? "/" : target;
}

function hasRecursiveRemoveOfProtectedPath(command: string): boolean {
  for (const match of command.matchAll(/\brm\b([^;&|\n]*)/g)) {
    const tokens = match[1].split(/\s+/).filter(Boolean);
    const recursive = tokens.some((token) => /^-[a-zA-Z]*[rR]/.test(token) || token === "--recursive");
    const targets = tokens.filter((token) => !token.startsWith("-")).map(normalizeTarget);
    if (recursive && targets.some((target) => PROTECTED_TARGETS.has(target))) return true;
  }
  return false;
}

function containsSudoInvocation(command: string): boolean {
  const segments: string[][] = [];
  let words: string[] = [];
  let word = "";
  let inWord = false;
  let quote: "'" | '"' | null = null;
  let escaped = false;

  const flushWord = () => {
    if (inWord) words.push(word);
    word = "";
    inWord = false;
  };
  const flushSegment = () => {
    flushWord();
    if (words.length > 0) segments.push(words);
    words = [];
  };

  for (const char of command) {
    if (escaped) {
      word += char;
      inWord = true;
      escaped = false;
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
      else word += char;
      inWord = true;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      inWord = true;
    } else if (char === "'" || char === '"') {
      quote = char;
      inWord = true;
    } else if (/[;&|\n()]/.test(char)) {
      flushSegment();
    } else if (/\s/.test(char)) {
      flushWord();
    } else {
      word += char;
      inWord = true;
    }
  }
  flushSegment();

  return segments.some((segment) => {
    let index = 0;
    while (index < segment.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(segment[index])) index += 1;
    while (index < segment.length && ["if", "then", "else", "do", "!"].includes(segment[index])) index += 1;
    while (index < segment.length && COMMAND_WRAPPERS.has(segment[index])) {
      index += 1;
      while (index < segment.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(segment[index])) index += 1;
    }
    return segment[index] === "sudo";
  });
}

export function findDenyReasons(command: string): string[] {
  const reasons = PATTERN_RULES.filter((rule) => rule.pattern.test(command)).map((rule) => rule.reason);
  if (hasRecursiveRemoveOfProtectedPath(command)) reasons.push("recursive delete of /, ~, $HOME or a system directory");
  return reasons;
}

export function findConfirmReasons(command: string): string[] {
  const reasons = CONFIRM_PATTERN_RULES.filter((rule) => rule.pattern.test(command)).map((rule) => rule.reason);
  if (containsSudoInvocation(command)) reasons.push(SUDO_REASON);
  return reasons;
}
