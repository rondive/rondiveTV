import { NextRequest, NextResponse } from 'next/server';

import { getAuthInfoFromCookie } from '@/lib/auth';
import {
  buildDownloadJobKey,
  createJob,
  getJobByKey,
  isJobActive,
  attachJobController,
  markJobCompleted,
  markJobFailed,
  updateJob,
} from '@/lib/download-jobs';

import { executeDownloadCore } from '../route';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type JobPayload = {
  request: NextRequest;
  urlParam: string;
  title?: string | null;
  year?: string | null;
  episode?: string | null;
  episodeTitle?: string | null;
  refererParam?: string | null;
  username: string;
};

async function runDownloadJob(jobId: string, payload: JobPayload) {
  const controller = new AbortController();
  attachJobController(jobId, controller);
  await updateJob(jobId, { status: 'running', progress: { message: 'starting' } });

  try {
    const result = await executeDownloadCore({
      request: payload.request,
      urlParam: payload.urlParam,
      title: payload.title,
      year: payload.year,
      episode: payload.episode,
      episodeTitle: payload.episodeTitle,
      refererParam: payload.refererParam,
      username: payload.username,
      signal: controller.signal,
      onProgress: (progress) => {
        void updateJob(jobId, { progress }).catch(() => null);
      },
    });

    if (!result.outputPath || !result.filename || !result.tempDir || !result.sizeBytes) {
      throw new Error('Download failed');
    }

    await markJobCompleted(jobId, {
      filename: result.filename,
      outputPath: result.outputPath,
      tempDir: result.tempDir,
      sizeBytes: result.sizeBytes,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Download failed';
    await markJobFailed(jobId, message);
  }
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const urlParam = searchParams.get('url');
  const title = searchParams.get('title');
  const year = searchParams.get('year');
  const episode = searchParams.get('episode');
  const episodeTitle = searchParams.get('episode_title');
  const refererParam = searchParams.get('referer');

  if (!urlParam) {
    return NextResponse.json({ error: '缺少下载地址' }, { status: 400 });
  }

  const authInfo = getAuthInfoFromCookie(request);
  if (!authInfo?.username) {
    return NextResponse.json({ error: '请先登录' }, { status: 401 });
  }

  const key = buildDownloadJobKey({
    user: authInfo.username,
    urlParam,
    title: title || undefined,
    year: year || undefined,
    episode: episode || undefined,
    episodeTitle: episodeTitle || undefined,
  });
  const existing = getJobByKey(key);
  if (
    existing &&
    (isJobActive(existing) || (existing.status === 'completed' && existing.outputPath))
  ) {
    return NextResponse.json({
      ok: true,
      jobId: existing.id,
      status: existing.status,
      progress: existing.progress,
      filename: existing.filename || null,
      error: existing.error || null,
      deduped: true,
    });
  }

  const job = createJob({
    key,
    user: authInfo.username,
    urlParam,
    title: title || undefined,
    year: year || undefined,
    episode: episode || undefined,
    episodeTitle: episodeTitle || undefined,
  });
  void runDownloadJob(job.id, {
    request,
    urlParam,
    title,
    year,
    episode,
    episodeTitle,
    refererParam,
    username: authInfo.username,
  });

  return NextResponse.json({
    ok: true,
    jobId: job.id,
    status: job.status,
    progress: job.progress,
    deduped: false,
  });
}
