import * as path from "path";

export interface SessionIdentity {
  provider: string;
  session_id: string;
  project_path?: string | null;
  file_path?: string | null;
}

export function normalizeComparablePath(value: string | null | undefined): string {
  if (!value) return "";
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

export function pathsEqual(
  left: string | null | undefined,
  right: string | null | undefined
): boolean {
  const a = normalizeComparablePath(left);
  const b = normalizeComparablePath(right);
  return Boolean(a && b && a === b);
}

export function sessionIdMatches(
  provider: string,
  candidate: string,
  selector: string,
  prefix = false
): boolean {
  const actual = provider === "pi" ? candidate : candidate.toLowerCase();
  const expected = provider === "pi" ? selector : selector.toLowerCase();
  return prefix ? actual.startsWith(expected) : actual === expected;
}

export function sessionFileLookupKey(filePath: string): string {
  return `file\0${normalizeComparablePath(filePath)}`;
}

export function scopedSessionLookupKey(
  provider: string,
  sessionId: string,
  projectPath?: string | null
): string {
  const id = provider === "pi" ? sessionId : sessionId.toLowerCase();
  return `scope\0${provider.toLowerCase()}\0${id}\0${normalizeComparablePath(projectPath)}`;
}

export function unscopedSessionLookupKey(sessionId: string): string {
  return `id\0${sessionId}`;
}

export function sessionIdentityKey(session: SessionIdentity): string {
  if (session.file_path) return sessionFileLookupKey(session.file_path);
  return scopedSessionLookupKey(
    session.provider,
    session.session_id,
    session.project_path
  );
}

export function sameSessionIdentity(
  left: SessionIdentity,
  right: SessionIdentity
): boolean {
  if (left.file_path && right.file_path && pathsEqual(left.file_path, right.file_path)) {
    return true;
  }
  if (left.provider.toLowerCase() !== right.provider.toLowerCase()) return false;
  if (!sessionIdMatches(left.provider, left.session_id, right.session_id)) return false;
  if (left.provider === "pi") {
    return pathsEqual(left.project_path, right.project_path);
  }
  return true;
}
