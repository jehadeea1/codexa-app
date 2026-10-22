import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { createReadStream, existsSync } from 'node:fs';
import { access, copyFile, mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { buildNativeApk, createNativeBuildJob, nativeBuildToolsMissing, validateNativeProject } from './native-android.mjs';
import { BuildJobStore } from './build-job-store.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROD = process.env.NODE_ENV === 'production';
const DIST = path.join(ROOT, 'dist');
const TEMPLATE = path.resolve(process.env.CODEXA_TEMPLATE_DIR || path.join(ROOT, 'android-template'));
const SDK = path.resolve(process.env.CODEXA_ANDROID_HOME || process.env.ANDROID_HOME || (process.env.NODE_ENV === 'production' ? '/opt/android-sdk' : path.join(homedir(), '.android-sdk')));
const BUILD_TOOLS = path.join(SDK, 'build-tools', '35.0.0');
const PLATFORM_JAR = path.join(SDK, 'platforms', 'android-35', 'android.jar');
const AAPT = path.join(BUILD_TOOLS, 'aapt');
const ZIPALIGN = path.join(BUILD_TOOLS, 'zipalign');
const APKSIGNER = path.join(BUILD_TOOLS, 'apksigner');
const DEX = path.resolve(process.env.CODEXA_CLASSES_DEX || path.join(TEMPLATE, 'classes.dex'));
const KEYSTORE = path.resolve(process.env.CODEXA_DEBUG_KEYSTORE || path.join(TEMPLATE, 'codexa-debug.keystore'));
const PORT = Number(process.env.PORT || 3000);
const MAX_REQUEST = 30 * 1024 * 1024;
const MAX_PROJECT_BYTES = 20 * 1024 * 1024;
const MAX_FILE_BYTES = 4 * 1024 * 1024;
let activeBuild = false;
const GRADLE = path.resolve(process.env.CODEXA_GRADLE_BIN || '/opt/gradle/bin/gradle');
const BUILD_UID = Number(process.env.CODEXA_BUILD_UID ?? process.getuid?.() ?? -1);
const BUILD_GID = Number(process.env.CODEXA_BUILD_GID ?? process.getgid?.() ?? -1);
const BUILDER_HOME = path.resolve(process.env.CODEXA_BUILDER_HOME || homedir());
const nativeBuildJobs = new Map();
const webBuildJobs = new Map();
const jobStore = new BuildJobStore();
const NATIVE_JOB_TTL_MS = 15 * 60_000;
const WEB_JOB_TTL_MS = 15 * 60_000;
let vite;

const mimeTypes = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf', '.wasm': 'application/wasm',
};

function replyJson(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(value));
}

function safeXml(value) {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}

function validatePngIcon(value, size) {
  if (typeof value !== 'string') throw Object.assign(new Error('أيقونة التطبيق غير موجودة.'), { status: 400 });
  const match = value.match(/^data:image\/png;base64,([A-Za-z0-9+/=\r\n]+)$/);
  if (!match) throw Object.assign(new Error('يجب أن تكون أيقونة التطبيق صورة PNG صالحة.'), { status: 400 });
  const bytes = Buffer.from(match[1], 'base64');
  if (bytes.length < 80 || bytes.length > 2 * 1024 * 1024 || bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' || bytes.readUInt32BE(16) !== size || bytes.readUInt32BE(20) !== size) throw Object.assign(new Error(`يجب أن تكون أيقونة PNG مربعة بقياس ${size}×${size}.`), { status: 400 });
  return bytes;
}

async function readJson(req) {
  const declared = Number(req.headers['content-length'] || 0);
  if (declared > MAX_REQUEST) throw Object.assign(new Error('حجم الطلب يتجاوز 30 ميغابايت.'), { status: 413 });
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_REQUEST) throw Object.assign(new Error('حجم الطلب يتجاوز 30 ميغابايت.'), { status: 413 });
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw Object.assign(new Error('تعذر قراءة بيانات طلب البناء.'), { status: 400 }); }
}

