import { randomUUID } from 'node:crypto';
import { access, mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';

const JOB_TTL_MS = 15 * 60_000;
const BUILD_WINDOW_MS = 60_000;
const MAX_BUILDS_PER_WINDOW = 6;
const STALE_WORKER_MS = 45_000;
const LOCK_LEASE_MS = 5 * 60_000;
const VALID_TRACKS = new Set(['native', 'webview']);

function storeError(message = 'تعذر الاتصال بمخزن مهام APK. حدث خطأ في الخادم.') {
  return Object.assign(new Error(message), { status: 503 });
}

function safeTrack(track) {
  if (!VALID_TRACKS.has(track)) throw storeError('مسار مهمة البناء غير معروف.');
  return track;
}

function safeId(id) {
  if (typeof id !== 'string' || !/^[\da-f-]{36}$/i.test(id)) throw storeError('معرّف مهمة البناء غير صالح.');
  return id.toLowerCase();
}

function asTime(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

// مخزن الذاكرة المحلي للوظائف وأقفال التزامن
const memoryJobs = new Map();
let currentLock = {
  jobId: '',
  workerId: '',
  expiresAt: 0,
};

export class BuildJobStore {
  constructor({ databaseUrl = process.env.DATABASE_URL, artifactDirectory = path.join(tmpdir(), 'codexa-apk-results') } = {}) {
    this.databaseUrl = databaseUrl;
    this.artifactDirectory = path.resolve(artifactDirectory);
    this.workerId = randomUUID();
    this.readyPromise = null;
  }

  async ensureReady() {
    if (!this.readyPromise) {
      this.readyPromise = (async () => {
        await mkdir(this.artifactDirectory, { recursive: true, mode: 0o700 });
        await this.pruneExpired();
      })();
    }
    await this.readyPromise;
  }

  artifactPath(track, id) {
    const normalizedTrack = safeTrack(track);
    const normalizedId = safeId(id);
    return path.join(this.artifactDirectory, normalizedTrack, `${normalizedId}.apk`);
  }

  artifactKey(track, id) {
    return `${safeTrack(track)}/${safeId(id)}.apk`;
  }

  #pathFromKey(track, id, key) {
    if (key !== this.artifactKey(track, id)) return '';
    return this.artifactPath(track, id);
  }

  async persist(job, track = job.track) {
    await this.ensureReady();
    const normalizedTrack = safeTrack(track);
    const id = safeId(job.id);
    const now = Date.now();
    job.track = normalizedTrack;
    job.workerId = job.workerId || this.workerId;
    job.updatedAt = now;

    if (Buffer.isBuffer(job.result)) {
      if (job.result.length < 4096 || job.result.length > 120 * 1024 * 1024) throw storeError('حجم APK غير صالح للتخزين المؤقت.');
      const target = this.artifactPath(normalizedTrack, id);
      const directory = path.dirname(target);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const temporary = `${target}.tmp-${randomUUID()}`;
      await writeFile(temporary, job.result, { mode: 0o600, flag: 'wx' });
      await rename(temporary, target);
      job.artifactKey = this.artifactKey(normalizedTrack, id);
      job.artifactPath = target;
      job.resultAvailable = true;
      job.result = null;
    }

    const expiresAt = (job.finishedAt || now) + JOB_TTL_MS;
    job.expiresAt = expiresAt;

    const storedData = {
      id,
      track: normalizedTrack,
      status: job.status,
      progress: Math.max(0, Math.min(100, Number(job.progress) || 0)),
      stage: String(job.stage || '').slice(0, 255),
      logs: String(job.logs || '').slice(-200_000),
      error_message: job.error ? String(job.error).slice(-12_000) : null,
      app_name: String(job.appName || 'CODEXA').slice(0, 64),
      package_id: String(job.packageId || '').slice(0, 255),
      artifact_key: job.artifactKey || null,
      worker_id: job.workerId,
      created_at: asTime(job.createdAt) || now,
      updated_at: now,
      finished_at: job.finishedAt || null,
      expires_at: expiresAt,
    };

    memoryJobs.set(id, storedData);
    job.localOwner = job.workerId === this.workerId;
    return job;
  }

  async get(track, id, cache) {
    await this.ensureReady();
    const normalizedTrack = safeTrack(track);
    const normalizedId = safeId(id);
    const local = cache.get(normalizedId);

    const row = memoryJobs.get(normalizedId);
    if (!row || row.track !== normalizedTrack || row.expires_at <= Date.now()) {
      return null;
    }

    const preferLocal = Boolean(local?.localOwner && local.workerId === this.workerId && local.updatedAt >= asTime(row.updated_at));
    const job = preferLocal ? local : (local || {});
    if (!preferLocal) {
      Object.assign(job, {
        id: row.id,
        track: row.track,
        status: row.status,
        progress: Number(row.progress) || 0,
        stage: row.stage || '',
        logs: row.logs || '',
        error: row.error_message || '',
        appName: row.app_name || 'CODEXA',
        packageId: row.package_id || '',
        artifactKey: row.artifact_key || '',
        artifactPath: row.artifact_key ? this.#pathFromKey(normalizedTrack, normalizedId, row.artifact_key) : '',
        result: null,
        resultAvailable: Boolean(row.artifact_key),
        workerId: row.worker_id || '',
        localOwner: false,
        createdAt: asTime(row.created_at),
        updatedAt: asTime(row.updated_at),
        finishedAt: asTime(row.finished_at),
        expiresAt: asTime(row.expires_at),
        downloadedAt: 0,
      });
    }
    cache.set(normalizedId, job);

    if (job.status === 'running' && Date.now() - job.updatedAt > STALE_WORKER_MS) {
      job.status = 'failed';
      job.finishedAt = Date.now();
      job.stage = 'توقفت عملية البناء؛ استُعيد سجل المهمة من الذاكرة المحلية';
      job.error = 'توقف نبض عامل البناء بعد آخر سجل محفوظ. أعد المحاولة.';
      job.logs = `${job.logs}\n[CODEXA] ${job.error}`.slice(-200_000);
      await this.persist(job, normalizedTrack);
      await this.releaseBuildLock(job.id).catch(() => undefined);
    }

    if (job.status === 'completed') {
      if (!job.artifactKey || !job.artifactPath) {
        job.status = 'failed';
        job.error = 'اكتمل البناء لكن ملف APK المؤقت غير متاح؛ لم يبدأ التنزيل. أعد المحاولة.';
      } else {
        try {
          await access(job.artifactPath);
        } catch {
          job.status = 'failed';
          job.error = 'أُعيد تشغيل الخادم وملف APK المؤقت لم يعد متاحاً. أعد البناء مجدداً.';
        }
      }
      if (job.status === 'failed') {
        job.finishedAt = Date.now();
        job.stage = 'فُقد ملف APK المؤقت؛ يلزم بناء جديد';
        job.logs = `${job.logs}\n[CODEXA] ${job.error}`.slice(-200_000);
        await this.persist(job, normalizedTrack);
      }
    }
    return job;
  }

  async reserveBuildSlot() {
    await this.ensureReady();
    const now = Date.now();
    await this.pruneExpired();
    
    const recentBuilds = Array.from(memoryJobs.values())
      .filter((j) => j.created_at > now - BUILD_WINDOW_MS)
      .sort((a, b) => a.created_at - b.created_at);

    if (recentBuilds.length < MAX_BUILDS_PER_WINDOW) return 0;
    return Math.max(1, Math.ceil((Number(recentBuilds[0].created_at) + BUILD_WINDOW_MS - now) / 1000));
  }

  async acquireBuildLock(jobId) {
    await this.ensureReady();
    const id = safeId(jobId);
    const now = Date.now();

    if (currentLock.jobId && currentLock.expiresAt > now) {
      const active = memoryJobs.get(currentLock.jobId);
      const activeIsStale = !active || (active.status !== 'running' && active.status !== 'queued') || now - asTime(active.updated_at) > STALE_WORKER_MS;
      if (!activeIsStale) {
        return false;
      }
    }

    currentLock = {
      jobId: id,
      workerId: this.workerId,
      expiresAt: now + LOCK_LEASE_MS,
    };
    return true;
  }

  async renewBuildLock(jobId) {
    await this.ensureReady();
    if (currentLock.jobId === safeId(jobId) && currentLock.workerId === this.workerId) {
      currentLock.expiresAt = Date.now() + LOCK_LEASE_MS;
    }
  }

  async releaseBuildLock(jobId) {
    if (currentLock.jobId === safeId(jobId) && currentLock.workerId === this.workerId) {
      currentLock = { jobId: '', workerId: '', expiresAt: 0 };
    }
  }

  async pruneExpired() {
    const now = Date.now();
    for (const [id, row] of memoryJobs.entries()) {
      if (row.expires_at <= now) {
        memoryJobs.delete(id);
        if (row.artifact_key && row.artifact_key === this.artifactKey(row.track, row.id)) {
          await rm(this.artifactPath(row.track, row.id), { force: true }).catch(() => undefined);
        }
      }
    }
  }

  async close() {
    this.readyPromise = null;
  }
}
