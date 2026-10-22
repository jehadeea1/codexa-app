import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  AlertTriangle, ArrowDownToLine, ArrowLeft, ArrowUpRight, Braces, Check, CheckCircle2, ChevronDown,
  Code2, Copy, Download, Eye, File, FileCode2, FilePlus2, FileText, Folder, FolderOpen, FolderPlus,
  Globe2, LoaderCircle, Maximize2, Menu, Moon, MoreHorizontal, Pencil, Play, Plus, RefreshCw,
  Search, Settings2, ShieldCheck, Smartphone, Sparkles, Sun, Terminal, Trash2, Upload, X,
} from 'lucide-react';
import { fileTemplates, templateById } from './file-templates';
import { detectLanguage, languageLabel, languageOptions } from './languages';
import { buildPreview } from './preview/build-preview';
import { getProjects, getTheme, removeProject, saveProject, saveTheme } from './project-store';
import { createSampleProject } from './sample-project';
import { downloadBlob, extensionOf, fileTextOrDataUrl, safeFilename } from './file-utils';
import { findProjectPathConflict, normalizeProjectPath, validateProjectPath } from './project-paths';
import type { AndroidIdentity, CodeProject, PreviewResult, ThemeMode, WorkspacePanel } from './types';
import './source-inspector.css';

const CodeEditor = lazy(() => import('./components/CodeEditor').then((module) => ({ default: module.CodeEditor })));
const IconLibrary = lazy(() => import('./android/icon-library').then((module) => ({ default: module.IconLibrary })));

type DialogKind = 'new-file' | 'new-project' | 'new-folder' | 'rename' | 'search' | 'apk' | null;
type WorkspaceHistory = { panel: WorkspacePanel; drawerOpen: boolean; dialog: DialogKind };
type ApkBuildTrack = 'webview' | 'native';
type PreviewScope = 'project' | 'file';
type PendingBuild = { jobId: string; track: ApkBuildTrack; projectId: string; appName: string; entry: string; packageId: string };
type VerifiedApk = { blob: Blob; filename: string; track: ApkBuildTrack; projectId: string; appName: string; packageId: string; entry: string; bytes: number };
const BUILD_SESSION_KEY = 'codexa:pending-apk-build';

const iconForType: Record<string, typeof File> = {
  html: Globe2, css: Sparkles, javascript: Braces, typescript: FileCode2, json: Braces,
  markdown: FileText, python: Terminal, java: Code2, kotlin: Code2, c: Code2, cpp: Code2,
  go: Code2, rust: Code2, svg: Sparkles, xml: FileCode2, plaintext: FileText,
};

function ProjectFileIcon({ path, language }: { path: string; language: string }) {
  if (language === 'kotlin' || /\.kts$/i.test(path)) return <span className="special-file-icon kotlin-file-icon" aria-label="Kotlin"><Code2 size={15} /><b>Kt</b></span>;
  if (/\.xml$/i.test(path)) return <span className="special-file-icon xml-file-icon" aria-label="XML"><FileText size={15} /><b>XML</b></span>;
  const Icon = iconForType[language] ?? File;
  return <Icon size={16} />;
}

function RuntimeBadge({ path }: { path: string }) {
  const android = /\.(?:kt|kts|java|xml)$/i.test(path);
  const web = /\.(?:html?|xhtml|css|js|mjs)$/i.test(path);
  const kind = android ? 'android' : web ? 'web' : 'source';
  const label = kind === 'web' ? 'تشغيل مباشر في المتصفح' : kind === 'android' ? 'يتطلب بناء Native APK للتشغيل على الهاتف' : 'محرر ومفتش نصوص برمجية · دون تشغيل تلقائي';
  return <span className={`runtime-badge runtime-${kind}`} role="status"><span />{label}</span>;
}

function newAndroidIdentity(id: string, name: string): AndroidIdentity {
  return {
    appName: name || 'تطبيقي',
    packageId: `com.codexa.p${id.replaceAll('-', '').slice(0, 10)}`,
    iconName: 'Sparkles', iconBackground: '#A9EC76', iconForeground: '#10130F', iconShape: 'rounded', allowExternalNetwork: false,
  };
}

function makeProject(name: string): CodeProject {
  const project = createSampleProject();
  return { ...project, name: name || 'مشروع جديد', android: { ...project.android, appName: name || 'تطبيقي' }, updatedAt: Date.now() };
}

function bytesToDataUrl(bytes: Uint8Array, path: string): string {
  const ext = extensionOf(path);
  const mime: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', avif: 'image/avif', ico: 'image/x-icon', woff2: 'font/woff2', woff: 'font/woff', ttf: 'font/ttf', otf: 'font/otf', mp4: 'video/mp4', mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/mp4', webm: 'video/webm', mov: 'video/quicktime' };
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return `data:${mime[ext] ?? 'application/octet-stream'};base64,${btoa(binary)}`;
}

const PROJECT_ARCHIVE_META = '.codexa/project.json';
const MAX_ZIP_ARCHIVE_BYTES = 24 * 1024 * 1024;
const MAX_ZIP_METADATA_BYTES = 1024 * 1024;
interface ProjectArchiveMetadata {
  format?: string; version?: number; name?: string; entry?: string; android?: unknown;
  createdAt?: number; updatedAt?: number;
  files?: Array<{ path?: string; languageOverride?: string | null; updatedAt?: number }>;
  folders?: string[];
}

function findFileConflict(path: string, others: string[], ignoredPaths: string[] = []): string | undefined {
  return findProjectPathConflict(path, 'file', others, ignoredPaths);
}

function restoreAndroidIdentity(value: unknown, id: string, name: string): AndroidIdentity {
  const fallback = newAndroidIdentity(id, name);
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fallback;
  const source = value as Record<string, unknown>;
  const validPackage = typeof source.packageId === 'string' && /^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*){1,6}$/.test(source.packageId);
  const validColor = (candidate: unknown, defaultValue: string) => typeof candidate === 'string' && /^#[\da-f]{6}$/i.test(candidate) ? candidate : defaultValue;
  const iconShape = ['rounded', 'circle', 'squircle'].includes(String(source.iconShape)) ? source.iconShape as AndroidIdentity['iconShape'] : fallback.iconShape;
  const uploadedIcon = typeof source.uploadedIcon === 'string' && source.uploadedIcon.length <= 8 * 1024 * 1024 && /^data:image\/(?:png|jpeg|webp|avif);base64,[A-Za-z0-9+/=]+$/i.test(source.uploadedIcon) ? source.uploadedIcon : undefined;
  return {
    appName: typeof source.appName === 'string' && source.appName.trim() ? source.appName.trim().slice(0, 32) : fallback.appName,
    packageId: validPackage ? source.packageId as string : fallback.packageId,
    iconName: typeof source.iconName === 'string' && source.iconName.length <= 80 ? source.iconName : fallback.iconName,
    iconBackground: validColor(source.iconBackground, fallback.iconBackground),
    iconForeground: validColor(source.iconForeground, fallback.iconForeground),
    iconShape,
    allowExternalNetwork: source.allowExternalNetwork === true,
    ...(uploadedIcon ? { uploadedIcon } : {}),
  };
}

function localFileName(path: string): string {
  return path.split('/').at(-1) ?? path;
}

function nativeLayoutEntry(files: CodeProject['files']): string {
  const paths = Object.keys(files).filter((path) => !path.endsWith('/.codexa-folder') && /\.xml$/i.test(path));
  const layouts = paths.filter((path) => /(?:^|\/)res\/layout(?:-[^/]+)?\/[^/]+\.xml$/i.test(path) || /(?:^|\/)layout\/[^/]+\.xml$/i.test(path));
  const candidates = layouts.length ? layouts : paths.filter((path) => !/(?:AndroidManifest|\/values\/)/i.test(path));
  const priority = candidates.find((path) => /(?:^|\/)(?:activity_main|main|content_main)\.xml$/i.test(path));
  return priority ?? candidates[0] ?? '';
}

function projectEntryPath(project: Pick<CodeProject, 'files' | 'entry'>): string {
  const paths = Object.keys(project.files).filter((path) => !path.endsWith('/.codexa-folder')).sort((a, b) => a.localeCompare(b));
  const html = paths.filter((path) => /\.(?:html?|xhtml)$/i.test(path));
  if (project.entry && html.includes(project.entry)) return project.entry;
  const index = html.find((path) => /(?:^|\/)index\.html?$/i.test(path));
  if (index) return index;
  if (html[0]) return html[0];
  const layout = nativeLayoutEntry(project.files);
  if (layout) return layout;
  if (project.entry && paths.includes(project.entry)) return project.entry;
  return paths.find((path) => /(?:^|\/)MainActivity\.(?:kt|java)$/i.test(path)) ?? paths[0] ?? '';
}

function parentFolder(path: string): string {
  const pieces = path.split('/');
  return pieces.length > 1 ? pieces.slice(0, -1).join('/') : '';
}

function FileTree({
  project, activePath, filter, onFilterChange, onSelect, onRename, onCopy, onDelete, onNewFile, onNewFolder, onImport, onImportFolder, onImportZip, onDeleteFolder, onRenameFolder, onPreviewProject,
}: {
  project: CodeProject; activePath: string; onSelect: (path: string) => void;
  filter: string; onFilterChange: (value: string) => void;
  onRename: (path: string) => void; onCopy: (path: string) => void; onDelete: (path: string) => void;
  onNewFile: (parent?: string) => void; onNewFolder: (parent?: string) => void; onImport: () => void; onImportFolder: () => void; onImportZip: () => void; onDeleteFolder: (path: string) => void; onRenameFolder: (path: string) => void; onPreviewProject: () => void;
}) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const entries = useMemo(() => Object.keys(project.files).filter((path) => !path.endsWith('/.codexa-folder')).sort((a, b) => a.localeCompare(b)), [project.files]);
  const folders = useMemo(() => {
    const all = new Set<string>();
    for (const path of Object.keys(project.files)) {
      const normalized = path.endsWith('/.codexa-folder') ? path.split('/').slice(0, -1).join('/') : path;
      if (path.endsWith('/.codexa-folder') && normalized) all.add(normalized);
      const parts = normalized.split('/');
      for (let i = 1; i < parts.length; i += 1) all.add(parts.slice(0, i).join('/'));
    }
    return [...all].sort((a, b) => a.localeCompare(b));
  }, [project.files]);
  const needle = filter.trim().toLocaleLowerCase();
  const matchingFiles = needle ? entries.filter((path) => path.toLocaleLowerCase().includes(needle)) : entries;
  const visibleFiles = matchingFiles.filter((path) => {
    const folder = parentFolder(path);
    if (!folder) return true;
    if (needle) return true;
    return !folder.split('/').some((_, index) => {
      const prefix = folder.split('/').slice(0, index + 1).join('/');
      return expanded[prefix] === false;
    });
  });
  const visibleFolders = folders.filter((folder) => {
    if (needle && !folder.toLocaleLowerCase().includes(needle) && !matchingFiles.some((path) => path.startsWith(`${folder}/`))) return false;
    return needle || !folder.split('/').slice(0, -1).some((_, index) => expanded[folder.split('/').slice(0, index + 1).join('/')] === false);
  });

  return <div className="tree-wrap">
    <div className="tree-heading"><span>شجرة المشروع النشط</span><div className="tree-actions"><button className="tiny-icon" onClick={onPreviewProject} title="معاينة مدخل المشروع"><Play size={14} /></button><button className="tiny-icon" onClick={onImport} title="استيراد ملف أو ملفات"><Upload size={15} /></button><button className="tiny-icon" onClick={onImportFolder} title="استيراد مجلد كامل"><FolderOpen size={15} /></button><button className="tiny-icon" onClick={onImportZip} title="استيراد مشروع ZIP"><Download size={15} /></button><button className="tiny-icon" onClick={() => onNewFile()} title="ملف جديد"><FilePlus2 size={16} /></button><button className="tiny-icon" onClick={() => onNewFolder()} title="مجلد جديد"><FolderPlus size={16} /></button></div></div>
    <div className="tree-project-root"><FolderOpen size={14} /><span>{project.name}</span><small>{entries.length} ملف · جذر محلي مستقل</small></div>
    <label className="tree-search"><Search size={15} /><input value={filter} onChange={(event) => onFilterChange(event.target.value)} placeholder="ابحث عن ملف أو مجلد…" aria-label="بحث في ملفات المشروع" />{filter && <button type="button" onClick={() => onFilterChange('')} aria-label="مسح البحث"><X size={13} /></button>}</label>
    <div className="tree-list">
      {visibleFolders.map((folder) => {
        const depth = folder.split('/').length - 1;
        const open = needle ? true : expanded[folder] !== false;
        return <div className="tree-row folder-row" key={`folder:${folder}`}>
          <button className="tree-item folder-item" style={{ paddingInlineStart: 12 + depth * 15 }} onClick={() => setExpanded((old) => ({ ...old, [folder]: !open }))}>
            {open ? <FolderOpen size={16} /> : <Folder size={16} />}<span className="tree-name">{localFileName(folder)}</span><ChevronDown className={!open ? 'rotate-closed' : ''} size={13} />
          </button><button className="tiny-icon" onClick={() => onNewFile(folder)} title="إنشاء ملف في المجلد"><FilePlus2 size={13} /></button><button className="tiny-icon" onClick={() => onNewFolder(folder)} title="إنشاء مجلد فرعي"><FolderPlus size={13} /></button><button className="tiny-icon" onClick={() => onRenameFolder(folder)} title="إعادة تسمية المجلد"><Pencil size={13} /></button><button className="tiny-icon" onClick={() => onDeleteFolder(folder)} title="حذف المجلد"><Trash2 size={13} /></button>
        </div>;
      })}
      {visibleFiles.map((path) => {
        const lang = detectLanguage(path, project.files[path].languageOverride);
        return <div className={`tree-row ${activePath === path ? 'active' : ''}`} key={path} style={{ paddingInlineStart: 12 + Math.max(0, path.split('/').length - 1) * 15 }}>
          <button className="tree-item" onClick={() => onSelect(path)} title={path}><ProjectFileIcon path={path} language={lang} /><span className="tree-name">{localFileName(path)}</span><span className="tree-ext">{languageLabel(lang)}</span></button>
          <div className="tree-menu">
            <button className="tiny-icon" onClick={() => onCopy(path)} title="نسخ الملف"><Copy size={14} /></button>
            <button className="tiny-icon" onClick={() => onRename(path)} title="إعادة تسمية"><MoreHorizontal size={15} /></button>
            <button className="tiny-icon" onClick={() => onDelete(path)} title="حذف الملف"><Trash2 size={13} /></button>
          </div>
        </div>;
      })}
      {needle && !matchingFiles.length && <div className="empty-list"><Search size={18} /><span>لا توجد نتائج مطابقة</span></div>}
      {!needle && Object.keys(project.files).filter((path) => !path.endsWith('/.codexa-folder')).length === 0 && <div className="empty-list"><FolderOpen size={20} /><span>لا توجد ملفات بعد</span><button onClick={() => onNewFile()}>إنشاء أول ملف</button></div>}
    </div>
  </div>;
}