function isForbiddenProjectSegment(segment) {
  const value = segment.toLowerCase();
  return value === '.npmrc' || value === '.git' || value === '.ssh' || value === '.codexa-folder' || value === '.env' || (value.startsWith('.env.') && value !== '.env.example');
}

function validateProject(input) {
  if (!input || input.consent !== true) throw Object.assign(new Error('لم تصل موافقة صريحة على إرسال ملفات المشروع.'), { status: 403 });
  if (typeof input.projectId !== 'string' || input.projectId.length < 1 || input.projectId.length > 120) throw Object.assign(new Error('معرّف المشروع غير صالح.'), { status: 400 });
  if (typeof input.appName !== 'string' || !input.appName.trim() || input.appName.length > 32 || /[\u0000-\u001f\u007f]/.test(input.appName)) throw Object.assign(new Error('اسم التطبيق غير صالح (الحد الأقصى 32 حرفاً).'), { status: 400 });
  if (typeof input.packageId !== 'string' || !/^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*){1,6}$/.test(input.packageId)) throw Object.assign(new Error('معرّف حزمة Android غير صالح.'), { status: 400 });
  if (!Array.isArray(input.files) || input.files.length < 1 || input.files.length > 500) throw Object.assign(new Error('يجب أن يحتوي المشروع من ملف واحد إلى 500 ملف.'), { status: 400 });
  if (typeof input.entry !== 'string' || !/\.(?:html?|xhtml)$/i.test(input.entry)) throw Object.assign(new Error('اختر ملف HTML صالحاً ليكون صفحة البداية.'), { status: 400 });
  const seen = new Set();
  let total = 0;
  let entryFound = false;
  for (const file of input.files) {
    if (!file || typeof file.path !== 'string' || typeof file.content !== 'string') throw Object.assign(new Error('أحد ملفات المشروع غير صالح.'), { status: 400 });
    const name = file.path.replaceAll('\\', '/');
    const parts = name.split('/');
    if (!name || name.length > 240 || name.startsWith('/') || name.includes(':') || parts.some((part) => !part || part.length > 120 || part === '.' || part === '..' || isForbiddenProjectSegment(part)) || /\.(?:jks|keystore|p12|pfx|pem|key|crt)$/i.test(name)) throw Object.assign(new Error(`مسار الملف غير آمن: ${name.slice(0, 80)}`), { status: 400 });
    if (seen.has(name)) throw Object.assign(new Error(`المسار مكرر داخل المشروع: ${name}`), { status: 400 });
    for (const existing of seen) {
      if (name.startsWith(`${existing}/`) || existing.startsWith(`${name}/`)) throw Object.assign(new Error(`يتعارض ملف مع مسار مجلد: ${name.slice(0, 80)} ↔ ${existing.slice(0, 80)}`), { status: 400 });
    }
    seen.add(name);
    if (name === input.entry) entryFound = true;
    const bytes = Buffer.byteLength(file.content, 'utf8');
    if (bytes > MAX_FILE_BYTES) throw Object.assign(new Error(`الملف ${name} أكبر من الحد المسموح.`), { status: 413 });
    total += bytes;
    if (total > MAX_PROJECT_BYTES) throw Object.assign(new Error('الحجم الإجمالي لملفات المشروع يتجاوز 20 ميغابايت.'), { status: 413 });
  }
  if (!entryFound) throw Object.assign(new Error('ملف صفحة البداية غير موجود ضمن الملفات المرسلة.'), { status: 400 });
  const iconBytes = validatePngIcon(input.iconPng, 512);
  const iconBytes192 = input.iconPng192 === undefined ? null : validatePngIcon(input.iconPng192, 192);
  return { ...input, allowExternalNetwork: input.allowExternalNetwork === true, appName: input.appName.trim(), files: input.files.map((file) => ({ path: file.path.replaceAll('\\', '/'), content: file.content })), iconBytes, iconBytes192 };
}

function pruneBuildJobs(jobs, ttl) {
  const now = Date.now();
  for (const [id, job] of jobs) if (job.finishedAt && now - job.finishedAt > ttl) jobs.delete(id);
}

