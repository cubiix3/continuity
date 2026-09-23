/** Conservative secret heuristics shared by source indexing and startup context. Detection is best effort. */
export function looksSensitive(text: string): boolean {
  return /-----BEGIN [A-Z ]*PRIVATE KEY-----|(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|AKIA[A-Z0-9]{16})|(?:password|secret|api[_-]?key|access[_-]?token)\s*[=:]\s*["']?[^\s"']{8,}/i.test(text);
}
