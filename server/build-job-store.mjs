import mysql from 'mysql2/promise';
import { randomUUID } from 'node:crypto';
import { access, mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';

const JOB_TABLE = 'codexa_build_jobs';
const LOCK_TABLE = 'codexa_build_locks';
const JOB_TTL_MS = 15 * 60_000;
const BUILD_WINDOW_MS = 60_000;
const MAX_BUILDS_PER_WINDOW = 6;
const STALE_WORKER_MS = 45_000;
const LOCK_LEASE_MS = 5 * 60_000;
const VALID_TRACKS = new Set(['native', 'webview']);

function storeError(message = 'تعذر الاتصال بمخزن مهام APK الدائم. لم يبدأ البناء.') {
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

export class BuildJobStore {
  constructor({ databaseUrl = process.env.DATABASE_URL, artifactDirectory = path.join(tmpdir(), 'codexa-apk-results') } = {}) {
    this.databaseUrl = databaseUrl;
    this.artifactDirectory = path.resolve(artifactDirectory);
    this.workerId = randomUUID();
    this.pool = null;
    this.readyPromise = null;
  }

  async ensureReady() {
    if (!this.databaseUrl) throw storeError('قاعدة تخزين مهام APK غير مهيّأة في هذه البيئة. لم يبدأ البناء.');
    if (!this.pool) this.pool = mysql.createPool(this.databaseUrl);
    if (!this.readyPromise) {
      this.readyPromise = this.#createSchema().catch((error) => {
        this.readyPromise = null;
        const normalized = storeError();
        normalized.code = error?.code || 'TASK_STORE_UNAVAILABLE';
        throw normalized;
      });
    }
    await this.readyPromise;
  }

  async #createSchema() {
    await this.pool.query(`CREATE TABLE IF NOT EXISTS ${JOB_TABLE} (
      id CHAR(36) NOT NULL PRIMARY KEY,
      track VARCHAR(16) NOT NULL,
      status VARCHAR(16) NOT NULL,
      progress TINYINT UNSIGNED NOT NULL DEFAULT 0,
      stage VARCHAR(255) NOT NULL DEFAULT '',
      logs MEDIUMTEXT NOT NULL,
      error_message TEXT NULL,
      app_name VARCHAR(64) NOT NULL,
      package_id VARCHAR(255) NOT NULL,
      artifact_key VARCHAR(128) NULL,
      worker_id CHAR(36) NOT NULL,
      created_at BIGINT UNSIGNED NOT NULL,
      updated_at BIGINT UNSIGNED NOT NULL,
      finished_at BIGINT UNSIGNED NULL,
      expires_at BIGINT UNSIGNED NOT NULL,
      INDEX idx_codexa_build_expiry (expires_at),
      INDEX idx_codexa_build_created (created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
    await this.pool.query(`CREATE TABLE IF NOT EXISTS ${LOCK_TABLE} (
      lock_id TINYINT UNSIGNED NOT NULL PRIMARY KEY,
      job_id CHAR(36) NOT NULL DEFAULT '',
      worker_id CHAR(36) NOT NULL DEFAULT '',
      expires_at BIGINT UNSIGNED NOT NULL DEFAULT 0
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
    await this.pool.execute(`INSERT IGNORE INTO ${LOCK_TABLE} (lock_id, job_id, worker_id, expires_at) VALUES (1, '', '', 0)`);
    await mkdir(this.artifactDirectory, { recursive: true, mode: 0o700 });
    await this.pruneExpired();
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
    const values = [
      id, normalizedTrack, job.status, Math.max(0, Math.min(100, Number(job.progress) || 0)),
      String(job.stage || '').slice(0, 255), String(job.logs || '').slice(-200_000), job.error ? String(job.error).slice(-12_000) : null,
      String(job.appName || 'CODEXA').slice(0, 64), String(job.packageId || '').slice(0, 255),
      job.artifactKey || null, job.workerId, asTime(job.createdAt) || now, now, job.finishedAt || null, expiresAt,
    ];
    try {
      await this.pool.execute(`INSERT INTO ${JOB_TABLE}
        (id, track, status, progress, stage, logs, error_message, app_name, package_id, artifact_key, worker_id, created_at, updated_at, finished_at, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE status=VALUES(status), progress=VALUES(progress), stage=VALUES(stage), logs=VALUES(logs),
        error_message=VALUES(error_message), app_name=VALUES(app_name), package_id=VALUES(package_id),
        artifact_key=COALESCE(VALUES(artifact_key), artifact_key), worker_id=VALUES(worker_id), updated_at=VALUES(updated_at),
        finished_at=VALUES(finished_at), expires_at=VALUES(expires_at)`, values);
      job.localOwner = job.workerId === this.workerId;
    } catch (error) {
      const normalized = storeError();
      normalized.code = error?.code || 'TASK_STORE_WRITE_FAILED';
      throw normalized;
    }
    return job;
  }

  async get(track, id, cache) {
    await this.ensureReady();
    const normalizedTrack = safeTrack(track);
    const normalizedId = safeId(id);
    const local = cache.get(normalizedId);

    let rows;
    try {
      [rows] = await this.pool.execute(`SELECT id, track, status, progress, stage, logs, error_message,
        app_name, package_id, artifact_key, worker_id, created_at, updated_at, finished_at, expires_at
        FROM ${JOB_TABLE} WHERE id = ? AND track = ? AND expires_at > ? LIMIT 1`, [normalizedId, normalizedTrack, Date.now()]);
    } catch (error) {
      const normalized = storeError();
      normalized.code = error?.code || 'TASK_STORE_READ_FAILED';
      throw normalized;
    }
    if (!rows.length) return null;
    const row = rows[0];
    const preferLocal = Boolean(local?.localOwner && local.workerId === this.workerId && local.updatedAt >= asTime(row.updated_at));
    const job = preferLocal ? local : (local || {});
    if (!preferLocal) Object.assign(job, {
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
    cache.set(normalizedId, job);

    if (job.status === 'running' && Date.now() - job.updatedAt > STALE_WORKER_MS) {
      job.status = 'failed';
      job.finishedAt = Date.now();
      job.stage = 'توقفت عملية البناء؛ استُعيد سجل المهمة من قاعدة البيانات';
      job.error = 'توقف نبض عامل البناء بعد آخر سجل محفوظ. لم يُسقط الخادم معرف المهمة؛ راجع السجل وأعد البناء بعد التحقق.';
      job.logs = `${job.logs}\n[CODEXA] ${job.error}`.slice(-200_000);
      await this.persist(job, normalizedTrack);
      await this.releaseBuildLock(job.id).catch(() => undefined);
    }

    if (job.status === 'completed') {
      if (!job.artifactKey || !job.artifactPath) {
        job.status = 'failed';
        job.error = 'اكتمل البناء لكن ملف APK المؤقت غير متاح؛ لم يبدأ التنزيل. راجع السجل وأعد البناء.';
      } else {
        try { await access(job.artifactPath); }
        catch {
          job.status = 'failed';
          job.error = 'أُعيد تشغيل أو استبدال عامل البناء قبل التنزيل، وملف APK المؤقت لم يعد متاحاً. حُفظت سجلات المهمة؛ أعد البناء بموافقتك.';
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
    const [rows] = await this.pool.execute(`SELECT created_at FROM ${JOB_TABLE} WHERE created_at > ? ORDER BY created_at ASC LIMIT ${MAX_BUILDS_PER_WINDOW}`, [now - BUILD_WINDOW_MS]);
    if (rows.length < MAX_BUILDS_PER_WINDOW) return 0;
    return Math.max(1, Math.ceil((Number(rows[0].created_at) + BUILD_WINDOW_MS - now) / 1000));
  }

  async acquireBuildLock(jobId) {
    await this.ensureReady();
    const id = safeId(jobId);
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      const [rows] = await connection.execute(`SELECT job_id, worker_id, expires_at FROM ${LOCK_TABLE} WHERE lock_id = 1 FOR UPDATE`);
      const lock = rows[0];
      const now = Date.now();
      if (lock && Number(lock.expires_at) > now) {
        const [activeRows] = await connection.execute(`SELECT status, updated_at FROM ${JOB_TABLE} WHERE id = ? LIMIT 1`, [lock.job_id]);
        const active = activeRows[0];
        const activeIsStale = !active || (active.status !== 'running' && active.status !== 'queued') || now - asTime(active.updated_at) > STALE_WORKER_MS;
        if (!activeIsStale) {
          await connection.rollback();
          return false;
        }
      }
      await connection.execute(`UPDATE ${LOCK_TABLE} SET job_id = ?, worker_id = ?, expires_at = ? WHERE lock_id = 1`, [id, this.workerId, now + LOCK_LEASE_MS]);
      await connection.commit();
      return true;
    } catch (error) {
      await connection.rollback().catch(() => undefined);
      const normalized = storeError();
      normalized.code = error?.code || 'BUILD_LOCK_FAILED';
      throw normalized;
    } finally { connection.release(); }
  }

  async renewBuildLock(jobId) {
    await this.ensureReady();
    await this.pool.execute(`UPDATE ${LOCK_TABLE} SET expires_at = ? WHERE lock_id = 1 AND job_id = ? AND worker_id = ?`, [Date.now() + LOCK_LEASE_MS, safeId(jobId), this.workerId]);
  }

  async releaseBuildLock(jobId) {
    if (!this.pool || !this.readyPromise) return;
    await this.ensureReady();
    await this.pool.execute(`UPDATE ${LOCK_TABLE} SET job_id = '', worker_id = '', expires_at = 0 WHERE lock_id = 1 AND job_id = ? AND worker_id = ?`, [safeId(jobId), this.workerId]);
  }

  async pruneExpired() {
    if (!this.pool) return;
    const now = Date.now();
    const [rows] = await this.pool.execute(`SELECT id, track, artifact_key FROM ${JOB_TABLE} WHERE expires_at <= ?`, [now]);
    if (!rows.length) return;
    await this.pool.execute(`DELETE FROM ${JOB_TABLE} WHERE expires_at <= ?`, [now]);
    await Promise.all(rows.map(async (row) => {
      if (row.artifact_key && row.artifact_key === this.artifactKey(row.track, row.id)) {
        await rm(this.artifactPath(row.track, row.id), { force: true }).catch(() => undefined);
      }
    }));
  }

  async close() {
    if (this.pool) await this.pool.end();
    this.pool = null;
    this.readyPromise = null;
  }
}
