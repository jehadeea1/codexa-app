const forbiddenSegments = new Set(['.npmrc', '.git', '.ssh']);
const folderMarkerSuffix = '/.codexa-folder';

export type ProjectPathKind = 'file' | 'directory';

export function normalizeProjectPath(input: string): string {
  return input.replaceAll('\\', '/').trim().replace(/^\.\//, '');
}

export function validateProjectPath(input: string, allowInternalFolderMarker = false): string | null {
  const path = normalizeProjectPath(input);
  if (!path || path.startsWith('/') || /^[a-zA-Z]:/.test(path)) return 'المسار يجب أن يكون نسبياً داخل المشروع.';
  const segments = path.split('/');
  if (segments.some((part) => !part || part === '.' || part === '..')) return 'المسار يحتوي اسماً فارغاً أو اجتيازاً للمجلدات.';
  if (segments.some((part, index) => {
    const lower = part.toLowerCase();
    const reservedMarker = lower === '.codexa-folder' && !(allowInternalFolderMarker && index === segments.length - 1);
    const secret = forbiddenSegments.has(lower) || lower === '.env' || (lower.startsWith('.env.') && lower !== '.env.example');
    return reservedMarker || secret;
  })) return 'لا يمكن استيراد ملف إعدادات سري أو مجلد نظام أو علامة مجلد داخلية.';
  if (/\.(?:jks|keystore|p12|pfx|pem|key|crt)$/i.test(path)) return 'ملفات مفاتيح التوقيع والشهادات غير مسموح باستيرادها.';
  if (path.length > 240 || segments.some((part) => part.length > 120)) return 'اسم المسار طويل جداً.';
  if (/[\u0000-\u001f]/.test(path)) return 'المسار يحتوي أحرفاً غير مسموحة.';
  return null;
}

/** Finds exact file/directory conflicts and file-versus-directory prefix collisions. */
export function findProjectPathConflict(path: string, kind: ProjectPathKind, otherPaths: string[], ignoredPaths: string[] = []): string | undefined {
  const candidate = normalizeProjectPath(path);
  if (!candidate) return undefined;
  const ignored = new Set(ignoredPaths.map(normalizeProjectPath));
  const namespace = new Map<string, ProjectPathKind>();
  const add = (entry: string, entryKind: ProjectPathKind) => {
    if (entry && !namespace.has(entry)) namespace.set(entry, entryKind);
  };
  for (const raw of otherPaths) {
    const entry = normalizeProjectPath(raw);
    if (!entry || ignored.has(entry)) continue;
    const marker = entry.endsWith(folderMarkerSuffix);
    const representedPath = marker ? entry.slice(0, -folderMarkerSuffix.length) : entry;
    if (!representedPath) continue;
    add(representedPath, marker ? 'directory' : 'file');
    const segments = representedPath.split('/');
    for (let index = 1; index < segments.length; index += 1) add(segments.slice(0, index).join('/'), 'directory');
  }
  for (const [existing, existingKind] of namespace) {
    if (existing === candidate) return existing;
    if (existingKind === 'file' && candidate.startsWith(`${existing}/`)) return existing;
    if (kind === 'file' && existing.startsWith(`${candidate}/`)) return existing;
  }
  return undefined;
}

export function resolveProjectReference(basePath: string, reference: string): string | null {
  const trimmed = reference.trim();
  if (!trimmed || /^(?:[a-z]+:|\/\/|#|data:|blob:)/i.test(trimmed)) return null;
  let decoded = trimmed.split(/[?#]/, 1)[0];
  try { decoded = decodeURIComponent(decoded); } catch { return null; }
  const base = decoded.startsWith('/') ? [] : basePath.split('/').slice(0, -1);
  for (const segment of decoded.replaceAll('\\', '/').split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      if (!base.length) return null;
      base.pop();
    } else base.push(segment);
  }
  const resolved = base.join('/');
  return validateProjectPath(resolved) ? null : resolved;
}
