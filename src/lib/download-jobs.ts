import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';

import { db } from '@/lib/db';

export type DownloadJobStatus = 'queued' | 'running' | 'completed' | 'failed';

export type DownloadJobProgress = {
  percent?: number;
  outTimeMs?: number;
  totalDurationMs?: number;
  speed?: string;
  message?: string;
};

export type DownloadJob = {
  id: string;
  key: string;
  user: string;
  urlParam: string;
  title?: string;
  year?: string;
  episode?: string;
  episodeTitle?: string;
  createdAt: number;
  updatedAt: number;
  status: DownloadJobStatus;
  progress: DownloadJobProgress;
  filename?: string;
  outputPath?: string;
  tempDir?: string;
  sizeBytes?: number;
  error?: string;
};

const JOB_CACHE_PREFIX = 'download-job:';
const USER_JOB_INDEX_PREFIX = 'download-job-index:';
const JOB_TTL_SECONDS = 6 * 60 * 60;
const JOB_CLEANUP_MS = 2 * 60 * 60 * 1000;
const PERSIST_INTERVAL_MS = 2000;
const JOB_INDEX_LIMIT = 50;

const jobs = new Map<string, DownloadJob>();
const jobKeys = new Map<string, string>();
const lastPersistAt = new Map<string, number>();
const cleanupTimers = new Map<string, NodeJS.Timeout>();
const jobControllers = new Map<string, AbortController>();

function sanitizeJobForCache(job: DownloadJob): DownloadJob {
  return {
    ...job,
    // avoid storing huge objects; shallow copy is enough
    progress: { ...job.progress },
  };
}

async function persistJob(job: DownloadJob) {
  const now = Date.now();
  const last = lastPersistAt.get(job.id) || 0;
  if (now - last < PERSIST_INTERVAL_MS) return;
  lastPersistAt.set(job.id, now);
  await db.setCache(JOB_CACHE_PREFIX + job.id, sanitizeJobForCache(job), JOB_TTL_SECONDS);
}

async function addJobToUserIndex(user: string, jobId: string) {
  try {
    const cacheKey = USER_JOB_INDEX_PREFIX + user;
    const raw = await db.getCache(cacheKey);
    const existing = Array.isArray(raw)
      ? raw.filter((entry) => typeof entry === 'string')
      : [];
    const next = [jobId, ...existing.filter((id) => id !== jobId)].slice(
      0,
      JOB_INDEX_LIMIT
    );
    await db.setCache(cacheKey, next, JOB_TTL_SECONDS);
  } catch {
    // ignore cache errors for index
  }
}

export function buildDownloadJobKey(input: {
  user: string;
  urlParam: string;
  title?: string;
  year?: string;
  episode?: string;
  episodeTitle?: string;
}): string {
  const normalizeText = (value?: string) => (value ?? '').trim();
  let normalizedUrl = input.urlParam;
  try {
    const parsed = new URL(input.urlParam);
    parsed.hash = '';
    parsed.search = '';
    normalizedUrl = parsed.toString();
  } catch {
    // ignore invalid URLs
  }
  const hash = crypto
    .createHash('sha256')
    .update(
      [
        input.user,
        normalizedUrl,
        normalizeText(input.title),
        normalizeText(input.year),
        normalizeText(input.episode),
        normalizeText(input.episodeTitle),
      ].join('|')
    )
    .digest('hex');
  return hash;
}

export function getJob(jobId: string): DownloadJob | null {
  return jobs.get(jobId) || null;
}

export function getJobByKey(key: string): DownloadJob | null {
  const jobId = jobKeys.get(key);
  if (!jobId) return null;
  return jobs.get(jobId) || null;
}

export function createJob(input: {
  key: string;
  user: string;
  urlParam: string;
  title?: string;
  year?: string;
  episode?: string;
  episodeTitle?: string;
}): DownloadJob {
  const job: DownloadJob = {
    id: crypto.randomUUID(),
    key: input.key,
    user: input.user,
    urlParam: input.urlParam,
    title: input.title,
    year: input.year,
    episode: input.episode,
    episodeTitle: input.episodeTitle,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    status: 'queued',
    progress: { message: 'queued' },
  };
  jobs.set(job.id, job);
  jobKeys.set(job.key, job.id);
  void persistJob(job);
  void addJobToUserIndex(job.user, job.id);
  return job;
}

