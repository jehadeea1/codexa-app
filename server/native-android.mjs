import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chown, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

const MAX_PROJECT_BYTES = 20 * 1024 * 1024;
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_FILES = 500;
const MAX_LOG_BYTES = 40_000;
const BUILD_TIMEOUT_MS = 240_000;
const ANDROID_NS = 'http://schemas.android.com/apk/res/android';

function failure(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

function isForbiddenSegment(segment) {
  const value = segment.toLowerCase();
  return value === '.npmrc' || value === '.git' || value === '.ssh' || value === '.codexa-folder' || value === '.env' || (value.startsWith('.env.') && value !== '.env.example');
}

function validateIcon(value, expectedSize = 512) {
  if (typeof value !== 'string') throw failure('أيقونة التطبيق غير موجودة.');
  const match = value.match(/^data:image\/png;base64,([A-Za-z0-9+/=\r\n]+)$/);
  if (!match) throw failure('يجب أن تكون أيقونة التطبيق صورة PNG صالحة.');
  const bytes = Buffer.from(match[1], 'base64');
  if (bytes.length < 80 || bytes.length > 2 * 1024 * 1024 || bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' || bytes.readUInt32BE(16) !== expectedSize || bytes.readUInt32BE(20) !== expectedSize) throw failure(`يجب أن تكون أيقونة PNG مربعة بقياس ${expectedSize}×${expectedSize}.`);
  return bytes;
}

export function validateNativeProject(input) {
  if (!input || input.consent !== true) throw failure('لم تصل موافقة صريحة على إرسال ملفات المشروع. ', 403);
  if (typeof input.projectId !== 'string' || input.projectId.length < 1 || input.projectId.length > 120) throw failure('معرّف المشروع غير صالح.');
  if (typeof input.appName !== 'string' || !input.appName.trim() || input.appName.length > 32 || /[\u0000-\u001f\u007f]/.test(input.appName)) throw failure('اسم التطبيق غير صالح (الحد الأقصى 32 حرفاً).');
  if (typeof input.packageId !== 'string' || !/^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*){1,6}$/.test(input.packageId)) throw failure('معرّف حزمة Android غير صالح.');
  if (!Array.isArray(input.files) || input.files.length < 1 || input.files.length > MAX_FILES) throw failure(`يجب أن يحتوي المشروع من ملف واحد إلى ${MAX_FILES} ملفاً.`);

  const seen = new Set();
  let total = 0;
  let sourceCount = 0;
  const files = [];
  for (const file of input.files) {
    if (!file || typeof file.path !== 'string' || typeof file.content !== 'string') throw failure('أحد ملفات المشروع غير صالح.');
    const name = file.path.replaceAll('\\', '/');
    const parts = name.split('/');
    if (!name || name.length > 240 || name.startsWith('/') || name.includes(':') || parts.some((part) => !part || part.length > 120 || part === '.' || part === '..' || isForbiddenSegment(part)) || /\.(?:jks|keystore|p12|pfx|pem|key|crt)$/i.test(name)) throw failure(`مسار الملف غير آمن: ${name.slice(0, 80)}`);
    if (seen.has(name)) throw failure(`المسار مكرر داخل المشروع: ${name}`);
    for (const existing of seen) {
      if (name.startsWith(`${existing}/`) || existing.startsWith(`${name}/`)) throw failure(`يتعارض ملف مع مسار مجلد: ${name.slice(0, 80)} ↔ ${existing.slice(0, 80)}`);
    }
    seen.add(name);
    const bytes = Buffer.byteLength(file.content, 'utf8');
    if (bytes > MAX_FILE_BYTES) throw failure(`الملف ${name} أكبر من الحد المسموح.`, 413);
    total += bytes;
    if (total > MAX_PROJECT_BYTES) throw failure('الحجم الإجمالي لملفات المشروع يتجاوز 20 ميغابايت.', 413);
    if (/\.(?:kt|java)$/i.test(name)) sourceCount += 1;
    files.push({ path: name, content: file.content });
  }
  if (sourceCount === 0) throw failure('مسار Gradle الأصلي يتطلب ملف Kotlin (.kt) أو Java (.java) واحداً على الأقل.');
  return {
    projectId: input.projectId,
    appName: input.appName.trim(),
    packageId: input.packageId,
    allowExternalNetwork: input.allowExternalNetwork === true,
    files,
    iconBytes: validateIcon(input.iconPng),
    iconBytes192: typeof input.iconPng192 === 'string' ? validateIcon(input.iconPng192, 192) : null,
  };
}

function safeXml(value) {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}

function safeJavaString(value) {
  return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\n', '\\n').replaceAll('\r', '\\r');
}

function packageForSource(content) {
  const value = content.match(/^\s*package\s+([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*;?/m)?.[1];
  return value && /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/.test(value) ? value : '';
}

function detectLauncher(files) {
  for (const file of files) {
    const base = path.posix.basename(file.path);
    if (!/^MainActivity\.(?:java|kt)$/i.test(base)) continue;
    const source = file.content;
    const valid = /\.java$/i.test(base)
      ? /\bclass\s+MainActivity\s+extends\s+(?:android\.app\.)?Activity\b/.test(source)
      : /\bclass\s+MainActivity\b[\s\S]{0,240}?\s:\s*(?:android\.app\.)?Activity\s*\(/.test(source);
    if (!valid) continue;
    const packageName = packageForSource(source);
    return { className: packageName ? `${packageName}.MainActivity` : 'MainActivity' };
  }
  return null;
}

function sourceRelativePath(value, content) {
  const normalized = value.replaceAll('\\', '/');
  const declaredPackage = packageForSource(content);
  if (declaredPackage) return `${declaredPackage.replaceAll('.', '/')}/${path.posix.basename(normalized)}`;
  const match = normalized.match(/(?:^|\/)(?:(?:app\/)?src\/main\/(?:java|kotlin))\/(.+)$/i);
  const relative = match?.[1] ?? `codexa-imported/${normalized}`;
  if (relative.split('/').some((part) => !part || part === '.' || part === '..')) throw failure(`مسار مصدر غير صالح: ${value.slice(0, 80)}`);
  return relative;
}

function resourceRelativePath(value, kind) {
  const normalized = value.replaceAll('\\', '/');
  const pattern = kind === 'res'
    ? /(?:^|\/)(?:(?:app\/)?src\/main\/)?res\/(.+)$/i
    : /(?:^|\/)(?:(?:app\/)?src\/main\/)?assets\/(.+)$/i;
  const match = normalized.match(pattern);
  if (!match) return null;
  if (match[1].split('/').some((part) => !part || part === '.' || part === '..')) throw failure(`مسار مورد Android غير صالح: ${value.slice(0, 80)}`);
  return match[1];
}

function decodeAndroidAsset(value, sourcePath) {
  const match = value.match(/^data:([a-z0-9.+/-]+);base64,([A-Za-z0-9+/=\r\n]+)$/i);
  if (!match) return Buffer.from(value, 'utf8');
  const allowed = /^(?:image\/(?:png|jpeg|jpg|gif|webp|avif)|audio\/[a-z0-9.+-]+|video\/[a-z0-9.+-]+|application\/octet-stream)$/i;
  if (!allowed.test(match[1])) throw failure(`نوع مورد Android غير مسموح: ${sourcePath}`);
  return Buffer.from(match[2], 'base64');
}

function extractPermissions(files) {
  const permissions = new Set();
  for (const file of files) {
    if (!/(?:^|\/)AndroidManifest\.xml$/i.test(file.path)) continue;
    const matches = file.content.matchAll(/<uses-permission(?:-sdk-23)?\b[^>]*\bandroid:name\s*=\s*["'](android\.permission\.[A-Z0-9_.]+)["'][^>]*\/?\s*>/g);
    for (const match of matches) permissions.add(match[1]);
  }
  return [...permissions].sort();
}

function generatedActivity(project) {
  const title = safeJavaString(project.appName);
  const names = project.files.filter((file) => /\.(?:kt|java)$/i.test(file.path)).map((file) => path.posix.basename(file.path)).slice(0, 24);
  const items = names.map((name) => `addRow(root, "${safeJavaString(name)}");`).join('\n        ');
  return `package dev.codexa.generated;\n\nimport android.app.Activity;\nimport android.os.Bundle;\nimport android.view.Gravity;\nimport android.widget.LinearLayout;\nimport android.widget.TextView;\n\npublic final class CodexaDashboardActivity extends Activity {\n  @Override public void onCreate(Bundle state) {\n    super.onCreate(state);\n    try { int layout = getResources().getIdentifier("activity_main", "layout", getPackageName()); if (layout != 0) { setContentView(layout); return; } } catch (RuntimeException ignored) { }\n    LinearLayout root = new LinearLayout(this); root.setOrientation(LinearLayout.VERTICAL); root.setGravity(Gravity.CENTER_VERTICAL); root.setPadding(32, 32, 32, 32); root.setBackgroundColor(0xFFF4F6F0);\n    TextView brand = new TextView(this); brand.setText("CODEXA · NATIVE ANDROID"); brand.setTextColor(0xFF507C32); brand.setTextSize(12); root.addView(brand);\n    TextView title = new TextView(this); title.setText("${title}"); title.setTextColor(0xFF1B2319); title.setTextSize(26); title.setPadding(0, 14, 0, 6); root.addView(title);\n    TextView note = new TextView(this); note.setText("تم تجميع هذا التطبيق بواسطة Android Gradle. ملفات المصدر المدرجة أدناه موجودة داخل الحزمة ولا يعني ذلك أنها جميعاً واجهات تشغيلية."); note.setTextColor(0xFF586253); note.setTextSize(14); root.addView(note);\n    ${items}\n    setContentView(root);\n  }\n  private void addRow(LinearLayout root, String name) { TextView row = new TextView(this); row.setText("•  " + name); row.setTextColor(0xFF30382D); row.setTextSize(13); row.setPadding(0, 12, 0, 0); root.addView(row); }\n}\n`;
}

async function writePath(root, relative, value, mode = 0o644) {
  const destination = path.resolve(root, relative);
  if (!destination.startsWith(`${path.resolve(root)}${path.sep}`)) throw failure('مسار خارج مجلد مشروع Android المؤقت.');
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, value, { mode, flag: 'wx' });
}

async function writeNativeProject(root, project, report) {
  const appRoot = path.join(root, 'app');
  await mkdir(appRoot, { recursive: true });
  await writePath(root, 'settings.gradle', `pluginManagement { repositories { google(); mavenCentral(); gradlePluginPortal() } }\ndependencyResolutionManagement { repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS); repositories { google(); mavenCentral() } }\nrootProject.name = 'CODEXA-Native'\ninclude ':app'\n`);
  await writePath(root, 'build.gradle', `plugins {\n    id 'com.android.application' version '8.6.1' apply false\n    id 'org.jetbrains.kotlin.android' version '2.0.20' apply false\n}\n`);
  await writePath(root, 'gradle.properties', `org.gradle.jvmargs=-Xmx2048m -Dfile.encoding=UTF-8\norg.gradle.parallel=false\norg.gradle.caching=true\nandroid.useAndroidX=true\n`);
  const hasKotlin = project.files.some((file) => /\.kt$/i.test(file.path));
  const appGradle = `plugins {\n    id 'com.android.application'\n    ${hasKotlin ? "id 'org.jetbrains.kotlin.android'" : '// Java-only project'}\n}\n\nandroid {\n    namespace '${project.packageId}'\n    compileSdk 35\n    defaultConfig {\n        applicationId '${project.packageId}'\n        minSdk 23\n        targetSdk 35\n        versionCode 1\n        versionName '1.0.0'\n    }\n    compileOptions { sourceCompatibility JavaVersion.VERSION_1_8; targetCompatibility JavaVersion.VERSION_1_8 }\n    ${hasKotlin ? 'kotlinOptions { jvmTarget = \'1.8\' }' : ''}\n}\n`;
  await writePath(root, 'app/build.gradle', appGradle.replace('compileSdk 35', "compileSdk 35\n    buildToolsVersion '35.0.0'"));

  const sourceTargets = new Set();
  for (const file of project.files.filter((item) => /\.(?:kt|java)$/i.test(item.path))) {
    const relative = sourceRelativePath(file.path, file.content);
    if (sourceTargets.has(relative)) throw failure(`تكرر اسم/مسار مصدر Java أو Kotlin بعد تطبيعه: ${relative}`);
    sourceTargets.add(relative);
    await writePath(root, `app/src/main/java/${relative}`, file.content);
  }

  const resourceTargets = new Set();
  for (const file of project.files) {
    const resPath = resourceRelativePath(file.path, 'res');
    const assetPath = resourceRelativePath(file.path, 'assets');
    if (resPath) {
      if (resourceTargets.has(`res/${resPath}`)) throw failure(`تكرر مورد Android بعد تطبيعه: ${resPath}`);
      resourceTargets.add(`res/${resPath}`);
      await writePath(root, `app/src/main/res/${resPath}`, decodeAndroidAsset(file.content, file.path));
    } else if (assetPath) {
      if (resourceTargets.has(`assets/${assetPath}`)) throw failure(`تكرر أصل Android بعد تطبيعه: ${assetPath}`);
      resourceTargets.add(`assets/${assetPath}`);
      await writePath(root, `app/src/main/assets/${assetPath}`, decodeAndroidAsset(file.content, file.path));
    }
  }

  await writePath(root, 'app/src/main/res/mipmap-nodpi/ic_codexa.png', project.iconBytes);
  if (project.iconBytes192) await writePath(root, 'app/src/main/res/mipmap-xxxhdpi/ic_codexa.png', project.iconBytes192);
  await writePath(root, 'app/src/main/res/values/codexa_strings.xml', `<resources><string name="app_name">${safeXml(project.appName)}</string></resources>\n`);
  const launcher = detectLauncher(project.files);
  const activityClass = launcher?.className ?? 'dev.codexa.generated.CodexaDashboardActivity';
  if (!launcher) await writePath(root, 'app/src/main/java/dev/codexa/generated/CodexaDashboardActivity.java', generatedActivity(project));
  const permissions = extractPermissions(project.files).map((name) => `<uses-permission android:name="${safeXml(name)}" />`).join('\n    ');
  const internet = project.allowExternalNetwork ? '<uses-permission android:name="android.permission.INTERNET" />' : '';
  const manifest = `<?xml version="1.0" encoding="utf-8"?>\n<manifest xmlns:android="${ANDROID_NS}">\n    ${[...new Set([internet, ...permissions].filter(Boolean))].join('\n    ')}\n    <application android:allowBackup="false" android:icon="@mipmap/ic_codexa" android:label="@string/app_name" android:theme="@android:style/Theme.Material.Light.NoActionBar" android:usesCleartextTraffic="false">\n        <activity android:name="${safeXml(activityClass)}" android:exported="true">\n            <intent-filter><action android:name="android.intent.action.MAIN" /><category android:name="android.intent.category.LAUNCHER" /></intent-filter>\n        </activity>\n    </application>\n</manifest>\n`;
  await writePath(root, 'app/src/main/AndroidManifest.xml', manifest);
  report('اكتمل إنشاء هيكل Android مؤقت: المصادر وموارد res المحلية ضمن قالب CODEXA مضبوط.');
}

async function chownTree(root, uid, gid) {
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const target = path.join(root, entry.name);
    if (entry.isSymbolicLink()) throw failure('رفض بناء Android بسبب رابط رمزي داخل مجلد العمل المؤقت.');
    if (entry.isDirectory()) await chownTree(target, uid, gid);
    await chown(target, uid, gid);
  }
  await chown(root, uid, gid);
}

function appendLimited(current, chunk) {
  return (current + chunk.toString()).slice(-MAX_LOG_BYTES);
}

function runGradle(gradle, args, cwd, { uid, gid, home, sdk, report }) {
  return new Promise((resolve, reject) => {
    const javaHome = process.env.JAVA_HOME || '/usr/lib/jvm/java-17-openjdk-amd64';
    const env = {
      PATH: `/opt/gradle/bin:${javaHome}/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`,
      HOME: home,
      USER: 'codexa-builder',
      LANG: 'C.UTF-8',
      JAVA_HOME: javaHome,
      ANDROID_HOME: sdk,
      ANDROID_SDK_ROOT: sdk,
      GRADLE_USER_HOME: path.join(home, '.gradle'),
      CI: 'true',
    };
    const options = { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true };
    if (Number.isInteger(uid) && Number.isInteger(gid)) { options.uid = uid; options.gid = gid; }
    const child = spawn(gradle, args, options);
    let output = '';
    let settled = false;
    const emit = (chunk) => {
      output = appendLimited(output, chunk);
      const recent = chunk.toString().split(/\r?\n/).filter(Boolean).slice(-4).join(' · ');
      if (recent) report(recent.slice(-1800));
    };
    child.stdout.on('data', emit);
    child.stderr.on('data', emit);
    const killGroup = (signal) => {
      try { if (child.pid) process.kill(-child.pid, signal); else child.kill(signal); } catch { child.kill(signal); }
    };
    const timer = setTimeout(() => {
      settled = true; killGroup('SIGTERM');
      setTimeout(() => killGroup('SIGKILL'), 1500).unref();
      reject(failure(`تجاوز بناء Gradle المهلة المحددة (${Math.round(BUILD_TIMEOUT_MS / 1000)} ثانية). لم يُنتج APK.\n${output.slice(-6000)}`, 504));
    }, BUILD_TIMEOUT_MS);
    child.on('error', (error) => {
      clearTimeout(timer);
      if (!settled) { settled = true; reject(failure(`تعذر تشغيل Gradle: ${error.message}`, 503)); }
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      if (code !== 0) reject(failure(`فشل Android Gradle${signal ? ` (${signal})` : ` برمز ${code}`}.\n${output.slice(-8000)}`, 422));
      else resolve(output);
    });
  });
}

function runTool(command, args, cwd, timeout = 30_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (chunk) => { stdout = appendLimited(stdout, chunk); });
    child.stderr.on('data', (chunk) => { stderr = appendLimited(stderr, chunk); });
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(failure(`انتهت مهلة أداة Android: ${path.basename(command)}`, 504)); }, timeout);
    child.on('error', (error) => { clearTimeout(timer); reject(failure(`تعذر تشغيل ${path.basename(command)}: ${error.message}`, 503)); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) reject(failure(`${path.basename(command)} exit ${code}: ${(stderr || stdout).trim().slice(-5000)}`, 422));
      else resolve({ stdout, stderr });
    });
  });
}

