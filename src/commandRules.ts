const PROTECTED_TARGETS = new Set(["/", "/*", "~", "~/", "~/*", "$HOME", "$HOME/", "$HOME/*", "${HOME}", "${HOME}/", "${HOME}/*"]);

const PATTERN_RULES: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\bgit\s+push\b[^;&|\n]*\s(?:-[a-zA-Z]*f[a-zA-Z]*|--force(?:-with-lease|-if-includes)?)(?:[\s=]|$)/, reason: "git force push" },
  { pattern: /\b(?:curl|wget)\b[^|\n]*\|\s*(?:sudo\s+)?(?:ba|z|da|k)?sh\b/, reason: "piping a remote script into a shell" },
  { pattern: /\bdrop\s+(?:database|table|schema)\b/i, reason: "dropping database objects" },
  { pattern: /\bmkfs(?:\.\w+)?\b/, reason: "formatting a filesystem" },
  { pattern: /\bdd\b[^;&|\n]*\bof=\/dev\//, reason: "writing directly to a device" },
  { pattern: /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/, reason: "fork bomb" },
  { pattern: /\b(?:chmod|chown)\s+(?:-[a-zA-Z]*R[a-zA-Z]*|--recursive)\s[^;&|\n]*\s\/(?:\s|$)/, reason: "recursive permission change on /" },
  { pattern: /--no-preserve-root\b/, reason: "disabling root deletion protection" },
];

function stripQuotes(token: string): string {
  return token.replace(/^["']|["']$/g, "");
}

function hasRecursiveRemoveOfProtectedPath(command: string): boolean {
  for (const match of command.matchAll(/\brm\b([^;&|\n]*)/g)) {
    const tokens = match[1].split(/\s+/).filter(Boolean);
    const recursive = tokens.some((token) => /^-[a-zA-Z]*[rR]/.test(token) || token === "--recursive");
    const targets = tokens.filter((token) => !token.startsWith("-")).map(stripQuotes);
    if (recursive && targets.some((target) => PROTECTED_TARGETS.has(target))) return true;
  }
  return false;
}

export function findDenyReasons(command: string): string[] {
  const reasons = PATTERN_RULES.filter((rule) => rule.pattern.test(command)).map((rule) => rule.reason);
  if (hasRecursiveRemoveOfProtectedPath(command)) reasons.push("recursive delete of /, ~ or $HOME");
  return reasons;
}
