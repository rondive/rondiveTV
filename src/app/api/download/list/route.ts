import { NextRequest, NextResponse } from 'next/server';

import { getAuthInfoFromCookie } from '@/lib/auth';
import { listJobsForUser } from '@/lib/download-jobs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const authInfo = getAuthInfoFromCookie(request);
  if (!authInfo?.username) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const jobs = await listJobsForUser(authInfo.username);
  const result = jobs.map((job) => ({
    id: job.id,
    status: job.status,
    progress: job.progress,
    filename: job.filename || null,
    sizeBytes: job.sizeBytes || null,
    error: job.error || null,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    title: job.title || null,
    year: job.year || null,
    episode: job.episode || null,
    episodeTitle: job.episodeTitle || null,
  }));

  return NextResponse.json({ ok: true, jobs: result });
}