export function nativeBuildToolsMissing({ gradle, sdk, buildTools }) {
  return [gradle, path.join(sdk, 'platforms', 'android-35', 'android.jar'), path.join(buildTools, 'aapt'), path.join(buildTools, 'apksigner')].filter((value) => !value || !existsSync(value));
}

export async function buildNativeApk(project, options) {
  const { gradle, sdk, buildTools, uid, gid, builderHome, report = () => undefined } = options;
  const missing = nativeBuildToolsMissing({ gradle, sdk, buildTools });
  if (missing.length) throw failure('مسار Native Gradle غير جاهز: يلزم JDK 17 وGradle وAndroid SDK 35 وBuild Tools 35.0.0.', 503);
  if (uid === 0 || gid === 0) throw failure('رفض تشغيل Gradle بصلاحية root؛ اضبط CODEXA_BUILD_UID وCODEXA_BUILD_GID لمستخدم بناء غير مميز.', 503);

  const temp = await mkdtemp(path.join(tmpdir(), 'codexa-native-'));
  try {
    report('فحص ملفات Java/Kotlin/XML وإعداد مساحة بناء مؤقتة بعد الموافقة.');
    await writeNativeProject(temp, project, report);
    await mkdir(path.join(builderHome, '.gradle'), { recursive: true });
    await chownTree(temp, uid, gid);
    report('يبدأ Gradle الآن ببناء التطبيق وإحضار إضافات Android المطلوبة عند أول تشغيل.');
    await runGradle(gradle, ['--no-daemon', '--console=plain', '--stacktrace', ':app:assembleDebug'], temp, { uid, gid, home: builderHome, sdk, report });
    report('اكتمل التجميع؛ تحزيم الموارد جارٍ التحقق منه.');
    const apkPath = path.join(temp, 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk');
    const info = await stat(apkPath).catch(() => null);
    if (!info || info.size < 4096 || info.size > 120 * 1024 * 1024) throw failure('لم ينتج Gradle ملف APK صالح الحجم.');
    const apksigner = path.join(buildTools, 'apksigner');
    const aapt = path.join(buildTools, 'aapt');
    report('بدأ توقيع apksigner والتحقق من شهادة APK.');
    await runTool(apksigner, ['verify', '--verbose', '--print-certs', apkPath], temp);
    const { stdout: badging } = await runTool(aapt, ['dump', 'badging', apkPath], temp);
    if (!badging.includes(`package: name='${project.packageId}'`) || !badging.includes('application-label:')) throw failure('بيانات APK لا تطابق معرّف الحزمة أو لم يظهر اسم التطبيق.');
    const result = await readFile(apkPath);
    if (result.subarray(0, 2).toString() !== 'PK') throw failure('الناتج لا يبدو حزمة Android APK فعلية.');
    report('اكتمل البناء والتحقق: الناتج APK حقيقي موقّع بتوقيع Android debug.');
    return result;
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

export function createNativeBuildJob(id = randomUUID()) {
  return { id, status: 'running', progress: 0, stage: 'تهيئة مشروع Android الأصلي', logs: '', result: null, error: '', createdAt: Date.now(), finishedAt: 0, downloadedAt: 0 };
}
