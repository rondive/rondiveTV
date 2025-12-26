import { NextRequest, NextResponse } from 'next/server';

import { getAuthInfoFromCookie } from '@/lib/auth';
import { cancelJob, getJob, getJobFromCache } from '@/lib/download-jobs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  const authInfo = getAuthInfoFromCookie(request);
  if (!authInfo?.username) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let jobId: string | null = null;
  try {
    const body = (await request.json().catch(() => ({}))) as { jobId?: string };
    if (body?.jobId) jobId = body.jobId;
  } catch {
    // ignore parse errors
  }

  if (!jobId) {
    const { searchParams } = new URL(request.url);
    jobId = searchParams.get('jobId');
  }

  if (!jobId) {
    return NextResponse.json({ error: 'Missing jobId' }, { status: 400 });
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

  const ok = await cancelJob(jobId, 'Canceled');
  if (!ok) {
    return NextResponse.json({ error: 'Not running' }, { status: 409 });
  }

  return NextResponse.json({ ok: true });
}