function queueTaskSave(job, track) {
  if (job.saveTimer) return;
  job.saveTimer = setTimeout(() => {
    job.saveTimer = null;
    const prior = job.savePromise ?? Promise.resolve();
    job.savePromise = prior.catch(() => undefined).then(() => jobStore.persist(job, track)).catch((error) => {
      console.error(`[CODEXA task store] ${error?.code || 'WRITE_FAILED'}`);
    });
  }, 300);
  job.saveTimer.unref?.();
}

async function flushTaskSave(job, track) {
  if (job.saveTimer) { clearTimeout(job.saveTimer); job.saveTimer = null; }
  const prior = job.savePromise ?? Promise.resolve();
  job.savePromise = prior.catch(() => undefined).then(() => jobStore.persist(job, track));
  await job.savePromise;
}

function startTaskHeartbeat(job, track) {
  const timer = setInterval(() => {
    job.updatedAt = Date.now();
    queueTaskSave(job, track);
    void jobStore.renewBuildLock(job.id).catch((error) => console.error(`[CODEXA build lease] ${error?.code || 'RENEW_FAILED'}`));
  }, 10_000);
  timer.unref?.();
  return timer;
}

async function sendBuildArtifact(res, job, track, filename) {
  if (job.status !== 'completed' || !job.artifactPath || !job.artifactKey) { replyJson(res, 409, { error: 'لم يكتمل APK والتحقق من توقيعه؛ لا يوجد تنزيل متاح.' }); return; }
  const info = await stat(job.artifactPath).catch(() => null);
  if (!info || info.size < 4096 || info.size > 120 * 1024 * 1024) { replyJson(res, 409, { error: 'ملف APK المؤقت غير متاح أو حجمه غير صالح؛ لا يبدأ التنزيل.' }); return; }
  const stream = createReadStream(job.artifactPath);
  res.writeHead(200, { 'Content-Type': 'application/vnd.android.package-archive', 'Content-Length': String(info.size), 'Content-Disposition': `attachment; filename="${filename}"`, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'X-CODEXA-APK-Signature': 'debug-verified', 'X-CODEXA-Build-Track': track === 'native' ? 'native-gradle' : 'webview', 'X-CODEXA-Package-ID': String(job.packageId || '') });
  stream.on('error', (error) => { console.error(`[CODEXA result stream] ${error?.code || 'READ_FAILED'}`); if (!res.headersSent) replyJson(res, 409, { error: 'تعذر قراءة ملف APK المؤقت؛ لم يُسلّم ملف غير مكتمل.' }); else res.destroy(); });
  stream.pipe(res);
}

function logNativeBuild(job, message) {
  if (!message) return;
  const text = String(message);
  const lower = text.toLowerCase();
  const milestones = [
    [/تهيئة/, 15, 'تهيئة مشروع Android الأصلي'],
    [/(?:فحص|تحقق).*(?:java|kotlin|xml)|هيكل android مؤقت|أنشأ هيكل/, 35, 'فحص مصادر Java/Kotlin/XML وإعداد هيكل Android'],
    [/(?:compiledebug|dexbuilder|mergeprojectdex|compile.*(?:kotlin|java))/, 65, 'تصريف الشيفرة وتوليد DEX'],
    [/(?:packagedebug|assembledebug|build successful|اكتمل التجميع|تحزيم الموارد)/, 85, 'تحزيم الموارد وإعداد الحزمة'],
    [/(?:apksigner|توقيع)/, 95, 'توقيع APK والتحقق منه'],
    [/اكتمل البناء والتحقق/, 100, 'اكتمل بناء APK الأصلي والتحقق من التوقيع'],
  ];
  for (const [pattern, progress, stage] of milestones) {
    if (pattern.test(lower) && progress > job.progress) { job.progress = progress; job.stage = stage; }
  }
  job.logs = `${job.logs}\n${text}`.slice(-200_000);
  queueTaskSave(job, 'native');
}

async function run(command, args, cwd, timeoutMs = 45_000) {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout = (stdout + chunk.toString()).slice(-12_000); });
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk.toString()).slice(-12_000); });
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`انتهت مهلة أداة Android: ${path.basename(command)}`)); }, timeoutMs);
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(`${path.basename(command)} exit ${code}: ${(stderr || stdout).trim().slice(-1600)}`));
      else resolve({ stdout, stderr });
    });
  });
}