export async function updateJob(
  jobId: string,
  patch: Partial<DownloadJob>
): Promise<DownloadJob | null> {
  const job = jobs.get(jobId);
  if (!job) return null;
  const next = {
    ...job,
    ...patch,
    progress: patch.progress ? { ...job.progress, ...patch.progress } : job.progress,
    updatedAt: Date.now(),
  };
  jobs.set(jobId, next);
  await persistJob(next);
  return next;
}

export async function markJobFailed(jobId: string, error: string): Promise<void> {
  const job = jobs.get(jobId);
  if (!job) return;
  await updateJob(jobId, { status: 'failed', error, progress: { message: error } });
  jobControllers.delete(jobId);
  scheduleCleanup(jobId);
}

export async function markJobCompleted(jobId: string, patch: Partial<DownloadJob>) {
  await updateJob(jobId, { ...patch, status: 'completed', progress: { message: 'done' } });
  jobControllers.delete(jobId);
  scheduleCleanup(jobId);
}

function scheduleCleanup(jobId: string) {
  if (cleanupTimers.has(jobId)) return;
  const timer = setTimeout(() => {
    void cleanupJob(jobId);
  }, JOB_CLEANUP_MS);
  cleanupTimers.set(jobId, timer);
}

export async function cleanupJob(jobId: string): Promise<void> {
  const job = jobs.get(jobId);
  if (!job) return;
  jobs.delete(jobId);
  jobKeys.delete(job.key);
  lastPersistAt.delete(jobId);
  const timer = cleanupTimers.get(jobId);
  if (timer) {
    clearTimeout(timer);
    cleanupTimers.delete(jobId);
  }
  jobControllers.delete(jobId);
  if (job.tempDir) {
    try {
      await fs.rm(job.tempDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  } else if (job.outputPath) {
    try {
      await fs.rm(job.outputPath, { force: true });
    } catch {
      // ignore cleanup errors
    }
  }
  try {
    await db.setCache(JOB_CACHE_PREFIX + jobId, null, 1);
  } catch {
    // ignore cache cleanup errors
  }
}

export async function getJobFromCache(jobId: string): Promise<DownloadJob | null> {
  const cached = await db.getCache(JOB_CACHE_PREFIX + jobId);
  if (!cached || typeof cached !== 'object') return null;
  return cached as DownloadJob;
}

export function isJobActive(job: DownloadJob | null): boolean {
  return !!job && (job.status === 'queued' || job.status === 'running');
}

export function attachJobController(jobId: string, controller: AbortController) {
  jobControllers.set(jobId, controller);
}

export function getJobController(jobId: string): AbortController | null {
  return jobControllers.get(jobId) || null;
}

export function clearJobController(jobId: string) {
  jobControllers.delete(jobId);
}

export async function cancelJob(jobId: string, reason = 'Canceled'): Promise<boolean> {
  const job = jobs.get(jobId);
  if (!job) return false;
  const controller = jobControllers.get(jobId);
  if (controller && !controller.signal.aborted) {
    controller.abort();
  }
  await updateJob(jobId, {
    status: 'failed',
    error: reason,
    progress: { message: reason },
  });
  scheduleCleanup(jobId);
  return true;
}

export async function listJobsForUser(user: string): Promise<DownloadJob[]> {
  const cacheKey = USER_JOB_INDEX_PREFIX + user;
  let ids: string[] = [];
  const raw = await db.getCache(cacheKey);
  if (Array.isArray(raw)) {
    ids = raw.filter((entry) => typeof entry === 'string');
  }
  if (ids.length === 0 && jobs.size > 0) {
    ids = Array.from(jobs.values())
      .filter((job) => job.user === user)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((job) => job.id);
  }

  const results: DownloadJob[] = [];
  const missing: string[] = [];
  for (const id of ids) {
    const job = jobs.get(id) || (await getJobFromCache(id));
    if (job && job.user === user) {
      results.push(job);
    } else {
      missing.push(id);
    }
  }

  if (missing.length > 0) {
    const next = ids.filter((id) => !missing.includes(id));
    try {
      await db.setCache(cacheKey, next, JOB_TTL_SECONDS);
    } catch {
      // ignore index cleanup errors
    }
  }

  results.sort((a, b) => b.updatedAt - a.updatedAt);
  return results;
}