function ModalFrame({ title, subtitle, children, onClose, className = '' }: { title: string; subtitle?: string; children: React.ReactNode; onClose: () => void; className?: string }) {
  return createPortal(<div className="modal-backdrop" role="presentation" style={{ zIndex: 10000 }} onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
    <section className={`dialog ${className}`} role="dialog" aria-modal="true" aria-label={title}>
      <header className="dialog-head"><div><span className="eyebrow">{subtitle ?? 'CODEXA'}</span><h2>{title}</h2></div><button className="icon-button" onClick={onClose} aria-label="إغلاق"><X size={18} /></button></header>
      {children}
    </section>
  </div>, document.body);
}

function ModalLoading({ label }: { label: string }) {
  return createPortal(<div className="modal-backdrop" role="status" style={{ zIndex: 10010 }}><div className="dialog small-dialog"><div className="dialog-head">{label}</div></div></div>, document.body);
}

export function App() {
  const [projects, setProjects] = useState<CodeProject[]>([]);
  const [activeProjectId, setActiveProjectId] = useState('');
  const [activePath, setActivePath] = useState('');
  const [openTabs, setOpenTabs] = useState<string[]>([]);
  const [apkEntry, setApkEntry] = useState('');
  const [panel, setPanel] = useState<WorkspacePanel>('editor');
  const [theme, setTheme] = useState<ThemeMode>('dark');
  const [loaded, setLoaded] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [dialog, setDialog] = useState<DialogKind>(null);
  const [templateId, setTemplateId] = useState('html');
  const [fileBaseName, setFileBaseName] = useState('page');
  const [fileParent, setFileParent] = useState('');
  const [folderName, setFolderName] = useState('assets');
  const [folderParent, setFolderParent] = useState('');
  const [projectName, setProjectName] = useState('');
  const [renamePath, setRenamePath] = useState('');
  const [renameName, setRenameName] = useState('');
  const [query, setQuery] = useState('');
  const [replaceText, setReplaceText] = useState('');
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [previewScope, setPreviewScope] = useState<PreviewScope>('project');
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewTick, setPreviewTick] = useState(0);
  const [previewConsentFor, setPreviewConsentFor] = useState('');
  const [searchTerm, setSearchTerm] = useState('');
  const [fileFilter, setFileFilter] = useState('');
  const [toast, setToast] = useState('');
  const [buildConsent, setBuildConsent] = useState(false);
  const [buildTrack, setBuildTrack] = useState<ApkBuildTrack>('webview');
  const [buildRunning, setBuildRunning] = useState(false);
  const [buildProgress, setBuildProgress] = useState(0);
  const [buildMessage, setBuildMessage] = useState('');
  const [buildArtifact, setBuildArtifact] = useState<VerifiedApk | null>(null);
  const [buildAudit, setBuildAudit] = useState('');
  const [iconOpen, setIconOpen] = useState(false);
  const [identityDraft, setIdentityDraft] = useState<AndroidIdentity | null>(null);
  const [deviceMode, setDeviceMode] = useState<'live' | 'phone' | 'tablet' | 'desktop'>('live');
  const [importInputId] = useState('codexa-import');
  const directoryInputRef = useRef<HTMLInputElement>(null);
  const workspaceHistoryRef = useRef<WorkspaceHistory>({ panel: 'editor', drawerOpen: false, dialog: null });
  const resumedBuildRef = useRef('');

  useEffect(() => {
    const snapshot = { ...workspaceHistoryRef.current };
    window.history.replaceState({ ...window.history.state, codexaWorkspace: snapshot }, '', window.location.href);
    const onPopState = (event: PopStateEvent) => {
      const current = workspaceHistoryRef.current;
      const state = event.state && typeof event.state === 'object' ? (event.state as { codexaWorkspace?: Partial<WorkspaceHistory> }).codexaWorkspace : undefined;
      let next: WorkspaceHistory = state && ['files', 'editor', 'preview'].includes(String(state.panel))
        ? { panel: state.panel as WorkspacePanel, drawerOpen: state.drawerOpen === true, dialog: state.dialog ?? null }
        : current.drawerOpen
          ? { panel: current.panel === 'files' ? 'editor' : current.panel, drawerOpen: false, dialog: null }
          : { panel: current.panel === 'preview' ? 'editor' : 'editor', drawerOpen: false, dialog: null };
      if (current.dialog) next = { ...next, dialog: null };
      workspaceHistoryRef.current = next;
      setPanel(next.panel); setDrawerOpen(next.drawerOpen); setDialog(next.dialog);
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  useEffect(() => {
    const snapshot = { panel, drawerOpen, dialog };
    workspaceHistoryRef.current = snapshot;
    window.history.replaceState({ ...window.history.state, codexaWorkspace: snapshot }, '', window.location.href);
  }, [panel, drawerOpen, dialog]);

  useEffect(() => {
    if ((dialog || iconOpen) && drawerOpen) {
      const current = workspaceHistoryRef.current;
      const snapshot = { ...current, panel: current.panel === 'files' ? 'editor' : current.panel, drawerOpen: false };
      window.history.replaceState({ ...window.history.state, codexaWorkspace: snapshot }, '', window.location.href);
      workspaceHistoryRef.current = snapshot;
      setPanel(snapshot.panel); setDrawerOpen(false);
    }
  }, [dialog, iconOpen, drawerOpen]);

  const activeProject = projects.find((project) => project.id === activeProjectId) ?? null;
  const activeFile = activeProject?.files[activePath] ?? null;
  const htmlEntries = useMemo(() => activeProject ? Object.keys(activeProject.files).filter((path) => /\.(?:html?|xhtml)$/i.test(path) && !path.endsWith('/.codexa-folder')) : [], [activeProject?.files]);
  const projectPreviewPath = useMemo(() => activeProject ? projectEntryPath(activeProject) : '', [activeProject?.files, activeProject?.entry]);
  const nativeXmlPreviewPath = useMemo(() => activeProject ? nativeLayoutEntry(activeProject.files) : '', [activeProject?.files]);
  const previewPath = previewScope === 'project' && projectPreviewPath ? projectPreviewPath : activePath;
  const previewFile = activeProject?.files[previewPath] ?? null;
  const nativeFileCount = useMemo(() => activeProject ? Object.keys(activeProject.files).filter((path) => /\.(?:kt|java)$/i.test(path) && !path.endsWith('/.codexa-folder')).length : 0, [activeProject?.files]);
  const language = activeFile ? detectLanguage(activeFile.path, activeFile.languageOverride) : 'plaintext';
  const filesCount = activeProject ? Object.keys(activeProject.files).filter((path) => !path.endsWith('/.codexa-folder')).length : 0;
  const projectLanguageInventory = useMemo(() => {
    const counts = new Map<string, number>();
    for (const file of Object.values(activeProject?.files ?? {})) {
      if (file.path.endsWith('/.codexa-folder')) continue;
      const detected = detectLanguage(file.path, file.languageOverride);
      counts.set(detected, (counts.get(detected) ?? 0) + 1);
    }
    return [...counts].sort(([a], [b]) => a.localeCompare(b)).map(([name, count]) => `${languageLabel(name)} (${count})`);
  }, [activeProject?.files]);
  const externalResources = useMemo(() => {
    const found = new Set<string>();
    for (const file of Object.values(activeProject?.files ?? {})) {
      for (const reference of file.content.match(/https?:\/\/[^\s"'<>`]+|\/\/[a-z\d.-]+\.[a-z]{2,}[^\s"'<>`]*/gi) ?? []) {
        const cleaned = reference.replace(/[),.;]+$/, '').slice(0, 160);
        if (cleaned) found.add(cleaned);
      }
    }
    return [...found].slice(0, 8);
  }, [activeProject?.files]);
  const previewConsentKey = `${activeProjectId}:${externalResources.join('|')}`;
  const allowExternalPreview = previewConsentFor === previewConsentKey;
  const iframeSandbox = allowExternalPreview ? 'allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads' : 'allow-scripts allow-forms allow-modals allow-downloads';
  const template = templateById(templateId);

  useEffect(() => {
    let alive = true;
    Promise.all([getProjects(), getTheme()]).then(async ([stored, storedTheme]) => {
      if (!alive) return;
      let initial = stored;
      if (!initial.length) {
        const demo = createSampleProject();
        await saveProject(demo);
        initial = [demo];
      }
      setProjects(initial);
      setActiveProjectId(initial[0].id);
      setActivePath(projectEntryPath(initial[0]));
      setTheme(storedTheme);
      setLoaded(true);
    }).catch(() => {
      if (!alive) return;
      const demo = createSampleProject();
      setProjects([demo]); setActiveProjectId(demo.id); setActivePath(projectEntryPath(demo)); setLoaded(true);
      setToast('تعذر فتح التخزين المحلي؛ تم فتح مساحة تجريبية مؤقتة.');
    });
    if ('serviceWorker' in navigator) void navigator.serviceWorker.register('/sw.js').catch(() => undefined);
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    if (!loaded) return;
    const timer = window.setTimeout(() => { for (const project of projects) void saveProject(project); }, 250);
    return () => window.clearTimeout(timer);
  }, [projects, loaded]);

  useEffect(() => {
    setOpenTabs((current) => {
      const next = current.filter((path) => Boolean(activeProject?.files[path]));
      if (activePath && activeProject?.files[activePath] && !next.includes(activePath)) next.push(activePath);
      if (current.length === next.length && current.every((path, index) => path === next[index])) return current;
      return next.slice(-10);
    });
  }, [activeProjectId, activePath, activeProject?.files]);

  useEffect(() => {
    if (!loaded || !activeProject) return;
    let pending: PendingBuild | null = null;
    try {
      const raw = window.sessionStorage.getItem(BUILD_SESSION_KEY);
      if (raw) pending = JSON.parse(raw) as PendingBuild;
    } catch { return; }
    if (!pending || pending.projectId !== activeProject.id || !/^[\da-f-]{36}$/i.test(pending.jobId) || !['webview', 'native'].includes(pending.track)) return;
    if (resumedBuildRef.current === pending.jobId) return;
    resumedBuildRef.current = pending.jobId;
    setBuildTrack(pending.track); setIdentityDraft(activeProject.android); setApkEntry(pending.entry); setBuildConsent(true);
    setDialog('apk'); setBuildRunning(true); setBuildProgress(0); setBuildMessage('استعادة اتصال مهمة البناء المحفوظة…');
    void trackBuildJob(pending.track, pending.jobId, pending.appName, pending.projectId, pending.entry, activeProject.android, pending.packageId || activeProject.android.packageId)
      .catch((error) => setBuildMessage(error instanceof Error ? error.message : 'تعذر استعادة حالة البناء المحفوظة.'))
      .finally(() => setBuildRunning(false));
  }, [loaded, activeProjectId]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(''), 3200);
    return () => window.clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    if (!activeProject || !previewPath) { setPreview(null); return; }
    let cancelled = false;
    setPreviewLoading(true);
    void buildPreview(activeProject, previewPath, allowExternalPreview).then((result) => {
      if (!cancelled) setPreview(result);
    }).catch((error: unknown) => {
      if (!cancelled) setPreview({ html: '<!doctype html><html><body><p>تعذر تجهيز المعاينة.</p></body></html>', title: previewPath, diagnostics: [error instanceof Error ? error.message : 'تعذر تجهيز المعاينة.'] });
    }).finally(() => { if (!cancelled) setPreviewLoading(false); });
    return () => { cancelled = true; };
  }, [activeProject, previewPath, previewTick, allowExternalPreview]);

  const saveActiveProject = useCallback((transform: (project: CodeProject) => CodeProject) => {
    if (buildArtifact?.projectId === activeProjectId) { setBuildArtifact(null); setBuildAudit(''); }
    setProjects((current) => current.map((project) => project.id === activeProjectId ? transform(project) : project));
  }, [activeProjectId, buildArtifact?.projectId]);

  const updateFileContent = (content: string) => {
    if (!activeProject || !activeFile) return;
    saveActiveProject((project) => ({
      ...project,
      files: { ...project.files, [activePath]: { ...project.files[activePath], content, updatedAt: Date.now() } },
      updatedAt: Date.now(),
    }));
  };

  function createFile(event: React.FormEvent) {
    event.preventDefault();
    if (!activeProject) return;
    const chosen = template;
    const base = safeFilename(fileBaseName.replace(/\.[^.]+$/, ''));
    if (!base) { setToast('اكتب اسماً للملف.'); return; }
    const path = normalizeProjectPath(`${fileParent ? `${fileParent}/` : ''}${base}${chosen.extension}`);
    const pathError = validateProjectPath(path);
    if (pathError) { setToast(pathError); return; }
    const conflict = findFileConflict(path, Object.keys(activeProject.files));
    if (conflict) { setToast(`يتعارض مسار الملف مع ملف أو مجلد موجود: ${conflict}.`); return; }
    const now = Date.now();
    saveActiveProject((project) => ({ ...project, files: { ...project.files, [path]: { path, content: chosen.starter, languageOverride: null, updatedAt: now } }, updatedAt: now }));
    setActivePath(path); setPanel('editor'); setDialog(null); setToast(`أُنشئ ${path} بقالب ${chosen.label}.`);
  }

  function createFolder(event: React.FormEvent) {
    event.preventDefault();
    if (!activeProject) return;
    const name = safeFilename(folderName);
    const path = normalizeProjectPath(`${folderParent ? `${folderParent}/` : ''}${name}/.codexa-folder`);
    const error = validateProjectPath(path, true);
    if (error) { setToast(error); return; }
    const folderPath = path.slice(0, -'/.codexa-folder'.length);
    const conflict = findProjectPathConflict(folderPath, 'directory', Object.keys(activeProject.files));
    if (conflict) { setToast(`يوجد مجلد بهذا الاسم أو يتعارض مع ملف موجود: ${conflict}.`); return; }
    const now = Date.now();
    saveActiveProject((project) => ({ ...project, files: { ...project.files, [path]: { path, content: '', updatedAt: now } }, updatedAt: now }));
    setDialog(null); setPanel('editor'); setToast(`أُنشئ المجلد ${folderPath}.`);
  }

  function createProject(event: React.FormEvent) {
    event.preventDefault();
    const project = makeProject(safeFilename(projectName) || 'مشروع جديد');
    setProjects((current) => [project, ...current]);
    setActiveProjectId(project.id); setActivePath(project.entry); setOpenTabs([]); setPanel('editor'); setDialog(null); setDrawerOpen(false);
    setProjectName(''); setToast('أُنشئ المشروع الجديد وحُفظ محلياً.');
  }

  function confirmRename(event: React.FormEvent) {
    event.preventDefault();
    if (!activeProject) return;
    const previous = activeProject.files[renamePath];
    if (!previous) return;
    const oldExt = extensionOf(renamePath);
    const folder = parentFolder(renamePath);
    const inputName = safeFilename(renameName.replace(/\.[^.]+$/, ''));
    const nextPath = normalizeProjectPath(`${folder ? `${folder}/` : ''}${inputName}${oldExt ? `.${oldExt}` : ''}`);
    const error = validateProjectPath(nextPath);
    if (error) { setToast(error); return; }
    const conflict = nextPath === renamePath ? undefined : findProjectPathConflict(nextPath, 'file', Object.keys(activeProject.files), [renamePath]);
    if (conflict) { setToast(`يتعارض اسم الملف الجديد مع ملف أو مجلد موجود: ${conflict}.`); return; }
    const files = { ...activeProject.files };
    delete files[renamePath];
    files[nextPath] = { ...previous, path: nextPath, updatedAt: Date.now() };
    saveActiveProject((project) => ({ ...project, files, entry: project.entry === renamePath ? nextPath : project.entry, updatedAt: Date.now() }));
    if (activePath === renamePath) setActivePath(nextPath);
    setDialog(null); setToast('تم تحديث اسم الملف مع الحفاظ على امتداده.');
  }

  function startRename(path: string) {
    const ext = extensionOf(path);
    setRenamePath(path);
    setRenameName(ext ? localFileName(path).slice(0, -(ext.length + 1)) : localFileName(path));
    setDialog('rename');
  }

  function deleteFile(path: string) {
    if (!activeProject || !window.confirm(`حذف الملف «${path}» نهائياً من المشروع؟`)) return;
    const files = { ...activeProject.files };
    delete files[path];
    const nextPath = Object.keys(files).find((item) => !item.endsWith('/.codexa-folder')) ?? '';
    saveActiveProject((project) => ({ ...project, files, entry: project.entry === path ? nextPath : project.entry, updatedAt: Date.now() }));
    if (activePath === path) { setActivePath(nextPath); setPanel(nextPath ? 'editor' : 'files'); }
    setToast('حُذف الملف من المشروع المحلي.');
  }

  function deleteFolder(folder: string) {
    if (!activeProject || !window.confirm(`حذف المجلد «${folder}» وكل ملفاته؟`)) return;
    const files = { ...activeProject.files };
    for (const path of Object.keys(files)) if (path.startsWith(`${folder}/`)) delete files[path];
    const nextPath = Object.keys(files).find((path) => !path.endsWith('/.codexa-folder')) ?? '';
    saveActiveProject((project) => ({ ...project, files, entry: files[project.entry] ? project.entry : nextPath, updatedAt: Date.now() }));
    if (activePath.startsWith(`${folder}/`)) setActivePath(nextPath);
    setToast(`حُذف المجلد ${folder} ومحتوياته.`);
  }

  function renameFolder(folder: string) {
    if (!activeProject) return;
    const result = window.prompt('اسم المجلد الجديد', localFileName(folder));
    const name = result ? safeFilename(result) : '';
    if (!name || name === localFileName(folder)) return;
    const parent = parentFolder(folder);
    const nextRoot = normalizeProjectPath(`${parent ? `${parent}/` : ''}${name}`);
    const invalid = validateProjectPath(`${nextRoot}/.codexa-folder`, true);
    if (invalid) { setToast(invalid); return; }
    if (nextRoot.startsWith(`${folder}/`)) { setToast('لا يمكن نقل المجلد داخل نفسه.'); return; }
    const movedPaths = Object.keys(activeProject.files).filter((path) => path === folder || path.startsWith(`${folder}/`));
    const targets = movedPaths.map((path) => `${nextRoot}${path.slice(folder.length)}`);
    const conflict = findProjectPathConflict(nextRoot, 'directory', Object.keys(activeProject.files), movedPaths);
    if (conflict) { setToast(`يتعارض اسم المجلد الجديد مع ملف أو مجلد موجود: ${conflict}.`); return; }
    const files = { ...activeProject.files };
    for (const path of movedPaths) delete files[path];
    movedPaths.forEach((path, index) => { const nextPath = targets[index]; files[nextPath] = { ...activeProject.files[path], path: nextPath, updatedAt: Date.now() }; });
    const movePath = (path: string) => path === folder || path.startsWith(`${folder}/`) ? `${nextRoot}${path.slice(folder.length)}` : path;
    saveActiveProject((project) => ({ ...project, files, entry: movePath(project.entry), updatedAt: Date.now() }));
    if (activePath === folder || activePath.startsWith(`${folder}/`)) setActivePath(movePath(activePath));
    setToast(`أُعيدت تسمية المجلد إلى ${name}.`);
  }

  function duplicateFile(path: string) {
    if (!activeProject) return;
    const original = activeProject.files[path];
    if (!original) return;
    const ext = extensionOf(path);
    const fileName = localFileName(path);
    const base = ext ? fileName.slice(0, -(ext.length + 1)) : fileName;
    let number = 1;
    let next = '';
    do { next = `${parentFolder(path) ? `${parentFolder(path)}/` : ''}${base}-copy${number > 1 ? `-${number}` : ''}${ext ? `.${ext}` : ''}`; number += 1; } while (findFileConflict(next, Object.keys(activeProject.files)));
    saveActiveProject((project) => ({ ...project, files: { ...project.files, [next]: { ...original, path: next, updatedAt: Date.now() } }, updatedAt: Date.now() }));
    setActivePath(next); setToast('أُنشئت نسخة مستقلة من الملف.');
  }

  function closeFileTab(path: string) {
    const remaining = openTabs.filter((item) => item !== path);
    setOpenTabs(remaining);
    if (activePath === path) setActivePath(remaining.at(-1) ?? '');
  }

  function deleteProject(project: CodeProject) {
    if (!window.confirm(`حذف المشروع «${project.name}» وملفاته من تخزين المتصفح؟ هذا لا يحذف APK مثبّتاً على الهاتف.`)) return;
    void removeProject(project.id);
    const remaining = projects.filter((item) => item.id !== project.id);
    if (!remaining.length) {
      const replacement = createSampleProject();
      setProjects([replacement]); setActiveProjectId(replacement.id); setActivePath(replacement.entry); void saveProject(replacement);
    } else {
      setProjects(remaining);
      if (activeProjectId === project.id) { setActiveProjectId(remaining[0].id); setActivePath(remaining[0].entry); }
    }
    if (activeProjectId === project.id) setOpenTabs([]);
    setToast('حُذف المشروع من هذا المتصفح. التطبيق المثبّت مستقل عنه.');
  }

  function renameProject(project: CodeProject) {
    const result = window.prompt('اسم المشروع الجديد', project.name);
    const name = result?.trim();
    if (!name || name === project.name) return;
    setProjects((current) => current.map((item) => item.id === project.id ? { ...item, name: name.slice(0, 80), updatedAt: Date.now() } : item));
    setToast('تم تغيير اسم المشروع.');
  }

  function openFilePicker(id: string) {
    const input = document.getElementById(id) as HTMLInputElement | null;
    if (input) { input.value = ''; input.click(); }
  }

  function openFolderPicker() {
    const input = directoryInputRef.current;
    if (!input) return;
    input.setAttribute('webkitdirectory', '');
    input.setAttribute('directory', '');
    input.value = '';
    input.click();
  }

  async function importFiles(fileList: FileList | null) {
    if (!activeProject || !fileList?.length) return;
    const selected = Array.from(fileList);
    if (selected.length > 500) { setToast('الحد الأقصى للاستيراد دفعة واحدة هو 500 ملف.'); return; }
    try {
      const candidates: Array<{ file: File; path: string }> = [];
      const seenPaths: string[] = [];
      for (const file of selected) {
        const path = normalizeProjectPath(file.webkitRelativePath || file.name);
        if (path === PROJECT_ARCHIVE_META || path.endsWith('/.codexa-folder')) continue;
        const invalid = validateProjectPath(path);
        if (invalid) throw new Error(`${file.name}: ${invalid}`);
        const conflict = findFileConflict(path, [...Object.keys(activeProject.files), ...seenPaths]);
        if (conflict) throw new Error(`لم يُستورد أي ملف: يتعارض «${path}» مع الملف الموجود «${conflict}».`);
        seenPaths.push(path);
        if (file.size > 4 * 1024 * 1024) throw new Error(`الملف ${file.name} يتجاوز 4 ميغابايت.`);
        candidates.push({ file, path });
      }
      if (!candidates.length) throw new Error('لم يتم اختيار ملفات قابلة للاستيراد.');
      const pending: Array<{ path: string; content: string }> = new Array(candidates.length);
      let cursor = 0; let totalBytes = 0;
      const worker = async () => {
        while (cursor < candidates.length) {
          const index = cursor++; const candidate = candidates[index];
          const content = await fileTextOrDataUrl(candidate.file);
          const bytes = new TextEncoder().encode(content).byteLength;
          if (bytes > 4 * 1024 * 1024) throw new Error(`الملف ${candidate.file.name} يتجاوز 4 ميغابايت بعد ترميز المورد.`);
          totalBytes += bytes;
          if (totalBytes > 20 * 1024 * 1024) throw new Error('إجمالي الملفات المستوردة يتجاوز 20 ميغابايت.');
          pending[index] = { path: candidate.path, content };
        }
      };
      await Promise.all(Array.from({ length: Math.min(8, candidates.length) }, () => worker()));
      if (!pending.length) throw new Error('لم يتم اختيار ملفات قابلة للاستيراد.');
      const files = { ...activeProject.files };
      const now = Date.now();
      for (const item of pending) {
        files[item.path] = { ...item, languageOverride: null, updatedAt: now };
        const parts = item.path.split('/');
        for (let index = 1; index < parts.length; index += 1) {
          const marker = `${parts.slice(0, index).join('/')}/.codexa-folder`;
          if (!files[marker]) files[marker] = { path: marker, content: '', languageOverride: null, updatedAt: now };
        }
      }
      const nextProject = { ...activeProject, files, updatedAt: now };
      const entry = projectEntryPath(nextProject);
      saveActiveProject((project) => ({ ...project, files, entry: entry || project.entry, updatedAt: now }));
      setActivePath(entry);
      setPreviewScope('project');
      setPreviewTick((tick) => tick + 1);
      setPanel('preview'); setDrawerOpen(false);
      setToast(`استُورد ${pending.length} ملفاً مع بنيتها إلى «${activeProject.name}»؛ فُتحت المعاينة عند ${entry || 'أول ملف'}.`);
    } catch (error) { setToast(error instanceof Error ? error.message : 'تعذر استيراد الملفات.'); }
  }

  async function importZip(file: File) {
    if (!activeProject) return;
    try {
      if (file.size > MAX_ZIP_ARCHIVE_BYTES) throw new Error('حجم ZIP المضغوط يتجاوز 24 ميغابايت؛ ارفض قبل الفك لحماية ذاكرة المتصفح.');
      const { default: JSZip } = await import('jszip');
      const zip = await JSZip.loadAsync(file);
      const allEntries = Object.values(zip.files);
      if (allEntries.length > 2500) throw new Error('يحتوي ZIP على عدد كبير جداً من الملفات والمجلدات.');
      let declaredArchiveBytes = 0;
      for (const entry of allEntries) {
        if (entry.dir) continue;
        const metadata = entry.name === PROJECT_ARCHIVE_META;
        const declared = (entry as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize;
        if (typeof declared === 'number' && Number.isFinite(declared)) {
          const fileLimit = metadata ? MAX_ZIP_METADATA_BYTES : 4 * 1024 * 1024;
          if (declared > fileLimit) throw new Error(`حجم الملف المضغوط ${entry.name.slice(0, 80)} يتجاوز الحد قبل فكّه.`);
          declaredArchiveBytes += declared;
        }
      }
      if (declaredArchiveBytes > 21 * 1024 * 1024) throw new Error('الحجم غير المضغوط المعلن داخل ZIP يتجاوز 21 ميغابايت قبل فك الملفات.');
      const metaEntry = zip.file(PROJECT_ARCHIVE_META);
      let metadata: ProjectArchiveMetadata | null = null;
      if (metaEntry) {
        const raw: unknown = JSON.parse(await metaEntry.async('string'));
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('ملف بيانات النسخة الاحتياطية غير صالح.');
        const candidate = raw as ProjectArchiveMetadata;
        const current = candidate.format === 'codexa-project' && candidate.version === 1;
        const legacy = !candidate.format && typeof candidate.name === 'string' && typeof candidate.entry === 'string' && 'android' in (raw as object);
        if (!current && !legacy) throw new Error('صيغة نسخة CODEXA غير مدعومة أو تالفة.');
        metadata = candidate;
      }
      const entries = Object.values(zip.files).filter((entry) => !entry.dir && entry.name !== PROJECT_ARCHIVE_META && !entry.name.endsWith('/.codexa-folder'));
      if (entries.length > 500) throw new Error('الحد الأقصى لاستيراد ZIP هو 500 ملفاً.');
      const fileMeta = new Map((metadata?.files ?? []).filter((item) => typeof item.path === 'string').map((item) => [normalizeProjectPath(item.path!), item]));
      const incoming: Record<string, CodeProject['files'][string]> = {};
      let totalBytes = 0;
      for (const entry of entries) {
        const path = normalizeProjectPath(entry.name);
        const invalid = validateProjectPath(entry.name);
        if (invalid || path === PROJECT_ARCHIVE_META || path.endsWith('/.codexa-folder')) throw new Error(`مسار ZIP غير صالح: ${entry.name.slice(0, 80)}.`);
        const collision = findFileConflict(path, Object.keys(incoming));
        if (collision) throw new Error(`مساران متعارضان داخل ZIP: «${path}» و«${collision}».`);
        const bytes = await entry.async('uint8array');
        if (bytes.byteLength > 4 * 1024 * 1024) throw new Error(`الملف ${path} أكبر من الحد المسموح (4 ميغابايت).`);
        const content = /^(?:png|jpe?g|gif|webp|avif|ico|woff2?|ttf|otf|mp[34]|wav|ogg|m4a|webm|mov)$/i.test(extensionOf(path))
          ? bytesToDataUrl(bytes, path) : new TextDecoder().decode(bytes);
        const contentBytes = new TextEncoder().encode(content).byteLength;
        if (contentBytes > 4 * 1024 * 1024) throw new Error(`الملف ${path} يتجاوز 4 ميغابايت بعد ترميزه.`);
        totalBytes += contentBytes;
        if (totalBytes > 20 * 1024 * 1024) throw new Error('الحجم الإجمالي للملفات بعد فك ZIP يتجاوز 20 ميغابايت.');
        const details = fileMeta.get(path);
        const languageOverride = typeof details?.languageOverride === 'string' && languageOptions.some((option) => option.id === details.languageOverride) ? details.languageOverride : null;
        incoming[path] = { path, content, languageOverride, updatedAt: Number.isFinite(details?.updatedAt) ? details!.updatedAt! : Date.now() };
      }
      if (!metadata && !Object.keys(incoming).length) throw new Error('لم يُعثر على ملفات صالحة في ZIP.');

      if (metadata) {
        const folders = [...new Set((metadata.folders ?? []).filter((folder): folder is string => typeof folder === 'string').map(normalizeProjectPath))];
        for (const folder of folders) {
          const marker = `${folder}/.codexa-folder`;
          if (validateProjectPath(marker, true)) throw new Error(`اسم مجلد غير صالح داخل النسخة: ${folder}.`);
          if (Object.hasOwn(incoming, folder) || Object.keys(incoming).some((path) => !path.endsWith('/.codexa-folder') && folder.startsWith(`${path}/`))) throw new Error(`يتعارض المجلد «${folder}» مع مسار ملف في النسخة.`);
          incoming[marker] = { path: marker, content: '', languageOverride: null, updatedAt: Date.now() };
        }
        const restored = createSampleProject();
        const name = typeof metadata.name === 'string' && metadata.name.trim() ? metadata.name.trim().slice(0, 80) : 'مشروع مستعاد';
        const requestedEntry = typeof metadata.entry === 'string' ? normalizeProjectPath(metadata.entry) : '';
        const entryPath = projectEntryPath({ files: incoming, entry: requestedEntry });
        const importedTime = Number.isFinite(metadata.createdAt) ? metadata.createdAt! : Date.now();
        const project: CodeProject = {
          ...restored, name, files: incoming, entry: entryPath,
          android: restoreAndroidIdentity(metadata.android, restored.id, name),
          createdAt: importedTime, updatedAt: Date.now(),
        };
        void saveProject(project);
        setProjects((current) => [project, ...current]);
        setActiveProjectId(project.id); setActivePath(entryPath); setOpenTabs([]); setPreviewScope('project'); setPreviewTick((tick) => tick + 1); setPanel('preview'); setDrawerOpen(false);
        setToast(`استُعيد مشروع «${name}» مستقلاً؛ فُتحت المعاينة عند ${entryPath || 'أول ملف'}.`);
        return;
      }

      const conflict = Object.keys(incoming).map((path) => ({ path, existing: findFileConflict(path, Object.keys(activeProject.files)) })).find((item) => item.existing);
      if (conflict?.existing) throw new Error(`لم يُستورد ZIP لأن «${conflict.path}» يتعارض مع الملف الموجود «${conflict.existing}». لم تُستبدل أي بيانات.`);
      const files = { ...activeProject.files, ...incoming };
      const entry = projectEntryPath({ files, entry: activeProject.entry });
      saveActiveProject((project) => ({ ...project, files, entry: entry || project.entry, updatedAt: Date.now() }));
      setActivePath(entry); setPreviewScope('project'); setPreviewTick((tick) => tick + 1); setPanel('preview'); setDrawerOpen(false);
      setToast(`استُورد ${Object.keys(incoming).length} ملفاً من ZIP؛ فُتحت معاينة ${entry || 'المشروع'}.`);
    } catch (error) { setToast(error instanceof Error ? error.message : 'تعذر فتح ملف ZIP؛ تحقق من سلامته.'); }
  }

  async function exportProject() {
    if (!activeProject) return;
    const { default: JSZip } = await import('jszip');
    const zip = new JSZip();
    for (const [path, file] of Object.entries(activeProject.files)) {
      if (path.endsWith('/.codexa-folder')) continue;
      if (file.content.startsWith('data:')) {
        const response = await fetch(file.content);
        zip.file(path, await response.arrayBuffer());
      } else zip.file(path, file.content);
    }
    zip.file(PROJECT_ARCHIVE_META, JSON.stringify({ format: 'codexa-project', version: 1, name: activeProject.name, entry: activeProject.entry, android: activeProject.android, createdAt: activeProject.createdAt, updatedAt: activeProject.updatedAt, files: Object.values(activeProject.files).filter((file) => !file.path.endsWith('/.codexa-folder')).map(({ path, languageOverride, updatedAt }) => ({ path, languageOverride: languageOverride ?? null, updatedAt })), folders: Object.keys(activeProject.files).filter((path) => path.endsWith('/.codexa-folder')).map((path) => path.slice(0, -'/.codexa-folder'.length)) }, null, 2));
    const blob = await zip.generateAsync({ type: 'blob' });
    downloadBlob(blob, `${safeFilename(activeProject.name)}.zip`);
    setToast('تم تنزيل نسخة ZIP احتياطية من المشروع.');
  }

  function downloadCurrentFile() {
    if (!activeFile) return;
    const blob = activeFile.content.startsWith('data:') ? undefined : new Blob([activeFile.content], { type: 'text/plain;charset=utf-8' });
    if (blob) downloadBlob(blob, localFileName(activeFile.path));
    else {
      const anchor = document.createElement('a'); anchor.href = activeFile.content; anchor.download = localFileName(activeFile.path); anchor.click();
    }
  }

  function replaceWorkspaceState(next: Pick<WorkspaceHistory, 'panel' | 'drawerOpen'>) {
    const snapshot: WorkspaceHistory = { ...next, dialog: null };
    window.history.replaceState({ ...window.history.state, codexaWorkspace: snapshot }, '', window.location.href);
    workspaceHistoryRef.current = snapshot;
    setPanel(snapshot.panel); setDrawerOpen(snapshot.drawerOpen); setDialog(null);
  }

  function pushWorkspaceState(next: Pick<WorkspaceHistory, 'panel' | 'drawerOpen'>) {
    const snapshot: WorkspaceHistory = { ...next, dialog: null };
    window.history.pushState({ ...window.history.state, codexaWorkspace: snapshot }, '', window.location.href);
    workspaceHistoryRef.current = snapshot;
    setPanel(snapshot.panel); setDrawerOpen(snapshot.drawerOpen); setDialog(null);
  }

  async function runPreview() {
    const current = workspaceHistoryRef.current;
    if (current.drawerOpen) replaceWorkspaceState({ panel: 'preview', drawerOpen: false });
    else if (current.panel !== 'preview') pushWorkspaceState({ panel: 'preview', drawerOpen: false });
    setPreviewScope('project');
    setPreviewTick((tick) => tick + 1);
    setToast(projectPreviewPath ? `تُعرض معاينة مدخل المشروع تلقائياً: ${projectPreviewPath}.` : 'لا توجد ملفات قابلة للمعاينة في المشروع بعد.');
  }

  function openFullPreview() {
    if (!preview) return;
    const url = URL.createObjectURL(new Blob([preview.html], { type: 'text/html;charset=utf-8' }));
    window.open(url, '_blank', 'noopener,noreferrer');
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }

  async function togglePreviewFullscreen() {
    const stage = document.querySelector('.preview-panel') as HTMLElement | null;
    if (!stage) return;
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await stage.requestFullscreen();
    } catch { setPanel('preview'); }
  }

  const searchResults = useMemo(() => {
    if (!activeProject || !searchTerm.trim()) return [];
    const term = searchTerm.toLowerCase();
    const results: Array<{ path: string; line: number; text: string }> = [];
    for (const file of Object.values(activeProject.files)) {
      if (file.content.startsWith('data:')) continue;
      file.content.split('\n').forEach((text, index) => {
        if (text.toLowerCase().includes(term)) results.push({ path: file.path, line: index + 1, text: text.trim().slice(0, 180) });
      });
    }
    return results.slice(0, 120);
  }, [activeProject, searchTerm]);

  function replaceActiveMatch() {
    if (!activeFile || !query) return;
    const index = activeFile.content.indexOf(query);
    if (index < 0) { setToast('لم يُعثر على النص في الملف النشط.'); return; }
    const next = activeFile.content.slice(0, index) + replaceText + activeFile.content.slice(index + query.length);
    updateFileContent(next); setToast('تم استبدال أول تطابق في الملف النشط.');
  }

  async function copyPreviewSource() {
    const source = preview?.source ?? previewFile?.content;
    if (source === undefined) return;
    try {
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(source);
      else {
        const field = document.createElement('textarea');
        field.value = source; field.setAttribute('readonly', '');
        field.style.position = 'fixed'; field.style.opacity = '0';
        document.body.append(field); field.select();
        const copied = document.execCommand('copy'); field.remove();
        if (!copied) throw new Error('تعذر الوصول إلى الحافظة.');
      }
      setToast('نُسخت الشيفرة كاملة إلى الحافظة.');
    } catch { setToast('تعذر النسخ تلقائياً؛ حدد الشيفرة من المحرر وانسخها.'); }
  }

  async function trackBuildJob(track: ApkBuildTrack, jobId: string, appName: string, projectId: string, entry: string, identity: AndroidIdentity, packageId: string) {
    const statusUrl = `/api/build/${track === 'native' ? 'native-apk' : 'apk'}/${jobId}`;
    const deadline = Date.now() + 10 * 60_000;
    let missingResponses = 0;
    let transientFailures = 0;
    let firstPoll = true;
    while (Date.now() < deadline) {
      if (!firstPoll) await new Promise((resolve) => window.setTimeout(resolve, track === 'webview' ? 120 : 220));
      firstPoll = false;
      let statusResponse: Response;
      try { statusResponse = await fetch(statusUrl, { cache: 'no-store' }); }
      catch (error) {
        if (++transientFailures < 5) continue;
        throw new Error(`انقطع الاتصال بمهمة البناء: ${error instanceof Error ? error.message : 'خطأ شبكة'}`);
      }
      if (statusResponse.status === 404 && ++missingResponses <= 8) continue;
      if (!statusResponse.ok) throw new Error(`تعذر قراءة حالة البناء (${statusResponse.status}). احتُفظ بمعرف المهمة مؤقتاً لاستئناف المحاولة.`);
      missingResponses = 0; transientFailures = 0;
      const status = await statusResponse.json() as { status?: string; progress?: number; stage?: string; logs?: string; error?: string };
      const percent = Number(status.progress);
      if (Number.isFinite(percent)) setBuildProgress(Math.max(0, Math.min(100, Math.round(percent))));
      setBuildMessage(status.stage || status.logs?.trim().split('\n').at(-1) || 'يجري بناء APK فعلياً…');
      if (status.status === 'failed') {
        const tail = status.logs?.trim().split('\n').slice(-4).join('\n');
        throw new Error([status.error || 'فشل البناء؛ لم يبدأ تنزيل APK.', tail].filter(Boolean).join('\n'));
      }
      if (status.status !== 'completed') continue;
      const result = await fetch(`${statusUrl}/result`, { cache: 'no-store' });
      if (result.status === 404 && ++missingResponses <= 8) continue;
      if (!result.ok) throw new Error(`تعذر تنزيل نتيجة المهمة (${result.status})؛ بقيت المهمة محفوظة مؤقتاً.`);
      const expectedTrack = track === 'native' ? 'native-gradle' : 'webview';
      const resultPackageId = result.headers.get('x-codexa-package-id');
      if (!result.headers.get('content-type')?.toLowerCase().includes('application/vnd.android.package-archive') || result.headers.get('x-codexa-apk-signature') !== 'debug-verified' || result.headers.get('x-codexa-build-track') !== expectedTrack || resultPackageId !== packageId) throw new Error('لم يطابق APK نوع الحزمة أو معرّف التطبيق أو التوقيع المتوقع؛ لم يُفعّل التنزيل.');
      const blob = await result.blob();
      if (blob.size < 4096) throw new Error('حجم APK غير صالح؛ لم يبدأ التنزيل.');
      const contentLength = Number(result.headers.get('content-length') || blob.size);
      if (contentLength !== blob.size) throw new Error('حجم APK المستلم لا يطابق الحجم الذي أعلنه الخادم.');
      const filename = `${safeFilename(appName)}.apk`;
      setBuildArtifact({ blob, filename, track, projectId, appName, packageId, entry, bytes: blob.size });
      setBuildAudit(`${track === 'native' ? 'Gradle Android أصلي' : 'WebView سريع'} · ${packageId} · ${(blob.size / 1024).toFixed(1)} كيلوبايت · التوقيع والحزمة متحققان · ${track === 'webview' ? entry : 'مصادر Native'}`);
      const update = (project: CodeProject): CodeProject => ({ ...project, ...(track === 'webview' ? { entry } : {}), android: identity, updatedAt: Date.now() });
      if (activeProjectId === projectId) saveActiveProject(update);
      else setProjects((current) => current.map((project) => {
        if (project.id !== projectId) return project;
        const next = update(project); void saveProject(next); return next;
      }));
      setBuildProgress(100);
      setBuildMessage('نجح البناء واكتمل فحص APK والتوقيع ومعرّف الحزمة. راجع النتيجة ثم نزّلها.');
      setToast('اجتاز APK فحوص ما قبل التنزيل؛ الملف لم يُنزّل بعد.');
      return;
    }
    throw new Error('انتهت مهلة انتظار مهمة البناء؛ لم يبدأ تنزيل أي ملف، وما زال سجل المهمة محفوظاً مؤقتاً.');
  }

  function downloadVerifiedApk() {
    if (!buildArtifact) return;
    downloadBlob(buildArtifact.blob, buildArtifact.filename);
    try { window.sessionStorage.removeItem(BUILD_SESSION_KEY); } catch { /* browser storage may be disabled */ }
    setBuildMessage('تم بدء تنزيل APK الذي اجتاز فحوص النوع والحزمة والتوقيع.');
    setBuildArtifact(null); setBuildAudit('');
    setToast(`بدأ تنزيل ${buildArtifact.filename}.`);
  }

  async function buildApk() {
    if (!activeProject || !identityDraft || !buildConsent) { setBuildMessage('احفظ هوية التطبيق ووافق على إرسال ملفات هذا المشروع أولاً.'); return; }
    const track = buildTrack;
    const name = identityDraft.appName.trim();
    if (!name) { setBuildMessage('أدخل اسم التطبيق الذي سيظهر على الهاتف.'); return; }
    if (!/^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*){1,6}$/.test(identityDraft.packageId)) { setBuildMessage('معرّف حزمة Android غير صالح.'); return; }
    if (track === 'native' && !nativeFileCount) { setBuildMessage('أضف ملف Kotlin (.kt) أو Java (.java) واحداً على الأقل لمسار Gradle.'); return; }
    if (track === 'webview' && (!apkEntry || !activeProject.files[apkEntry] || !/\.(?:html?|xhtml)$/i.test(apkEntry))) { setBuildMessage('اختر ملف HTML صالحاً ليكون صفحة البداية.'); return; }
    setBuildArtifact(null); setBuildAudit('');
    try { window.sessionStorage.removeItem(BUILD_SESSION_KEY); } catch { /* browser storage may be disabled */ }
    setBuildRunning(true); setBuildProgress(0); setBuildMessage(track === 'native' ? 'تهيئة مشروع Android الأصلي…' : 'تهيئة بناء WebView السريع…');
    try {
      const { createIconPngPair } = await import('./android/create-icon-png');
      const { iconPng, iconPng192 } = await createIconPngPair(identityDraft);
      const endpoint = track === 'native' ? '/api/build/native-apk' : '/api/build/apk';
      const response = await fetch(endpoint, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ consent: buildConsent === true, allowExternalNetwork: identityDraft.allowExternalNetwork === true, projectId: activeProject.id, appName: name, packageId: identityDraft.packageId, iconPng, iconPng192, ...(track === 'webview' ? { entry: apkEntry } : {}), files: Object.values(activeProject.files).filter((file) => !file.path.endsWith('/.codexa-folder')).map(({ path, content }) => ({ path, content })) }),
      });
      if (!response.ok) {
        let detail = `خدمة البناء أعادت الرمز ${response.status}.`;
        try { const payload = await response.json() as { error?: string; message?: string }; detail = payload.message || payload.error || detail; } catch { /* keep generic HTTP status */ }
        throw new Error(detail);
      }
      const started = await response.json() as { jobId?: string };
      if (!started.jobId || !/^[\da-f-]{36}$/i.test(started.jobId)) throw new Error('استجابة بدء مهمة البناء غير صالحة.');
      const pending: PendingBuild = { jobId: started.jobId, track, projectId: activeProject.id, appName: name, entry: apkEntry, packageId: identityDraft.packageId };
      try { window.sessionStorage.setItem(BUILD_SESSION_KEY, JSON.stringify(pending)); } catch { /* keep the in-memory task usable if storage is disabled */ }
      resumedBuildRef.current = started.jobId;
      await trackBuildJob(track, started.jobId, name, activeProject.id, apkEntry, identityDraft, identityDraft.packageId);
    } catch (error) {
      setBuildMessage(error instanceof Error ? error.message : 'تعذر بناء APK.');
    } finally { setBuildRunning(false); }
  }

  function openApkDialog() {
    if (!activeProject) return;
    const identity = activeProject.android ?? newAndroidIdentity(activeProject.id || crypto.randomUUID(), 'تطبيقي');
    setIdentityDraft({ ...identity, allowExternalNetwork: identity.allowExternalNetwork ?? false });
    const sameProjectArtifact = buildArtifact?.projectId === activeProject.id ? buildArtifact : null;
    const defaultEntry = htmlEntries.includes(activeProject.entry) ? activeProject.entry : htmlEntries.find((path) => /(?:^|\/)index\.html?$/i.test(path)) ?? htmlEntries[0] ?? '';
    setBuildTrack(sameProjectArtifact?.track ?? (htmlEntries.length ? 'webview' : nativeFileCount ? 'native' : 'webview'));
    setApkEntry(sameProjectArtifact?.entry ?? defaultEntry);
    setBuildConsent(false);
    if (!sameProjectArtifact) { setBuildArtifact(null); setBuildAudit(''); setBuildProgress(0); setBuildMessage(''); }
    setDialog('apk');
  }

  function previewBuildFile(path: string, label: string) {
    if (!path) return;
    setActivePath(path); setPreviewScope('file'); setPreviewTick((tick) => tick + 1);
    replaceWorkspaceState({ panel: 'preview', drawerOpen: false });
    setToast(label);
  }

  function changeTheme() {
    const next = theme === 'dark' ? 'light' : 'dark';
    setTheme(next); void saveTheme(next);
  }

  function selectProject(project: CodeProject) {
    setActiveProjectId(project.id);
    setActivePath(projectEntryPath(project));
    setPreviewScope('project');
    setOpenTabs([]);
    setPanel('editor'); setDrawerOpen(false);
  }

  function updateIdentity(value: AndroidIdentity) {
    setIdentityDraft(value);
    saveActiveProject((project) => ({ ...project, android: value, updatedAt: Date.now() }));
  }

  function closeFileDrawer() {
    const current = workspaceHistoryRef.current;
    replaceWorkspaceState({ panel: current.panel === 'files' ? 'editor' : current.panel, drawerOpen: false });
  }

  const chooseNewFile = (parent = '') => { setFileParent(parent); setTemplateId('html'); setFileBaseName('page'); replaceWorkspaceState({ panel: 'editor', drawerOpen: false }); setDialog('new-file'); };
  const visiblePreview = preview ?? { html: '<!doctype html><html><body><p>اختر ملفاً لمعاينته.</p></body></html>', title: 'معاينة', diagnostics: [] };
  const isSourcePreview = preview?.kind === 'source';
  const sourcePreviewText = preview?.source ?? previewFile?.content ?? '';
  const sourcePreviewLanguage = preview?.language ?? (previewFile ? detectLanguage(previewFile.path, previewFile.languageOverride) : 'text');

  if (!loaded) return <div className="loading-screen"><div className="brand-mark">{ }</div><b>CODEXA</b><span>تجهيز مساحة العمل…</span></div>;

  return <div className="app-root" data-theme={theme}>
    <header className="topbar">
      <div className="brand-group">
        <button className="mobile-menu icon-button" onClick={() => pushWorkspaceState({ panel, drawerOpen: true })} aria-label="فتح قائمة المشروع"><Menu size={19} /></button>
        <a className="brand" href="#workspace" aria-label="CODEXA"><span className="brand-mark">{'{ }'}</span><span>CODEXA</span></a>
        <span className="brand-divider" />
        <button className="project-switcher" onClick={() => pushWorkspaceState({ panel, drawerOpen: true })}><span className="project-dot" /><span>{activeProject?.name ?? 'مشروع'}</span><ChevronDown size={14} /></button>
      </div>
      <div className="top-actions">
        <button className="icon-button" onClick={() => setDialog('search')} title="البحث في المشروع"><Search size={18} /></button>
        <button className="icon-button theme-toggle" onClick={changeTheme} title={theme === 'dark' ? 'الوضع الفاتح' : 'الوضع الداكن'}>{theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}</button>
        <span className="action-divider" />
        <button className="secondary-button export-button" onClick={() => void exportProject()}><Download size={16} /><span>تصدير ZIP</span></button>
        <button className="apk-button" onClick={openApkDialog}><Smartphone size={16} /><span>APK</span></button>
      </div>
    </header>

    <div className="mobile-tabs" role="tablist" aria-label="مساحة العمل">
      <button className={panel === 'files' ? 'active' : ''} onClick={() => pushWorkspaceState({ panel: 'files', drawerOpen: true })}><FolderOpen size={16} />الملفات</button>
      <button className={panel === 'editor' ? 'active' : ''} onClick={() => replaceWorkspaceState({ panel: 'editor', drawerOpen: false })}><Code2 size={16} />المحرر</button>
      <button className={panel === 'preview' ? 'active' : ''} onClick={() => void runPreview()}><Eye size={16} />المعاينة</button>
    </div>

    <main className={`workbench ${panel === 'files' ? 'mobile-files' : panel === 'preview' ? 'mobile-preview' : 'mobile-editor'}`} id="workspace">
      <aside className={`project-sidebar ${drawerOpen ? 'drawer-open' : ''}`} aria-label="مستكشف الملفات">
        <div className="drawer-mobile-head"><div><span className="eyebrow">المساحة الحالية</span><b>{activeProject?.name}</b></div><button className="icon-button" onClick={closeFileDrawer} aria-label="إغلاق القائمة"><X size={18} /></button></div>
        <div className="sidebar-projects">
          <div className="sidebar-title"><span>المشاريع</span><button className="tiny-icon" onClick={() => { setProjectName(''); setDialog('new-project'); }} title="مشروع جديد"><Plus size={16} /></button></div>
          <div className="project-list">
            {projects.map((project) => <div className={`project-list-row ${project.id === activeProjectId ? 'selected' : ''}`} key={project.id}>
              <button onClick={() => selectProject(project)}><span className="mini-project-mark">{project.name.slice(0, 1).toUpperCase()}</span><span className="project-list-copy"><b>{project.name}</b><small>{Object.keys(project.files).filter((path) => !path.endsWith('/.codexa-folder')).length} ملفات</small></span></button>
              {project.id === activeProjectId && <><button className="tiny-icon project-delete" title="إعادة تسمية المشروع" onClick={() => renameProject(project)}><Pencil size={14} /></button><button className="tiny-icon project-delete" title="حذف المشروع" onClick={() => deleteProject(project)}><Trash2 size={14} /></button></>}
            </div>)}
          </div>
        </div>
        {activeProject && <FileTree project={activeProject} activePath={activePath} filter={fileFilter} onFilterChange={setFileFilter} onSelect={(path) => { setActivePath(path); replaceWorkspaceState({ panel: 'editor', drawerOpen: false }); }} onRename={startRename} onCopy={duplicateFile} onDelete={deleteFile} onDeleteFolder={deleteFolder} onRenameFolder={renameFolder} onNewFile={chooseNewFile} onNewFolder={(parent = '') => { setFolderParent(parent); replaceWorkspaceState({ panel: 'editor', drawerOpen: false }); setDialog('new-folder'); }} onImport={() => openFilePicker(importInputId)} onImportFolder={openFolderPicker} onImportZip={() => openFilePicker('codexa-zip-import')} onPreviewProject={() => { setActivePath(projectPreviewPath); setPreviewScope('project'); setPreviewTick((tick) => tick + 1); replaceWorkspaceState({ panel: 'preview', drawerOpen: false }); }} />}
        <div className="sidebar-bottom"><span className="local-badge"><ShieldCheck size={14} />ملفاتك على هذا الجهاز</span><span className="local-caption">الحفظ التلقائي · IndexedDB</span></div>
      </aside>

      {drawerOpen && <button className="drawer-scrim" aria-label="إغلاق القائمة" onClick={closeFileDrawer} />}

      <section className={`editor-panel ${panel === 'editor' ? 'panel-visible' : ''}`} aria-label="المحرر">
        <div className="editor-toolbar">
          <div className="file-tabs" role="tablist" aria-label="الملفات المفتوحة">
            {openTabs.map((tabPath) => {
              const file = activeProject?.files[tabPath];
              if (!file) return null;
              const tabLanguage = detectLanguage(tabPath, file.languageOverride);
              return <div className={`file-tab ${activePath === tabPath ? 'active' : ''}`} role="tab" aria-selected={activePath === tabPath} key={tabPath}><button className="tab-select" onClick={() => setActivePath(tabPath)} title={tabPath}><ProjectFileIcon path={tabPath} language={tabLanguage} /><span>{localFileName(tabPath)}</span></button><button className="tab-close" onClick={() => closeFileTab(tabPath)} aria-label={`إغلاق ${localFileName(tabPath)}`}><X size={13} /></button></div>;
            })}
            {!openTabs.length && <span className="subtle-note">اختر ملفاً للبدء</span>}
            <button className="add-tab" onClick={() => chooseNewFile()} title="ملف جديد"><Plus size={17} /></button>
          </div>
          <div className="editor-actions">
            <button className="icon-button" onClick={() => setDialog('search')} title="بحث واستبدال"><Search size={16} /></button>
            <button className="icon-button" onClick={downloadCurrentFile} disabled={!activeFile} title="تنزيل الملف"><ArrowDownToLine size={16} /></button>
            <button className="icon-button" onClick={() => activePath && duplicateFile(activePath)} disabled={!activeFile} title="نسخ الملف"><Copy size={15} /></button>
            <button className="icon-button danger-hover" onClick={() => activePath && deleteFile(activePath)} disabled={!activeFile} title="حذف الملف"><Trash2 size={15} /></button>
          </div>
        </div>
        {activeFile && <div className="editor-runtime-row"><RuntimeBadge path={activePath} /></div>}
        {activeFile ? <>
          <div className="editor-area"><Suspense fallback={<div className="preview-placeholder">تحميل أدوات التحرير…</div>}><CodeEditor key={`${activeProjectId}:${activePath}`} path={activePath} value={activeFile.content} language={language} theme={theme} onChange={updateFileContent} /></Suspense></div>
          <div className="editor-status"><span className="status-left"><span className="status-led" /> محفوظ محلياً</span><span className="line-info">{activeFile.content.split('\n').length} أسطر <span>·</span> {activeFile.content.length} حرف</span><label className="language-select-label"><span>اللغة</span><select value={activeFile.languageOverride ?? 'auto'} onChange={(event) => saveActiveProject((project) => ({ ...project, files: { ...project.files, [activePath]: { ...project.files[activePath], languageOverride: event.target.value === 'auto' ? null : event.target.value, updatedAt: Date.now() } } }))}><option value="auto">تلقائي · {languageLabel(detectLanguage(activePath))}</option>{[...new Set(languageOptions.map((option) => option.category))].map((category) => <optgroup label={category} key={category}>{languageOptions.filter((option) => option.category === category).map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}</optgroup>)}</select></label></div>
        </> : <div className="editor-empty"><div className="empty-symbol">{'{ }'}</div><h2>مساحة كتابة هادئة.</h2><p>اختر ملفاً من مشروعك أو ابدأ ملفاً جديداً من قالب جاهز.</p><button className="primary-button" onClick={() => chooseNewFile()}><FilePlus2 size={16} /> إنشاء ملف</button></div>}
      </section>

      <section className={`preview-panel ${panel === 'preview' ? 'panel-visible' : ''}`} aria-label="معاينة المشروع">
        <div className="preview-toolbar">
          <div className="preview-title"><span className={`preview-led ${previewLoading ? 'loading' : ''}`} /> <span>{preview?.title || activePath || 'معاينة مباشرة'}</span><span className="preview-live">مباشرة</span></div>
          <div className="preview-actions">
            {!isSourcePreview && deviceMode !== 'live' && <select className="device-select" value={deviceMode} onChange={(event) => setDeviceMode(event.target.value as typeof deviceMode)}><option value="phone">هاتف</option><option value="tablet">لوحي</option><option value="desktop">سطح المكتب</option></select>}
            {!isSourcePreview && <button className="icon-button device-toggle" onClick={() => setDeviceMode((mode) => mode === 'live' ? 'phone' : 'live')} title="تبديل محاكاة الجهاز"><Smartphone size={16} /></button>}
            <button className="icon-button" onClick={() => setPreviewTick((tick) => tick + 1)} title="تحديث المعاينة"><RefreshCw size={15} /></button>
            {!isSourcePreview && <button className="icon-button" onClick={openFullPreview} title="فتح المعاينة في تبويب مستقل"><ArrowUpRight size={16} /></button>}
            {!isSourcePreview && <button className="icon-button desktop-expand" onClick={() => void togglePreviewFullscreen()} title="ملء الشاشة"><Maximize2 size={15} /></button>}
          </div>
        </div>
        <div className="preview-scope-control">
          <div className="preview-scope-switch" role="group" aria-label="نطاق المعاينة">
            <button type="button" aria-pressed={previewScope === 'project'} disabled={!projectPreviewPath} className={previewScope === 'project' && projectPreviewPath ? 'active' : ''} onClick={() => { if (projectPreviewPath) setActivePath(projectPreviewPath); setPreviewScope('project'); setPreviewTick((tick) => tick + 1); }}><Globe2 size={13} /> المشروع الكامل</button>
            <button type="button" aria-pressed={previewScope === 'file'} className={previewScope === 'file' ? 'active' : ''} onClick={() => { setPreviewScope('file'); setPreviewTick((tick) => tick + 1); }}><FileCode2 size={13} /> الملف الحالي</button>
          </div>
          <div className="preview-scope-label" aria-live="polite">
            {previewScope === 'project' && projectPreviewPath && /\.(?:html?|xhtml)$/i.test(projectPreviewPath) ? `معاينة المشروع الكامل · ${projectPreviewPath}` : previewScope === 'project' && nativeXmlPreviewPath && previewPath === nativeXmlPreviewPath ? `معاينة Android XML تقريبية · ${nativeXmlPreviewPath}` : previewScope === 'project' && projectPreviewPath ? `مدخل المشروع الحالي · ${projectPreviewPath} · معاينة جزئية` : previewScope === 'project' ? 'لا توجد نقطة بداية؛ استورد ملفات أو أنشئ ملفاً أولاً' : `معاينة تجزيئية للملف: ${previewPath || 'لا يوجد ملف'}`}
            {previewScope === 'file' && projectPreviewPath && <button type="button" onClick={() => { setActivePath(projectPreviewPath); setPreviewScope('project'); setPreviewTick((tick) => tick + 1); }}>عرض المشروع الكامل</button>}
          </div>
        </div>
        {previewFile && <div className="preview-runtime-row"><RuntimeBadge path={previewPath} /></div>}
        {!isSourcePreview && <div className={`network-consent ${allowExternalPreview ? 'network-approved' : ''}`} role="status">
          <div><ShieldCheck size={14} /><span>{allowExternalPreview ? 'الوصول الخارجي HTTPS/WSS مفعّل لهذا المشروع.' : externalResources.length ? 'المصادر الخارجية محجوبة حتى تسمح بها؛ المعاينة المحلية تبقى متاحة.' : 'المعاينة محلية افتراضياً؛ اتصالات HTTPS/WSS محجوبة إلى أن تسمح بها.'}</span></div>
          {externalResources.length > 0 && <details className="network-domain-details"><summary>{externalResources.length} نطاقات</summary><div>{externalResources.map((resource) => <code key={resource}>{resource}</code>)}</div></details>}
          <button type="button" className={allowExternalPreview ? 'secondary-button' : 'network-allow-button'} onClick={() => setPreviewConsentFor(allowExternalPreview ? '' : previewConsentKey)}>{allowExternalPreview ? 'إيقاف الشبكة' : 'السماح باتصال خارجي'}</button>
        </div>}
        <div className={`preview-stage device-${deviceMode}`}>
          {isSourcePreview && previewFile ? <section className="source-inspector" aria-label={`فحص مصدر ${previewPath}`}><header className="source-inspector-head"><div><span className="source-inspector-badge">SOURCE</span><b>{previewPath}</b><small>{languageLabel(sourcePreviewLanguage)} · {sourcePreviewText.split('\n').length} سطر · قراءة فقط</small></div><button className="secondary-button source-copy" onClick={() => void copyPreviewSource()}><Copy size={15} /><span>نسخ الشيفرة</span></button></header><div className="source-inspector-editor"><Suspense fallback={<div className="code-loading">تحميل تلوين اللغة…</div>}><CodeEditor path={previewPath} value={sourcePreviewText} language={sourcePreviewLanguage} theme={theme} onChange={() => undefined} readOnly /></Suspense></div><div className="source-inspector-note"><ShieldCheck size={14} /><span>هذا الملف معروض كمصدر؛ لا ينفّذه المتصفح تلقائياً.</span></div></section> : previewFile ? <iframe key={`${activeProjectId}:${previewPath}:${previewTick}:${allowExternalPreview}`} title={`معاينة ${previewPath}`} srcDoc={visiblePreview.html} sandbox={iframeSandbox} referrerPolicy="no-referrer" /> : <div className="preview-placeholder"><span className="preview-placeholder-icon"><Eye size={28} /></span><b>المعاينة بانتظار ملف</b><span>اختر صفحة أو نوع ملف لعرض معاينته المناسبة.</span><button className="secondary-button" onClick={() => pushWorkspaceState({ panel: 'files', drawerOpen: true })}>اختيار ملف</button></div>}
        </div>
        {preview?.diagnostics.length ? <details className="preview-diagnostics"><summary><AlertTriangle size={14} /> {preview.diagnostics.length} ملاحظة في المعاينة <ChevronDown size={14} /></summary><ul>{preview.diagnostics.map((item, index) => <li key={`${item}-${index}`}>{item}</li>)}</ul></details> : <div className="preview-footer"><span><ShieldCheck size={13} />{isSourcePreview ? 'مصدر للقراءة فقط' : 'معاينة معزولة'}</span><span>{isSourcePreview ? 'لم يتم تشغيل الملف' : allowExternalPreview ? 'الشبكة الخارجية مفعّلة' : 'الشبكة الخارجية محجوبة افتراضياً'}</span></div>}
      </section>
    </main>

    <footer className="bottom-bar"><div className="bottom-status"><span className="status-led" />{activeProject ? `مشروع ${activeProject.name}` : 'المساحة جاهزة'}<span className="bottom-separator">·</span><span>{filesCount} ملفات</span></div><div className="bottom-actions"><button onClick={() => pushWorkspaceState({ panel: 'files', drawerOpen: true })}><FolderOpen size={14} /> مستكشف</button><span /><button onClick={() => void runPreview()}><Play size={13} /> تشغيل المعاينة</button></div></footer>

    <input id={importInputId} className="sr-only" type="file" multiple onChange={(event) => { const input = event.currentTarget; void importFiles(input.files); input.value = ''; }} />
    <input ref={directoryInputRef} id="codexa-folder-import" className="sr-only" type="file" multiple onChange={(event) => { const input = event.currentTarget; void importFiles(input.files); input.value = ''; }} />
    <input id="codexa-zip-import" className="sr-only" type="file" accept=".zip,application/zip" onChange={(event) => { const input = event.currentTarget; if (input.files?.[0]) void importZip(input.files[0]); input.value = ''; }} />

    {dialog === 'new-file' && <ModalFrame title="ملف من قالب جاهز" subtitle={fileParent ? `ملف داخل ${fileParent}` : 'إنشاء ملف'} onClose={() => setDialog(null)} className="file-dialog">
      <form onSubmit={createFile}>
        <div className="template-groups">
          {[...new Set(fileTemplates.map((item) => item.category))].map((category) => <div key={category} className="template-group"><h3>{category}</h3><div className="template-grid">{fileTemplates.filter((item) => item.category === category).map((item) => {
            const Icon = iconForType[item.language] ?? FileCode2;
            return <button type="button" className={`template-card ${templateId === item.id ? 'selected' : ''}`} key={item.id} onClick={() => { setTemplateId(item.id); setFileBaseName(item.id === 'html' ? 'page' : item.id === 'css' ? 'style' : item.id === 'javascript' ? 'script' : item.id); }}><Icon size={18} /><span><b>{item.label}</b><small>{item.extension}</small></span>{templateId === item.id && <Check size={14} />}</button>;
          })}</div></div>)}
        </div>
        <label className="field-label">اسم الملف <span className="subtle-note">الامتداد محمي تلقائياً</span><div className="filename-control"><input className="text-input" value={fileBaseName} onChange={(event) => setFileBaseName(event.target.value)} autoFocus /><span className="extension-chip">{template.extension}</span></div></label>
        <div className="template-preview"><div><span className="eyebrow">سيُنشأ</span><b>{fileParent ? `${fileParent}/` : ''}{safeFilename(fileBaseName) || 'اسم'}{template.extension}</b></div><span className="language-pill">{['php', 'protobuf', 'dart', 'nginx', 'http'].includes(template.language) ? `${template.language.toUpperCase()} · نص` : template.language.toUpperCase()}</span></div>
        <footer className="dialog-foot"><button type="button" className="secondary-button" onClick={() => setDialog(null)}>إلغاء</button><button className="primary-button" type="submit"><Plus size={16} /> إنشاء الملف</button></footer>
      </form>
    </ModalFrame>}

    {dialog === 'new-project' && <ModalFrame title="مساحة جديدة لفكرتك" subtitle="مشروع جديد" onClose={() => setDialog(null)} className="small-dialog"><form onSubmit={createProject}><label className="field-label">اسم المشروع<input className="text-input" value={projectName} onChange={(event) => setProjectName(event.target.value)} placeholder="مثال: موقعي الجديد" autoFocus /></label><p className="form-hint"><ShieldCheck size={15} /> سيُحفظ المشروع محلياً في هذا المتصفح.</p><footer className="dialog-foot"><button type="button" className="secondary-button" onClick={() => setDialog(null)}>إلغاء</button><button type="submit" className="primary-button">إنشاء المشروع</button></footer></form></ModalFrame>}

    {dialog === 'new-folder' && <ModalFrame title="تنظيم الملفات" subtitle={folderParent ? `مجلد فرعي داخل ${folderParent}` : 'مجلد جديد'} onClose={() => setDialog(null)} className="small-dialog"><form onSubmit={createFolder}><label className="field-label">اسم المجلد<input className="text-input" value={folderName} onChange={(event) => setFolderName(event.target.value)} autoFocus /></label><p className="form-hint">{folderParent ? `سيُنشأ المجلد داخل ${folderParent}.` : 'يمكنك إضافة الملفات إلى مجلدات المشروع باستيرادها مع مساراتها النسبية.'}</p><footer className="dialog-foot"><button type="button" className="secondary-button" onClick={() => setDialog(null)}>إلغاء</button><button type="submit" className="primary-button"><FolderPlus size={15} /> إنشاء المجلد</button></footer></form></ModalFrame>}

    {dialog === 'rename' && <ModalFrame title="إعادة تسمية الملف" subtitle="تعديل الاسم" onClose={() => setDialog(null)} className="small-dialog"><form onSubmit={confirmRename}><label className="field-label">الاسم الجديد<input className="text-input" value={renameName} onChange={(event) => setRenameName(event.target.value)} autoFocus /></label><p className="form-hint">الامتداد <b>.{extensionOf(renamePath) || 'نص'}</b> محفوظ تلقائياً.</p><footer className="dialog-foot"><button type="button" className="secondary-button" onClick={() => setDialog(null)}>إلغاء</button><button type="submit" className="primary-button">حفظ الاسم</button></footer></form></ModalFrame>}

    {dialog === 'search' && <ModalFrame title="اعثر على أي سطر" subtitle="بحث في المشروع" onClose={() => setDialog(null)} className="search-dialog"><div className="search-modal-body"><label className="search-field wide-search"><Search size={17} /><input value={searchTerm} onChange={(event) => setSearchTerm(event.target.value)} placeholder="ابحث في جميع الملفات…" autoFocus /></label><div className="replace-row"><input className="text-input" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="النص في الملف النشط" /><ArrowLeft size={15} /><input className="text-input" value={replaceText} onChange={(event) => setReplaceText(event.target.value)} placeholder="استبدال بـ" /><button className="secondary-button" onClick={replaceActiveMatch}>استبدل التالي</button></div><div className="search-results"><div className="results-count">{searchResults.length}{searchResults.length === 120 ? '+' : ''} نتيجة</div>{searchResults.map((result, index) => <button className="search-result" key={`${result.path}:${result.line}:${index}`} onClick={() => { setActivePath(result.path); setPanel('editor'); setDialog(null); }}><FileCode2 size={15} /><span className="result-file">{result.path}<small>سطر {result.line}</small></span><code>{result.text}</code></button>)}{searchTerm && !searchResults.length && <div className="empty-search">لم نجد تطابقاً لهذا البحث.</div>}</div></div></ModalFrame>}

    {dialog === 'apk' && activeProject && identityDraft && <ModalFrame title="هوية تطبيق Android" subtitle="اختبار ثم تنزيل APK" onClose={() => { if (!buildRunning) setDialog(null); }} className="apk-dialog">
      <div className="apk-modal-body">
        <div className="apk-intro"><span className="apk-shield"><ShieldCheck size={19} /></span><div><b>بناء Android فعلي إلى APK</b><span>اختر المسار المناسب؛ لن يُرسل المشروع قبل موافقتك أدناه.</span></div></div>
        <section className="apk-pretest" aria-label="اختبار المشروع قبل التنزيل"><div><b>اختبر المعاينة قبل إرسال المشروع</b><small>{buildTrack === 'webview' ? 'افتح صفحة HTML ومواردها المحلية في المعاينة المعزولة، ثم عد إلى هنا للبناء.' : 'افحص تخطيط Android XML إن وجد؛ Gradle سيُترجم جميع ملفات Kotlin/Java ويُوقّع APK قبل إتاحة التنزيل.'}</small></div><div className="apk-pretest-actions">{buildTrack === 'webview' && apkEntry && <button type="button" className="secondary-button" disabled={buildRunning} onClick={() => previewBuildFile(apkEntry, `فتح معاينة ${apkEntry} قبل البناء.`)}><Eye size={14} /> اختبار HTML</button>}{buildTrack === 'native' && nativeXmlPreviewPath && <button type="button" className="secondary-button" disabled={buildRunning} onClick={() => previewBuildFile(nativeXmlPreviewPath, `فتح المعاينة التقريبية لـ ${nativeXmlPreviewPath}.`)}><Eye size={14} /> اختبار XML</button>}</div></section>
        <div className="apk-track-choice" role="radiogroup" aria-label="مسار بناء APK">
          <button type="button" role="radio" aria-checked={buildTrack === 'webview'} className={`apk-track-option ${buildTrack === 'webview' ? 'selected' : ''}`} disabled={buildRunning || !htmlEntries.length} onClick={() => { setBuildTrack('webview'); setBuildArtifact(null); setBuildAudit(''); }}><Globe2 size={18} /><span><b>WebView سريع</b><small>صفحة HTML محلية · المسار المسبق الحالي</small></span>{buildTrack === 'webview' && <Check size={16} />}</button>
          <button type="button" role="radio" aria-checked={buildTrack === 'native'} className={`apk-track-option ${buildTrack === 'native' ? 'selected' : ''}`} disabled={buildRunning || !nativeFileCount} onClick={() => { setBuildTrack('native'); setBuildArtifact(null); setBuildAudit(''); }}><Code2 size={18} /><span><b>Android Native · Gradle</b><small>{nativeFileCount} ملف Kotlin/Java · بناء Gradle حقيقي</small></span>{buildTrack === 'native' && <Check size={16} />}</button>
        </div>
        <div className="apk-language-coverage"><b>لغات المشروع المكتشفة</b><span>{projectLanguageInventory.length ? projectLanguageInventory.join('، ') : 'لا توجد ملفات مصدر حالياً'}</span><small>HTML/CSS/JavaScript تُعاين داخل WebView؛ Kotlin/Java وموارد Android XML تُبنى عبر Gradle. بقية اللغات تبقى ملفات مصدر قابلة للتحرير والفحص، ولا تُنفَّذ داخل APK تلقائياً.</small></div>
        <label className="field-label">اسم التطبيق على الهاتف<input className="text-input" value={identityDraft.appName} maxLength={32} onChange={(event) => updateIdentity({ ...identityDraft, appName: event.target.value })} placeholder="اسم التطبيق" /></label>
        {buildTrack === 'webview' ? <label className="field-label">صفحة البداية عند فتح التطبيق<select className="select-input" value={apkEntry} onChange={(event) => setApkEntry(event.target.value)}>{htmlEntries.length ? htmlEntries.map((path) => <option key={path} value={path}>{path}</option>) : <option value="">لا توجد صفحة HTML في المشروع</option>}</select></label> : <div className="native-build-summary"><b>ملفات Android التي سيبنيها Gradle</b><span>تُجمع ملفات Kotlin/Java ويُضمّن محتوى مجلدات <code>res/</code> و<code>assets/</code> المعروفة. إذا احتوى المشروع MainActivity بسيطاً يرث <code>android.app.Activity</code> فسيُستخدم؛ وإلا يُنشأ مشغّل Android أصلي يعرض موارد المشروع.</span><small>لا تُنفّذ ملفات Gradle المستوردة أو إضافاتها المخصصة. إضافات AndroidX الخارجية غير مضافة إلى القالب؛ قد يفشل المصدر الذي يعتمد عليها ويعرض سجل الخطأ. تنزيل Gradle/Android plugins الرسمية يتطلب اتصال خدمة البناء بالإنترنت في أول بناء.</small></div>}
        <div className="apk-icon-row"><div className={`app-icon-shape ${identityDraft.iconShape}`} style={{ background: identityDraft.iconBackground }}>{identityDraft.uploadedIcon ? <img src={identityDraft.uploadedIcon} alt="أيقونة التطبيق" /> : <Sparkles size={28} color={identityDraft.iconForeground} />}</div><div><b>أيقونة التطبيق</b><span>{identityDraft.uploadedIcon ? 'صورة مخصصة' : `مكتبة بأكثر من 100 رمز · ${identityDraft.iconName}`}</span></div><button className="secondary-button" onClick={() => setIconOpen(true)}><Settings2 size={15} /> تخصيص</button></div>
        <div className="apk-meta"><span>معرّف الحزمة</span><code>{identityDraft.packageId}</code></div>
        <label className="network-permission-row"><input type="checkbox" checked={identityDraft.allowExternalNetwork} onChange={(event) => updateIdentity({ ...identityDraft, allowExternalNetwork: event.target.checked })} /><span><b>السماح باتصال الإنترنت داخل APK</b><small>غير محدد: لا يُضاف إذن INTERNET. عند التفعيل يُضاف الإذن وتُحجب اتصالات HTTP غير المشفّرة. أذونات Android الأخرى لا تُمنح تلقائياً؛ على Activity طلب الإذن الخطِر من النظام وقت الحاجة.</small></span></label>
        <div className="apk-note"><AlertTriangle size={16} /><span>{buildTrack === 'webview' ? 'مسار WebView السريع يعمل صفحات الويب المحلية؛ لا يشغّل Python أو Java أو C++ الأصلية. هذا المسار لا يستخدم Gradle. توقيع debug للاختبار وليس Google Play.' : 'هذا APK Android أصلي يُبنى ويوقّع عبر Gradle debug؛ لا يعني ذلك أن كل ملف مصدر يصبح واجهة تشغيلية. توقيع debug للاختبار الجانبي وليس Google Play.'}</span></div>
        <label className="consent-row"><input type="checkbox" checked={buildConsent} onChange={(event) => setBuildConsent(event.target.checked)} /><span>أوافق على إرسال ملفات مشروع <b>{activeProject.name}</b> مؤقتاً إلى خدمة بناء CODEXA لمسار {buildTrack === 'webview' ? 'WebView' : 'Android Gradle'}. تُحذف ملفات العمل المؤقتة بعد نتيجة البناء.</span></label>
        {buildMessage && <div className={`build-message ${buildRunning ? 'progress' : buildArtifact ? 'success' : 'error'}`} role="status">{!buildRunning && (buildArtifact ? <CheckCircle2 size={15} /> : <AlertTriangle size={15} />)}{buildMessage}</div>}
        {buildRunning && <div className="build-progress" role="group" aria-label={`تقدم البناء ${buildProgress}%`}><div className="build-progress-copy"><span>{buildTrack === 'native' ? 'Android Gradle' : 'WebView سريع'} · {buildMessage}</span><b>{buildProgress}%</b></div><div className="build-progress-track" role="progressbar" aria-label="نسبة اكتمال بناء APK" aria-valuemin={0} aria-valuemax={100} aria-valuenow={buildProgress}><span style={{ width: `${buildProgress}%` }} /></div></div>}
        {buildArtifact && <div className="apk-build-audit" role="status"><CheckCircle2 size={17} /><div><b>اجتاز APK التحقق، ولم يبدأ التنزيل بعد</b><small>{buildAudit}</small><small>نجح فحص MIME ومعرّف الحزمة والحجم وتوقيع debug. هذا فحص بناء وتغليف؛ تشغيل التطبيق على هاتف/محاكي ليس متاحاً داخل خادم المعاينة.</small></div><button type="button" className="secondary-button" onClick={downloadVerifiedApk}><Download size={14} /> تنزيل الآن</button></div>}
        <div className="apk-reassurance"><ShieldCheck size={14} /><span>حذف هذا المشروع من CODEXA لا يزيل APK المثبّت على الهاتف؛ أزله من إعدادات Android عند الحاجة.</span></div>
      </div>
      <footer className="dialog-foot apk-dialog-foot"><button className="secondary-button" onClick={() => setDialog(null)} disabled={buildRunning}>إغلاق</button>{buildArtifact ? <button type="button" className="apk-button large" onClick={downloadVerifiedApk}><Download size={16} /> تنزيل APK المتحقق</button> : <button className="apk-button large" onClick={() => void buildApk()} disabled={buildRunning || !buildConsent || (buildTrack === 'webview' ? !htmlEntries.length : !nativeFileCount)}>{buildRunning ? <LoaderCircle className="spin" size={16} /> : <ShieldCheck size={16} />}{buildRunning ? `${buildProgress}% · جارٍ البناء…` : 'إنشاء وفحص APK'}</button>}</footer>
    </ModalFrame>}

    {iconOpen && identityDraft && <Suspense fallback={<ModalLoading label="تحميل مكتبة الأيقونات…" />}><IconLibrary value={identityDraft} onChange={updateIdentity} onClose={() => setIconOpen(false)} /></Suspense>}
    {toast && <div className="toast" role="status"><CheckCircle2 size={16} />{toast}</div>}
  </div>;
}