function apkReady() {
  const missing = [AAPT, ZIPALIGN, APKSIGNER, path.join(BUILD_TOOLS, 'd8'), PLATFORM_JAR, DEX, KEYSTORE, path.join(TEMPLATE, 'AndroidManifest.xml'), path.join(TEMPLATE, 'MainActivity.java'), path.join(TEMPLATE, 'res', 'values', 'styles.xml')].filter((file) => !existsSync(file));
  return missing;
}

async function writeProjectFiles(root, files) {
  for (const file of files) {
    const destination = path.resolve(root, file.path);
    if (!destination.startsWith(`${path.resolve(root)}${path.sep}`)) throw Object.assign(new Error('مسار خارج مجلد ملفات المشروع.'), { status: 400 });
    await mkdir(path.dirname(destination), { recursive: true });
    const binary = file.content.match(/^data:([a-z0-9.+/-]+);base64,([A-Za-z0-9+/=\r\n]+)$/i);
    if (binary) {
      const allowed = /^(?:image\/(?:png|jpeg|jpg|gif|webp|avif|x-icon|svg\+xml)|font\/(?:woff|woff2|ttf|otf)|application\/(?:font-woff|vnd\.ms-opentype)|audio\/[a-z0-9.+-]+|video\/[a-z0-9.+-]+)$/i;
      if (!allowed.test(binary[1])) throw Object.assign(new Error(`نوع مورد غير نصي غير مسموح: ${file.path}`), { status: 400 });
      await writeFile(destination, Buffer.from(binary[2], 'base64'), { flag: 'wx' });
    } else await writeFile(destination, file.content, { encoding: 'utf8', flag: 'wx' });
  }
}

