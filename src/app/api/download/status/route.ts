import { NextRequest, NextResponse } from 'next/server';

import { getAuthInfoFromCookie } from '@/lib/auth';
import { getJob, getJobFromCache } from '@/lib/download-jobs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const jobId = searchParams.get('jobId');

  if (!jobId) {
    return NextResponse.json({ error: 'Missing jobId' }, { status: 400 });
  }

  const authInfo = getAuthInfoFromCookie(request);
  if (!authInfo?.username) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let job = getJob(jobId);
  if (!job) {
    job = await getJobFromCache(jobId);
  }

  if (!job) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  if (job.user !== authInfo.username) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  return NextResponse.json({
    ok: true,
    jobId: job.id,
    status: job.status,
    progress: job.progress,
    filename: job.filename || null,
    sizeBytes: job.sizeBytes || null,
    error: job.error || null,
  });
}
