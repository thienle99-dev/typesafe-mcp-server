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

export function findDenyReasons(command: string): string[] {
  const reasons = PATTERN_RULES.filter((rule) => rule.pattern.test(command)).map((rule) => rule.reason);
  if (hasRecursiveRemoveOfProtectedPath(command)) reasons.push("recursive delete of /, ~, $HOME or a system directory");
  return reasons;
}