async function buildApk(raw, onProgress = () => undefined) {
  const project = validateProject(raw);
  const missing = apkReady();
  if (missing.length) throw Object.assign(new Error('خدمة البناء الفعلية غير جاهزة في هذه الحاوية: تنقصها أدوات Android أو قالب WebView المسبق. لم يُنشأ ZIP أو ملف بديل.'), { status: 503 });
  const temp = await mkdtemp(path.join(tmpdir(), 'codexa-apk-'));
  try {
    const assets = path.join(temp, 'assets');
    const webRoot = path.join(assets, 'www');
    const resources = path.join(temp, 'res');
    await mkdir(webRoot, { recursive: true });
    await mkdir(path.join(resources, 'values'), { recursive: true });
    await mkdir(path.join(resources, 'mipmap-nodpi'), { recursive: true });
    if (project.iconBytes192) await mkdir(path.join(resources, 'mipmap-xxxhdpi'), { recursive: true });
    await copyFile(path.join(TEMPLATE, 'res', 'values', 'styles.xml'), path.join(resources, 'values', 'styles.xml'));
    await writeProjectFiles(webRoot, project.files);
    onProgress(20, 'حقن أصول المشروع المحلية في WebView');
    await writeFile(path.join(assets, 'codexa-entry.txt'), project.entry, 'utf8');
    await writeFile(path.join(assets, 'codexa-network.txt'), project.allowExternalNetwork ? 'true' : 'false', 'utf8');
    await writeFile(path.join(resources, 'mipmap-nodpi', 'ic_launcher.png'), project.iconBytes);
    if (project.iconBytes192) await writeFile(path.join(resources, 'mipmap-xxxhdpi', 'ic_launcher.png'), project.iconBytes192);
    await writeFile(path.join(resources, 'values', 'strings.xml'), `<resources><string name="app_name">${safeXml(project.appName)}</string></resources>`, 'utf8');
    const internetPermission = project.allowExternalNetwork ? '<uses-permission android:name="android.permission.INTERNET" />' : '';
    const manifest = (await readFile(path.join(TEMPLATE, 'AndroidManifest.xml'), 'utf8')).replaceAll('__PACKAGE_ID__', project.packageId).replaceAll('__INTERNET_PERMISSION__', internetPermission);
    await writeFile(path.join(temp, 'AndroidManifest.xml'), manifest, 'utf8');
    await copyFile(DEX, path.join(temp, 'classes.dex'));
    const baseApk = path.join(temp, 'base.apk');
    const alignedApk = path.join(temp, 'aligned.apk');
    const signedApk = path.join(temp, 'codexa.apk');
    const versionCode = String(Math.min(2_000_000_000, Math.floor(Date.now() / 1000)));
    await run(AAPT, ['package', '-f', '-M', path.join(temp, 'AndroidManifest.xml'), '-S', resources, '-A', assets, '-I', PLATFORM_JAR, '--min-sdk-version', '23', '--target-sdk-version', '35', '--version-code', versionCode, '--version-name', '1.0.0', '-F', baseApk], temp);
    await run(AAPT, ['add', baseApk, 'classes.dex'], temp);
    await run(ZIPALIGN, ['-f', '-p', '4', baseApk, alignedApk], temp);
    onProgress(60, 'اكتمل تجهيز هيكل WebView وموارد Android');
    await run(APKSIGNER, ['sign', '--ks', KEYSTORE, '--ks-key-alias', 'codexa', '--ks-pass', 'pass:android', '--key-pass', 'pass:android', '--min-sdk-version', '23', '--v1-signing-enabled', 'true', '--v2-signing-enabled', 'true', '--v3-signing-enabled', 'true', '--out', signedApk, alignedApk], temp);
    onProgress(90, 'اكتمل توقيع حزمة WebView؛ جارٍ التحقق النهائي');
    await run(APKSIGNER, ['verify', '--verbose', '--print-certs', signedApk], temp);
    const { stdout: badging } = await run(AAPT, ['dump', 'badging', signedApk], temp);
    if (!badging.includes(`package: name='${project.packageId}'`) || !badging.includes('application-label:')) throw new Error('بيانات APK لا تطابق معرّف الحزمة أو لم يُنشأ عنوان التطبيق.');
    const result = await readFile(signedApk);
    if (result.length < 4096 || result.subarray(0, 2).toString() !== 'PK') throw new Error('الناتج لا يبدو ملف Android Package صالحاً.');
    onProgress(100, 'اكتمل البناء والتوقيع والتحقق؛ APK جاهز للتنزيل');
    return result;
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

async function serveStatic(req, res) {
  const url = new URL(req.url || '/', 'http://localhost');
  let decoded;
  try { decoded = decodeURIComponent(url.pathname); } catch { replyJson(res, 400, { error: 'مسار غير صالح.' }); return; }
  if (decoded.includes('\\') || decoded.split('/').some((part) => part === '..')) { replyJson(res, 400, { error: 'مسار غير صالح.' }); return; }
  const relative = decoded.replace(/^\/+/, '');
  let target = path.resolve(DIST, relative || 'index.html');
  if (target !== DIST && !target.startsWith(`${DIST}${path.sep}`)) { replyJson(res, 404, { error: 'Not found' }); return; }
  try {
    let info = await stat(target);
    if (info.isDirectory()) { target = path.join(target, 'index.html'); info = await stat(target); }
  } catch {
    if (path.extname(decoded)) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }); res.end('Not found'); return; }
    target = path.join(DIST, 'index.html');
    try { await access(target); } catch { replyJson(res, 503, { error: 'واجهة الإنتاج غير مبنية.' }); return; }
  }
  const type = mimeTypes[path.extname(target).toLowerCase()] || 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': type, 'Content-Length': String((await stat(target)).size), 'Cache-Control': path.basename(target) === 'index.html' ? 'no-cache' : 'public, max-age=0', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'strict-origin-when-cross-origin' });
  if (req.method === 'HEAD') res.end(); else createReadStream(target).pipe(res);
}

