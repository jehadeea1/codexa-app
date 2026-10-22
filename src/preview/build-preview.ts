import { init, parse } from 'es-module-lexer';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import type { CodeProject, PreviewResult, ProjectFile } from '../types';
import { extensionOf } from '../file-utils';
import { resolveProjectReference } from '../project-paths';
import { detectLanguage } from '../languages';
import { androidLayoutPreviewCss, buildAndroidLayoutPreview } from './android-layout-preview';

const mimeByExt: Record<string, string> = {
  html: 'text/html; charset=utf-8', htm: 'text/html; charset=utf-8', xhtml: 'text/html; charset=utf-8',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', svg: 'image/svg+xml',
  ico: 'image/x-icon', woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf', json: 'application/json', wasm: 'application/wasm', mp3: 'audio/mpeg', mp4: 'video/mp4', webm: 'video/webm',
};
function contentSecurityPolicy(allowExternal: boolean): string {
  const web = allowExternal ? 'https: ' : '';
  const connects = allowExternal ? 'https: wss:' : "'none'";
  const frames = allowExternal ? "'self' https: data: blob:" : "'self' data:";
  const forms = allowExternal ? "'self' https:" : "'self' data: blob:";
  const navigation = allowExternal ? "'self' https: data: blob:" : "'self' data: blob:";
  return `default-src 'none'; base-uri 'none'; object-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' ${web}data: blob:; style-src 'unsafe-inline' ${web}data: blob:; img-src ${web}data: blob:; font-src ${web}data: blob:; connect-src ${connects}; media-src ${web}data: blob:; frame-src ${frames}; form-action ${forms}; navigate-to ${navigation};`;
}

function sandboxIframe(iframe: HTMLIFrameElement, allowExternal: boolean): void {
  const authored = iframe.getAttribute('sandbox');
  const requested = authored === null
    ? new Set(['allow-scripts', 'allow-forms', ...(allowExternal ? ['allow-popups'] : [])])
    : new Set(authored.toLowerCase().split(/\s+/).filter(Boolean));
  const permitted = ['allow-scripts', 'allow-forms', ...(allowExternal ? ['allow-popups'] : [])]
    .filter((permission) => requested.has(permission));
  iframe.setAttribute('sandbox', permitted.join(' '));
}

function approvedFrameUrl(reference: string, allowExternal: boolean): string | null {
  const value = reference.trim();
  if (!allowExternal) return null;
  if (value.startsWith('//')) return `https:${value}`;
  return /^(?:https:\/\/|data:|blob:)/i.test(value) ? value : null;
}

function guardExternalAnchor(anchor: HTMLAnchorElement, reference: string, allowExternal: boolean, diagnostics: string[], basePath: string): void {
  const value = reference.trim();
  if (/^http:\/\//i.test(value) || ((/^https:\/\//i.test(value) || value.startsWith('//')) && !allowExternal)) {
    anchor.removeAttribute('href');
    diagnostics.push(`حُجب رابط خارجي في ${basePath}؛ HTTP غير المشفر محجوب دائماً.`);
    return;
  }
  if (/^https:\/\//i.test(value) || (value.startsWith('//') && allowExternal)) {
    if (value.startsWith('//')) anchor.setAttribute('href', `https:${value}`);
    anchor.setAttribute('target', '_blank');
    anchor.setAttribute('rel', 'noopener noreferrer');
  }
}

function secureSrcdoc(iframe: HTMLIFrameElement, allowExternal: boolean, diagnostics: string[], basePath: string): void {
  const source = iframe.getAttribute('srcdoc');
  if (source === null) return;
  const child = new DOMParser().parseFromString(source, 'text/html');
  const policy = child.createElement('meta');
  policy.httpEquiv = 'Content-Security-Policy';
  policy.content = contentSecurityPolicy(allowExternal);
  child.head.prepend(policy);
  for (const anchor of [...child.querySelectorAll<HTMLAnchorElement>('a[href]')]) {
    const href = anchor.getAttribute('href')?.trim() ?? '';
    if (/^http:\/\//i.test(href) || ((/^https:\/\//i.test(href) || href.startsWith('//')) && !allowExternal)) {
      anchor.removeAttribute('href');
      diagnostics.push(`حُجب رابط خارجي في إطار مضمّن داخل ${basePath}.`);
    } else if (/^https:\/\//i.test(href) || (href.startsWith('//') && allowExternal)) {
      if (href.startsWith('//')) anchor.setAttribute('href', `https:${href}`);
      anchor.target = '_blank';
      anchor.rel = 'noopener noreferrer';
    }
  }
  iframe.removeAttribute('src');
  iframe.setAttribute('srcdoc', '<!doctype html>\n' + child.documentElement.outerHTML);
  sandboxIframe(iframe, allowExternal);
}

