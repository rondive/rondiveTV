import { NextRequest, NextResponse } from 'next/server';
import { createReadStream, promises as fs } from 'node:fs';
import { Readable } from 'node:stream';

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

  if (job.status !== 'completed' || !job.outputPath || !job.filename) {
    return NextResponse.json({ error: 'Not ready' }, { status: 409 });
  }

  const stats = await fs.stat(job.outputPath).catch(() => null);
  if (!stats || stats.size <= 0) {
    return NextResponse.json({ error: 'File not found' }, { status: 410 });
  }

  const headers = new Headers();
  headers.set('Content-Type', 'video/mp4');
  headers.set('Content-Length', String(stats.size));
  const asciiFallback =
    job.filename.replace(/[^ -~]/g, '').trim() || 'video.mp4';
  headers.set(
    'Content-Disposition',
    `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encodeURIComponent(job.filename)}`,
  );
  headers.set('Cache-Control', 'no-store');

  const fileStream = createReadStream(job.outputPath);
  const stream = Readable.toWeb(fileStream) as ReadableStream<Uint8Array>;
  return new Response(stream, { headers });
}