const server = createServer(async (req, res) => {
  const pathname = new URL(req.url || '/', 'http://localhost').pathname;
  if (pathname === '/api/health' || pathname === '/_app/health') { replyJson(res, 200, { ok: true, service: 'codexa', apkBuilder: apkReady().length === 0, jobStoreConfigured: Boolean(process.env.DATABASE_URL) }); return; }
  if (pathname === '/api/build/native-apk' && req.method === 'POST') {
    const fetchSite = req.headers['sec-fetch-site'];
    if (fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'none') { replyJson(res, 403, { error: 'يُقبل بناء APK من واجهة CODEXA على المصدر نفسه فقط.' }); return; }
    if (String(req.headers['content-type'] || '').split(';', 1)[0].trim().toLowerCase() !== 'application/json') { replyJson(res, 415, { error: 'يجب إرسال طلب البناء بصيغة JSON.' }); return; }
    if (activeBuild) { replyJson(res, 409, { error: 'يوجد بناء APK جارٍ بالفعل؛ أعد المحاولة بعد اكتماله.' }); return; }
    activeBuild = true;
    let started = false;
    let lockJobId = '';
    try {
      const project = validateNativeProject(await readJson(req));
      if (BUILD_UID === 0 || BUILD_GID === 0) throw Object.assign(new Error('بناء Native Gradle غير مفعّل: يلزم مستخدم بناء غير مميّز، وليس root.'), { status: 503 });
      const missing = nativeBuildToolsMissing({ gradle: GRADLE, sdk: SDK, buildTools: BUILD_TOOLS });
      if (missing.length) throw Object.assign(new Error(`مسار Android Gradle غير جاهز؛ الأدوات الغائبة: ${missing.map((file) => path.basename(file)).join(', ')}.`), { status: 503 });
      const retryAfter = await jobStore.reserveBuildSlot();
      if (retryAfter) {
        res.writeHead(429, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Retry-After': String(retryAfter) });
        res.end(JSON.stringify({ error: 'وصل مسار Gradle إلى حد البناء المؤقت. أعد المحاولة بعد قليل.' }));
        return;
      }
      pruneBuildJobs(nativeBuildJobs, NATIVE_JOB_TTL_MS);
      const job = createNativeBuildJob(randomUUID());
      job.appName = project.appName;
      job.packageId = project.packageId;
      if (!await jobStore.acquireBuildLock(job.id)) { replyJson(res, 409, { error: 'يوجد بناء APK جارٍ في خادم CODEXA؛ أعد المحاولة بعد اكتماله.' }); return; }
      lockJobId = job.id;
      logNativeBuild(job, 'تهيئة مشروع Android المؤقت بعد الموافقة.');
      logNativeBuild(job, 'تم قبول المشروع بعد الموافقة والتحقق من المسارات.');
      nativeBuildJobs.set(job.id, job);
      await flushTaskSave(job, 'native');
      started = true;
      const heartbeat = startTaskHeartbeat(job, 'native');
      void buildNativeApk(project, { gradle: GRADLE, sdk: SDK, buildTools: BUILD_TOOLS, uid: BUILD_UID, gid: BUILD_GID, builderHome: BUILDER_HOME, report: (line) => logNativeBuild(job, line) })
        .then(async (apk) => { job.result = apk; logNativeBuild(job, 'اكتمل البناء والتحقق: الناتج APK حقيقي موقّع بتوقيع Android debug.'); job.status = 'completed'; job.finishedAt = Date.now(); await flushTaskSave(job, 'native'); })
        .catch(async (error) => { job.error = error instanceof Error ? error.message.slice(-12_000) : 'فشل Android Gradle.'; logNativeBuild(job, job.error); job.stage = 'فشل البناء؛ راجع سجل Gradle'; job.status = 'failed'; job.finishedAt = Date.now(); console.error(`[CODEXA Native Gradle] ${Number(error?.status) || 500}: ${job.error}`); await flushTaskSave(job, 'native').catch((storeFailure) => console.error(`[CODEXA task store] ${storeFailure?.code || 'FAILURE_SAVE_FAILED'}`)); })
        .finally(async () => { clearInterval(heartbeat); activeBuild = false; await jobStore.releaseBuildLock(job.id).catch((error) => console.error(`[CODEXA build lease] ${error?.code || 'RELEASE_FAILED'}`)); });
      replyJson(res, 202, { jobId: job.id, status: job.status, statusUrl: `/api/build/native-apk/${job.id}` });
    } catch (error) {
      const status = Number(error?.status) || 500;
      const message = error instanceof Error ? error.message : 'تعذر تهيئة بناء Android Native.';
      console.error(`[CODEXA Native Gradle] ${status}: ${message}`);
      replyJson(res, status, { error: 'تعذر بدء بناء Android Native.', message: status === 500 ? 'حدث خطأ أثناء التحقق من مشروع Android.' : message });
    } finally {
      if (!started) { activeBuild = false; if (lockJobId) await jobStore.releaseBuildLock(lockJobId).catch(() => undefined); }
    }
    return;
  }
  const nativeJobMatch = pathname.match(/^\/api\/build\/native-apk\/([\da-f-]{36})(\/result)?$/i);
  if (nativeJobMatch && req.method === 'GET') {
    try {
      pruneBuildJobs(nativeBuildJobs, NATIVE_JOB_TTL_MS);
      const job = await jobStore.get('native', nativeJobMatch[1], nativeBuildJobs);
      if (!job) { replyJson(res, 404, { error: 'انتهت مدة الاحتفاظ بالمهمة أو لم يتم العثور على معرّفها.' }); return; }
      if (nativeJobMatch[2]) { job.downloadedAt = Date.now(); await sendBuildArtifact(res, job, 'native', 'codexa-native.apk'); return; }
      replyJson(res, 200, { status: job.status, progress: job.progress, stage: job.stage, logs: job.logs, error: job.error || undefined, resultUrl: job.status === 'completed' ? `/api/build/native-apk/${job.id}/result` : undefined, createdAt: job.createdAt, finishedAt: job.finishedAt || undefined, expiresAt: job.expiresAt });
    } catch (error) { const status = Number(error?.status) || 503; replyJson(res, status, { error: error instanceof Error ? error.message : 'تعذر قراءة سجل مهمة Gradle الدائم.' }); }
    return;
  }
  if (pathname === '/api/build/apk' && req.method === 'POST') {
    const fetchSite = req.headers['sec-fetch-site'];
    if (fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'none') { replyJson(res, 403, { error: 'يُقبل بناء APK من واجهة CODEXA على المصدر نفسه فقط.' }); return; }
    if (String(req.headers['content-type'] || '').split(';', 1)[0].trim().toLowerCase() !== 'application/json') { replyJson(res, 415, { error: 'يجب إرسال طلب البناء بصيغة JSON.' }); return; }
    if (activeBuild) { replyJson(res, 409, { error: 'يوجد بناء APK جارٍ بالفعل؛ أعد المحاولة بعد اكتماله.' }); return; }
    activeBuild = true;
    let started = false;
    let lockJobId = '';
    try {
      const body = await readJson(req);
      validateProject(body);
      const retryAfter = await jobStore.reserveBuildSlot();
      if (retryAfter) {
        res.writeHead(429, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Retry-After': String(retryAfter) });
        res.end(JSON.stringify({ error: 'وصلت خدمة البناء إلى حدها المؤقت. أعد المحاولة بعد قليل.' }));
        return;
      }
      pruneBuildJobs(webBuildJobs, WEB_JOB_TTL_MS);
      const job = { id: randomUUID(), track: 'webview', status: 'running', progress: 0, stage: 'تهيئة حزمة WebView السريعة', logs: '', result: null, error: '', appName: body.appName.trim(), packageId: body.packageId, createdAt: Date.now(), finishedAt: 0, downloadedAt: 0 };
      if (!await jobStore.acquireBuildLock(job.id)) { replyJson(res, 409, { error: 'يوجد بناء APK جارٍ في خادم CODEXA؛ أعد المحاولة بعد اكتماله.' }); return; }
      lockJobId = job.id;
      webBuildJobs.set(job.id, job);
      await flushTaskSave(job, 'webview');
      started = true;
      const heartbeat = startTaskHeartbeat(job, 'webview');
      void buildApk(body, (progress, stage) => {
        job.progress = Math.max(job.progress, progress);
        job.stage = stage;
        job.logs = `${job.logs}\n${progress}% · ${stage}`.slice(-200_000);
        queueTaskSave(job, 'webview');
      })
        .then(async (apk) => { job.result = apk; job.progress = 100; job.stage = 'اكتمل البناء والتوقيع والتحقق؛ APK جاهز للمراجعة'; job.status = 'completed'; job.finishedAt = Date.now(); await flushTaskSave(job, 'webview'); })
        .catch(async (error) => { job.error = error instanceof Error ? error.message.slice(-12_000) : 'تعذر بناء APK.'; job.logs = `${job.logs}\n${job.error}`.slice(-200_000); job.stage = 'فشل البناء؛ لم يبدأ التنزيل'; job.status = 'failed'; job.finishedAt = Date.now(); console.error(`[CODEXA APK] ${Number(error?.status) || 500}: ${job.error}`); await flushTaskSave(job, 'webview').catch((storeFailure) => console.error(`[CODEXA task store] ${storeFailure?.code || 'FAILURE_SAVE_FAILED'}`)); })
        .finally(async () => { clearInterval(heartbeat); activeBuild = false; await jobStore.releaseBuildLock(job.id).catch((error) => console.error(`[CODEXA build lease] ${error?.code || 'RELEASE_FAILED'}`)); });
      replyJson(res, 202, { jobId: job.id, status: job.status, statusUrl: `/api/build/apk/${job.id}` });
    } catch (error) {
      const status = Number(error?.status) || 500;
      const message = error instanceof Error ? error.message : 'تعذر بناء APK.';
      console.error(`[CODEXA APK] ${status}: ${message}`);
      replyJson(res, status, { error: 'تعذر إنشاء APK فعلي.', message: status === 500 ? 'فشل بناء Android أو التحقق من التوقيع. لم يبدأ تنزيل ملف.' : message });
    } finally { if (!started) { activeBuild = false; if (lockJobId) await jobStore.releaseBuildLock(lockJobId).catch(() => undefined); } }
    return;
  }
  const webJobMatch = pathname.match(/^\/api\/build\/apk\/([\da-f-]{36})(\/result)?$/i);
  if (webJobMatch && req.method === 'GET') {
    try {
      pruneBuildJobs(webBuildJobs, WEB_JOB_TTL_MS);
      const job = await jobStore.get('webview', webJobMatch[1], webBuildJobs);
      if (!job) { replyJson(res, 404, { error: 'انتهت مدة الاحتفاظ بالمهمة أو لم يتم العثور على معرّفها.' }); return; }
      if (webJobMatch[2]) { job.downloadedAt = Date.now(); await sendBuildArtifact(res, job, 'webview', 'codexa.apk'); return; }
      replyJson(res, 200, { status: job.status, progress: job.progress, stage: job.stage, logs: job.logs, error: job.error || undefined, resultUrl: job.status === 'completed' ? `/api/build/apk/${job.id}/result` : undefined, createdAt: job.createdAt, finishedAt: job.finishedAt || undefined, expiresAt: job.expiresAt });
    } catch (error) { const status = Number(error?.status) || 503; replyJson(res, status, { error: error instanceof Error ? error.message : 'تعذر قراءة سجل مهمة WebView الدائم.' }); }
    return;
  }
  if (pathname.startsWith('/api/')) { replyJson(res, 404, { error: 'API غير موجود.' }); return; }
  if (PROD) { await serveStatic(req, res); return; }
  if (vite) {
    vite.middlewares(req, res, (error) => {
      if (error) { console.error(error); if (!res.headersSent) replyJson(res, 500, { error: 'خطأ في خادم التطوير.' }); }
    });
    return;
  }
  replyJson(res, 503, { error: 'خادم التطوير لم يجهز بعد.' });
});

if (!PROD) {
  const { createServer: createViteServer } = await import('vite');
  vite = await createViteServer({ configFile: path.join(ROOT, 'vite.config.ts'), server: { middlewareMode: true, hmr: { server } }, appType: 'spa' });
}

server.listen(PORT, '0.0.0.0', () => console.log(`CODEXA ${PROD ? 'production' : 'development'} server listening on 0.0.0.0:${PORT}`));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(async () => { await vite?.close(); await jobStore.close(); process.exit(0); }));