function esc(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
}

function fileDataUrl(file: ProjectFile): string {
  if (file.content.startsWith('data:')) return file.content;
  const extension = extensionOf(file.path);
  const mime = mimeByExt[extension] ?? (extension === 'css' ? 'text/css' : extension === 'js' || extension === 'mjs' ? 'text/javascript' : 'application/octet-stream');
  const bytes = new TextEncoder().encode(file.content);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return `data:${mime};base64,${btoa(binary)}`;
}

function isExternal(reference: string): boolean {
  return /^(?:[a-z][a-z\d+.-]*:|\/\/|#|data:|blob:|mailto:|tel:)/i.test(reference.trim());
}

function cssWithLocalAssets(css: string, basePath: string, files: Record<string, ProjectFile>, diagnostics: string[], depth = 0, seen = new Set<string>()): string {
  if (depth > 8) {
    diagnostics.push('تجاوز استيراد CSS الحد الآمن للتداخل.');
    return css;
  }
  const imported = css.replace(/@import\s+(?:url\(\s*(["'])(.*?)\1\s*\)|url\(\s*([^)]*?)\s*\)|(["'])(.*?)\4|([^\s;]+))\s*([^;]*);/gi, (whole, _urlQuote: string, quotedUrl: string, rawUrl: string, _bareQuote: string, quotedBare: string, rawReference: string, condition: string) => {
    const reference = (quotedUrl ?? rawUrl ?? quotedBare ?? rawReference ?? '').trim();
    if (isExternal(reference)) return whole;
    const path = resolveProjectReference(basePath, reference);
    const file = path ? files[path] : undefined;
    if (!file) {
      diagnostics.push(`ملف CSS المستورد غير موجود: ${reference}`);
      return `/* تعذر العثور على ${esc(reference)} */`;
    }
    if (seen.has(file.path)) {
      diagnostics.push(`دورة استيراد CSS متكررة: ${file.path}`);
      return '';
    }
    const nextSeen = new Set(seen).add(file.path);
    const inner = cssWithLocalAssets(file.content, file.path, files, diagnostics, depth + 1, nextSeen);
    const layer = condition.match(/\blayer(?:\(([^)]*)\))?/i)?.[0];
    const supports = condition.match(/\bsupports\((.*)\)/i)?.[1];
    const media = condition.replace(/\blayer(?:\([^)]*\))?|\bsupports\((?:[^()]|\([^()]*\))*\)/gi, '').trim();
    let result = inner;
    if (supports) result = `@supports (${supports}) {\n${result}\n}`;
    if (layer) result = `${layer.includes('(') ? `@${layer}` : `@layer ${layer.replace(/^layer/i, '').trim()}`} {\n${result}\n}`;
    if (media) result = `@media ${media} {\n${result}\n}`;
    return result;
  });
  return imported.replace(/url\(\s*(["']?)([^"')]+)\1\s*\)/gi, (whole, _quote: string, reference: string) => {
    const value = reference.trim();
    if (isExternal(value)) return whole;
    const path = resolveProjectReference(basePath, value);
    const file = path ? files[path] : undefined;
    if (!file) {
      diagnostics.push(`أصل CSS محلي غير موجود: ${value}`);
      return 'url("")';
    }
    return `url("${fileDataUrl(file)}")`;
  });
}

async function rewriteModule(source: string, path: string, files: Record<string, ProjectFile>, diagnostics: string[], stack = new Set<string>()): Promise<string> {
  if (stack.has(path)) {
    diagnostics.push(`دورة استيراد JavaScript: ${path}؛ يلزم تجميع الحزمة قبل المعاينة.`);
    return source;
  }
  const nextStack = new Set(stack).add(path);
  await init;
  const [imports] = parse(source);
  const replacements: Array<{ start: number; end: number; value: string }> = [];
  for (const item of imports) {
    if (!item.n) continue;
    if (isExternal(item.n)) continue;
    if (!item.n.startsWith('.') && !item.n.startsWith('/')) {
      diagnostics.push(`الوحدة «${item.n}» اسم حزمة خارجي؛ أضفها إلى import map أو استخدم ملفات ويب مجمّعة.`);
      continue;
    }
    const targetPath = resolveProjectReference(path, item.n);
    const target = targetPath ? files[targetPath] : undefined;
    if (!target) {
      diagnostics.push(`وحدة JavaScript محلية غير موجودة: ${item.n} (من ${path})`);
      continue;
    }
    const rewritten = await rewriteModule(target.content, target.path, files, diagnostics, nextStack);
    const url = `data:text/javascript;charset=utf-8,${encodeURIComponent(rewritten)}`;
    replacements.push({ start: item.s, end: item.e, value: url });
  }
  let output = source;
  for (const replacement of replacements.sort((a, b) => b.start - a.start)) {
    output = output.slice(0, replacement.start) + replacement.value + output.slice(replacement.end);
  }
  return output;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function rewriteImportMap(map: Record<string, unknown>, htmlPath: string, files: Record<string, ProjectFile>, diagnostics: string[]): Promise<void> {
  const rewriteEntries = async (entries: unknown) => {
    if (!isRecord(entries)) return;
    for (const [specifier, value] of Object.entries(entries)) {
      if (typeof value !== 'string' || isExternal(value)) continue;
      if (!value.startsWith('./') && !value.startsWith('../') && !value.startsWith('/')) {
        diagnostics.push(`قيمة import map لـ «${specifier}» ليست عنوان ملف محلياً؛ يُترك المرجع كما هو.`);
        continue;
      }
      const targetPath = resolveProjectReference(htmlPath, value);
      const target = targetPath ? files[targetPath] : undefined;
      if (!target) {
        diagnostics.push(`ملف import map غير موجود: ${value}`);
        continue;
      }
      const extension = extensionOf(target.path);
      if (extension === 'js' || extension === 'mjs') {
        const moduleSource = await rewriteModule(target.content, target.path, files, diagnostics);
        entries[specifier] = `data:text/javascript;charset=utf-8,${encodeURIComponent(moduleSource)}`;
      } else if (extension === 'json') {
        entries[specifier] = fileDataUrl(target);
      } else diagnostics.push(`قيمة import map «${specifier}» تشير إلى ${extension || 'ملف'} غير قابل للتشغيل كوحدة JavaScript.`);
    }
  };
  await rewriteEntries(map.imports);
  if (isRecord(map.scopes)) {
    for (const entries of Object.values(map.scopes)) await rewriteEntries(entries);
  }
}

async function linkedHtmlDataUrl(path: string, project: CodeProject, allowExternal: boolean, diagnostics: string[], depth = 0, ancestry = new Set<string>()): Promise<string | null> {
  if (depth > 4 || ancestry.has(path)) {
    diagnostics.push(`توقفت معاينة رابط HTML المتداخل عند حد العمق أو دورة المسارات: ${path}`);
    return null;
  }
  const file = project.files[path];
  if (!file) return null;
  const visited = new Set(ancestry).add(path);
  const doc = new DOMParser().parseFromString(file.content, 'text/html');
  if (!doc.querySelector('meta[name="viewport"]')) {
    const viewport = doc.createElement('meta');
    viewport.name = 'viewport'; viewport.content = 'width=device-width, initial-scale=1.0';
    (doc.head ?? doc.documentElement).prepend(viewport);
  }
  const policy = doc.createElement('meta');
  policy.httpEquiv = 'Content-Security-Policy'; policy.content = contentSecurityPolicy(allowExternal);
  doc.head?.prepend(policy);
  for (const importMap of [...doc.querySelectorAll('script[type="importmap"]')]) {
    try {
      const value: unknown = JSON.parse(importMap.textContent || '{}');
      if (!isRecord(value)) throw new Error('invalid map');
      await rewriteImportMap(value, file.path, project.files, diagnostics);
      importMap.textContent = JSON.stringify(value);
    } catch { diagnostics.push(`تعذر تحليل import map في ${file.path}.`); }
  }
  for (const style of [...doc.querySelectorAll('style')]) style.textContent = cssWithLocalAssets(style.textContent || '', file.path, project.files, diagnostics);
  for (const styled of [...doc.querySelectorAll<HTMLElement>('[style]')]) styled.setAttribute('style', cssWithLocalAssets(styled.getAttribute('style') || '', file.path, project.files, diagnostics));
  for (const link of [...doc.querySelectorAll('link[rel~="stylesheet"][href]')]) {
    const href = link.getAttribute('href') ?? '';
    if (isExternal(href)) continue;
    const cssPath = resolveProjectReference(file.path, href);
    const stylesheet = cssPath ? project.files[cssPath] : undefined;
    if (!stylesheet) { diagnostics.push(`ورقة تنسيق غير موجودة: ${href}`); continue; }
    const style = doc.createElement('style');
    style.textContent = cssWithLocalAssets(stylesheet.content, stylesheet.path, project.files, diagnostics, 0, new Set([stylesheet.path]));
    link.replaceWith(style);
  }
  for (const iframe of [...doc.querySelectorAll<HTMLIFrameElement>('iframe[srcdoc]')]) secureSrcdoc(iframe, allowExternal, diagnostics, file.path);
  for (const element of [...doc.querySelectorAll('[src], [poster], [href]')]) {
    const attr = element.hasAttribute('src') ? 'src' : element.hasAttribute('poster') ? 'poster' : 'href';
    const reference = element.getAttribute(attr) ?? '';
    if (element.tagName === 'IFRAME') {
      const iframe = element as HTMLIFrameElement;
      sandboxIframe(iframe, allowExternal);
      if (!reference || reference === 'about:blank' || reference.startsWith('#')) continue;
      if (isExternal(reference)) {
        const approved = approvedFrameUrl(reference, allowExternal);
        if (approved) iframe.setAttribute(attr, approved);
        else { iframe.removeAttribute(attr); diagnostics.push(`حُجب إطار خارجي في ${file.path}؛ HTTP غير المشفر محجوب دائماً.`); }
        continue;
      }
    }
    if (!reference || isExternal(reference)) {
      if (element.tagName === 'A' && reference) guardExternalAnchor(element as HTMLAnchorElement, reference, allowExternal, diagnostics, file.path);
      continue;
    }
    if (element.tagName === 'LINK' && element.getAttribute('rel')?.toLowerCase() === 'stylesheet') continue;
    const targetPath = resolveProjectReference(file.path, reference);
    const target = targetPath ? project.files[targetPath] : undefined;
    if (!target) { diagnostics.push(`مرجع محلي غير موجود في ${file.path}: ${reference}`); continue; }
    if (element.tagName === 'A' && /\.(?:html?|xhtml)$/i.test(target.path)) {
      const child = await linkedHtmlDataUrl(target.path, project, allowExternal, diagnostics, depth + 1, visited);
      if (child) { element.setAttribute('href', child); element.setAttribute('target', allowExternal ? '_blank' : '_self'); if (allowExternal) element.setAttribute('rel', 'noopener noreferrer'); }
      else element.setAttribute('href', '#');
    } else if (element.tagName === 'SCRIPT' && element.getAttribute('type') === 'module') {
      const script = doc.createElement('script'); script.type = 'module'; script.textContent = await rewriteModule(target.content, target.path, project.files, diagnostics); element.replaceWith(script);
    } else if (element.tagName === 'SCRIPT') {
      const script = doc.createElement('script'); script.textContent = target.content; element.replaceWith(script);
    } else if (element.tagName === 'IFRAME' && /\.(?:html?|xhtml)$/i.test(target.path)) {
      const child = await linkedHtmlDataUrl(target.path, project, allowExternal, diagnostics, depth + 1, visited);
      if (child) element.setAttribute(attr, child); else element.removeAttribute(attr);
    } else {
      if (element.tagName === 'IFRAME') sandboxIframe(element as HTMLIFrameElement, allowExternal);
      element.setAttribute(attr, fileDataUrl(target));
    }
  }
  const html = '<!doctype html>\n' + doc.documentElement.outerHTML;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

function titleOf(doc: Document, fallback: string): string {
  return doc.querySelector('title')?.textContent?.trim() || fallback;
}

function makePage(title: string, body: string, extraHead = '', extraCss = '', allowExternal = false): string {
  return `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><meta http-equiv="Content-Security-Policy" content="${contentSecurityPolicy(allowExternal)}"><title>${esc(title)}</title>${extraHead}<style>html{color-scheme:light dark}body{margin:0;padding:20px;background:#10130f;color:#edf2e9;font:15px/1.8 system-ui,sans-serif}pre,code{font-family:ui-monospace,monospace;direction:ltr;text-align:left;white-space:pre-wrap;overflow-wrap:anywhere}.frame{max-width:780px;margin:0 auto}.hint{color:#a9ec76;font-size:12px;margin:0 0 12px}.source{border:1px solid #293127;background:#171c16;border-radius:14px;padding:16px;overflow:auto}.stage{max-width:560px;margin:10vh auto;padding:24px;border:1px solid #384234;border-radius:24px;background:#182019;box-shadow:0 20px 70px #0008}img.preview{display:block;max-width:100%;max-height:78vh;margin:auto;object-fit:contain}a{color:#a9ec76}button{font:inherit}${extraCss}</style></head><body>${body}</body></html>`;
}

export async function buildPreview(project: CodeProject, entryPath: string, allowExternal = false): Promise<PreviewResult> {
  const file = project.files[entryPath];
  if (!file) return { html: makePage('لا يوجد ملف', '<main class="frame"><p>لم يتم العثور على الملف المحدد.</p></main>', '', '', allowExternal), title: 'لا يوجد ملف', diagnostics: ['الملف المحدد غير موجود في المشروع.'] };
  const extension = extensionOf(file.path);
  const diagnostics: string[] = [];
  if (extension === 'xml') {
    const resources = Object.fromEntries(Object.entries(project.files).map(([path, item]) => [path, { content: item.content }]));
    const androidLayout = buildAndroidLayoutPreview(file.path, file.content, resources);
    if (androidLayout) return { html: makePage(file.path, androidLayout.html, androidLayoutPreviewCss, '', allowExternal), title: androidLayout.title, diagnostics: androidLayout.diagnostics };
  }
  if (['html', 'htm'].includes(extension)) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(file.content, 'text/html');
    if (!doc.querySelector('meta[name="viewport"]')) {
      const meta = doc.createElement('meta');
      meta.name = 'viewport';
      meta.content = 'width=device-width, initial-scale=1.0';
      (doc.head ?? doc.documentElement).prepend(meta);
    }
    const policy = doc.createElement('meta');
    policy.httpEquiv = 'Content-Security-Policy';
    policy.content = contentSecurityPolicy(allowExternal);
    doc.head?.prepend(policy);
    for (const importMap of [...doc.querySelectorAll('script[type="importmap"]')]) {
      try {
        const value: unknown = JSON.parse(importMap.textContent || '{}');
        if (!isRecord(value)) throw new Error('invalid map');
        await rewriteImportMap(value, file.path, project.files, diagnostics);
        importMap.textContent = JSON.stringify(value);
        const firstModule = doc.querySelector('script[type="module"]');
        if (firstModule && (importMap.compareDocumentPosition(firstModule) & Node.DOCUMENT_POSITION_PRECEDING) !== 0) firstModule.before(importMap);
      } catch {
        diagnostics.push('تعذر تحليل import map؛ تحقّق من صيغة JSON.');
      }
    }
    for (const style of [...doc.querySelectorAll('style')]) {
      style.textContent = cssWithLocalAssets(style.textContent || '', file.path, project.files, diagnostics);
    }
    for (const styled of [...doc.querySelectorAll<HTMLElement>('[style]')]) {
      styled.setAttribute('style', cssWithLocalAssets(styled.getAttribute('style') || '', file.path, project.files, diagnostics));
    }
    for (const link of [...doc.querySelectorAll('link[rel~="stylesheet"][href]')]) {
      const href = link.getAttribute('href') ?? '';
      if (isExternal(href)) continue;
      const path = resolveProjectReference(file.path, href);
      const stylesheet = path ? project.files[path] : undefined;
      if (!stylesheet) {
        diagnostics.push(`ورقة تنسيق غير موجودة: ${href}`);
        continue;
      }
      const style = doc.createElement('style');
      style.textContent = cssWithLocalAssets(stylesheet.content, stylesheet.path, project.files, diagnostics, 0, new Set([stylesheet.path]));
      link.replaceWith(style);
    }
    for (const iframe of [...doc.querySelectorAll<HTMLIFrameElement>('iframe[srcdoc]')]) secureSrcdoc(iframe, allowExternal, diagnostics, file.path);
    for (const element of [...doc.querySelectorAll('[src], [poster], [href]')]) {
      const attr = element.hasAttribute('src') ? 'src' : element.hasAttribute('poster') ? 'poster' : 'href';
      const reference = element.getAttribute(attr) ?? '';
      if (element.tagName === 'IFRAME') {
        const iframe = element as HTMLIFrameElement;
        sandboxIframe(iframe, allowExternal);
        if (!reference || reference === 'about:blank' || reference.startsWith('#')) continue;
        if (isExternal(reference)) {
          const approved = approvedFrameUrl(reference, allowExternal);
          if (approved) iframe.setAttribute(attr, approved);
          else { iframe.removeAttribute(attr); diagnostics.push('حُجب إطار خارجي؛ HTTP غير المشفر محجوب دائماً.'); }
          continue;
        }
      }
      if (!reference || isExternal(reference)) {
        if (element.tagName === 'A' && reference) guardExternalAnchor(element as HTMLAnchorElement, reference, allowExternal, diagnostics, file.path);
        continue;
      }
      if (element.tagName === 'LINK' && element.getAttribute('rel')?.toLowerCase() === 'stylesheet') continue;
      const path = resolveProjectReference(file.path, reference);
      const target = path ? project.files[path] : undefined;
      if (!target) {
        diagnostics.push(`مرجع محلي غير موجود: ${reference}`);
        continue;
      }
      if (element.tagName === 'SCRIPT' && element.getAttribute('type') === 'module') {
        const script = doc.createElement('script');
        script.type = 'module';
        script.textContent = await rewriteModule(target.content, target.path, project.files, diagnostics);
        element.replaceWith(script);
      } else if (element.tagName === 'SCRIPT') {
        const script = doc.createElement('script');
        script.textContent = target.content;
        element.replaceWith(script);
      } else if (element.tagName === 'A' && /\.(?:html?|xhtml)$/i.test(target.path)) {
        const linkedPage = await linkedHtmlDataUrl(target.path, project, allowExternal, diagnostics, 0, new Set([file.path]));
        element.setAttribute('href', linkedPage ?? '#');
        element.setAttribute('target', allowExternal ? '_blank' : '_self');
        if (allowExternal) element.setAttribute('rel', 'noopener noreferrer');
      } else if (element.tagName === 'IFRAME' && /\.(?:html?|xhtml)$/i.test(target.path)) {
        const child = await linkedHtmlDataUrl(target.path, project, allowExternal, diagnostics, 0, new Set([file.path]));
        if (child) element.setAttribute(attr, child);
        else element.removeAttribute(attr);
      } else {
        if (element.tagName === 'IFRAME') sandboxIframe(element as HTMLIFrameElement, allowExternal);
        element.setAttribute(attr, fileDataUrl(target));
      }
    }
    const title = titleOf(doc, file.path);
    return { html: '<!doctype html>\n' + doc.documentElement.outerHTML, title, diagnostics };
  }

  if (extension === 'css') {
    const css = cssWithLocalAssets(file.content, file.path, project.files, diagnostics);
    return { html: makePage(file.path, `<main class="stage"><p class="hint">معاينة CSS على عناصر تجريبية</p><div class="codexa-demo"><p>عنصر تجريبي للتنسيق</p><button type="button" disabled aria-label="عنصر تجريبي غير تفاعلي">زر تجريبي · غير تفاعلي</button></div></main>`, `<style>${css}</style>`, '.codexa-demo{padding:20px;border:1px dashed #a9ec7688;border-radius:16px}', allowExternal), title: file.path, diagnostics };
  }
  if (extension === 'js' || extension === 'mjs') {
    const js = extension === 'mjs' ? await rewriteModule(file.content, file.path, project.files, diagnostics) : file.content;
    const encoded = btoa(unescape(encodeURIComponent(js)));
    const body = `<main class="frame"><p class="hint">تشغيل JavaScript داخل المعاينة المعزولة</p><h2>سجل التنفيذ</h2><pre id="log" class="source">جاهز للتنفيذ…</pre></main><script>(()=>{const out=document.querySelector('#log');const lines=[];const format=(x)=>{try{return typeof x==='string'?x:JSON.stringify(x)}catch{return String(x)}};console.log=(...a)=>{lines.push(a.map(format).join(' '));out.textContent=lines.join('\\n')||'تم التنفيذ دون مخرجات.'};console.warn=(...a)=>{lines.push('⚠ '+a.map(format).join(' '));out.textContent=lines.join('\\n')};console.error=(...a)=>{lines.push('خطأ: '+a.map(format).join(' '));out.textContent=lines.join('\\n')};try{(0,eval)(decodeURIComponent(escape(atob('${encoded}'))));if(!lines.length)out.textContent='اكتمل التنفيذ دون رسائل console.'}catch(e){out.textContent='تعذر التنفيذ: '+e.message}})();</script>`;
    return { html: makePage(file.path, body, '', '', allowExternal), title: file.path, diagnostics };
  }
  if (extension === 'json' || extension === 'jsonc') {
    let content = file.content;
    try { content = JSON.stringify(JSON.parse(content), null, 2); } catch { diagnostics.push('تعذر تحليل JSON؛ يتم عرض محتوى الملف كما هو.'); }
    return { html: makePage(file.path, `<main class="frame"><p class="hint">معاينة بيانات JSON</p><pre class="source">${esc(content)}</pre></main>`, '', '', allowExternal), title: file.path, diagnostics };
  }
  if (extension === 'md' || extension === 'markdown') {
    const rendered = DOMPurify.sanitize(await marked.parse(file.content), { USE_PROFILES: { html: true } });
    return { html: makePage(file.path, `<main class="frame markdown">${rendered}</main>`, '', '.markdown{max-width:760px;margin:0 auto;padding:16px 22px}.markdown img{max-width:100%}.markdown pre{background:#171c16;padding:16px;border-radius:12px}.markdown h1,.markdown h2{color:#a9ec76}', allowExternal), title: file.path, diagnostics };
  }
  if (extension === 'svg') {
    const safe = DOMPurify.sanitize(file.content, { USE_PROFILES: { svg: true, svgFilters: true } });
    const data = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(safe)}`;
    return { html: makePage(file.path, `<main class="frame"><p class="hint">معاينة SVG</p><img class="preview" src="${data}" alt="معاينة الرسم"/></main>`, '', '', allowExternal), title: file.path, diagnostics };
  }
  if (/^(png|jpe?g|gif|webp|avif|ico)$/.test(extension) || file.content.startsWith('data:image/')) {
    const data = fileDataUrl(file);
    return { html: makePage(file.path, `<main class="frame"><p class="hint">معاينة صورة</p><img class="preview" src="${data}" alt="${esc(file.path)}"/></main>`, '', '', allowExternal), title: file.path, diagnostics };
  }
  return {
    html: makePage(file.path, `<main class="frame"><p class="hint">مصدر الملف · ${esc(extension || 'نص')}</p></main>`, '', '', allowExternal),
    title: file.path, diagnostics: [], kind: 'source', language: detectLanguage(file.path, file.languageOverride), source: file.content,
  };
}
