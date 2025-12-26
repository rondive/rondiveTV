import { NextRequest, NextResponse } from 'next/server';

import { db } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

function isPrivateHost(host: string): boolean {
  const lower = host.toLowerCase();
  return (
    lower === 'localhost' ||
    lower === '::1' ||
    lower.startsWith('127.') ||
    lower.startsWith('0.') ||
    lower.startsWith('10.') ||
    /^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(lower) ||
    lower.startsWith('192.168.')
  );
}

function isLikelyMediaBytes(buffer: Uint8Array): boolean {
  if (!buffer || buffer.length === 0) return false;
  if (buffer[0] === 0x47) return true;
  if (buffer.length >= 8) {
    const signature = String.fromCharCode(
      buffer[4] || 0,
      buffer[5] || 0,
      buffer[6] || 0,
      buffer[7] || 0
    );
    if (
      signature === 'ftyp' ||
      signature === 'moof' ||
      signature === 'styp' ||
      signature === 'sidx' ||
      signature === 'mdat'
    ) {
      return true;
    }
  }
  return false;
}

async function peekStream(
  body: ReadableStream<Uint8Array> | null
): Promise<{
  peek: Uint8Array;
  stream: ReadableStream<Uint8Array> | null;
}> {
  if (!body) {
    return { peek: new Uint8Array(), stream: null };
  }
  const reader = body.getReader();
  const first = await reader.read();
  const peek = first.value || new Uint8Array();

  if (first.done) {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        if (peek.length > 0) controller.enqueue(peek);
        controller.close();
      },
    });
    return { peek, stream };
  }

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      if (peek.length > 0) controller.enqueue(peek);
      const pump = () => {
        reader
          .read()
          .then(({ done, value }) => {
            if (done) {
              controller.close();
              return;
            }
            if (value) controller.enqueue(value);
            pump();
          })
          .catch((error) => {
            controller.error(error);
          });
      };
      pump();
    },
  });

  return { peek, stream };
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const encodedParam = searchParams.get('u');
  const urlParam = searchParams.get('url');
  const token = searchParams.get('token');

  if (!encodedParam && !urlParam) {
    return NextResponse.json({ error: 'Missing url' }, { status: 400 });
  }

  if (!token) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });
  }

  const tokenValue = await db.getCache(`download-proxy:${token}`);
  if (!tokenValue) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });
  }
  const tokenData =
    tokenValue && typeof tokenValue === 'object'
      ? (tokenValue as {
          referer?: string | null;
          userAgent?: string | null;
          origin?: string | null;
          cookie?: string | null;
          authorization?: string | null;
          allowImageSegments?: boolean | null;
          allowEncryptedImageSegments?: boolean | null;
        })
      : null;
  const storedReferer =
    tokenData && typeof tokenData.referer === 'string' ? tokenData.referer : null;
  const storedUserAgent =
    tokenData && typeof tokenData.userAgent === 'string'
      ? tokenData.userAgent
      : null;
  const storedOrigin =
    tokenData && typeof tokenData.origin === 'string' ? tokenData.origin : null;
  const storedCookie =
    tokenData && typeof tokenData.cookie === 'string' ? tokenData.cookie : null;
  const storedAuthorization =
    tokenData && typeof tokenData.authorization === 'string'
      ? tokenData.authorization
      : null;
  const allowImageSegments = tokenData?.allowImageSegments === true;
  const allowEncryptedImageSegments =
    tokenData?.allowEncryptedImageSegments === true;

  let resolvedUrl = urlParam || '';
  if (encodedParam) {
    try {
      resolvedUrl = Buffer.from(encodedParam, 'base64url').toString('utf-8');
    } catch {
      return NextResponse.json({ error: 'Invalid url' }, { status: 400 });
    }
  }

  let targetUrl: URL;
  try {
    targetUrl = new URL(resolvedUrl, request.url);
  } catch {
    return NextResponse.json({ error: 'Invalid url' }, { status: 400 });
  }

  if (!['http:', 'https:'].includes(targetUrl.protocol)) {
    return NextResponse.json({ error: 'Unsupported protocol' }, { status: 400 });
  }

  const requestHost = request.headers.get('host')?.split(':')[0]?.toLowerCase();
  if (isPrivateHost(targetUrl.hostname) && targetUrl.hostname.toLowerCase() !== requestHost) {
    return NextResponse.json({ error: 'Blocked host' }, { status: 403 });
  }

  const pathLower = targetUrl.pathname.toLowerCase();
  if (!allowImageSegments && /\.(jpg|jpeg|png|gif|webp|bmp|svg|ico)$/.test(pathLower)) {
    return new NextResponse('Unsupported segment type', {
      status: 422,
      headers: { 'Content-Type': 'text/plain' },
    });
  }

  const headers: Record<string, string> = {
    'User-Agent': storedUserAgent || DEFAULT_USER_AGENT,
    Accept: '*/*',
    'Accept-Encoding': 'identity',
    Connection: 'keep-alive',
  };
  if (storedReferer) {
    headers.Referer = storedReferer;
  }
  if (storedOrigin) {
    headers.Origin = storedOrigin;
  }
  if (storedCookie) {
    headers.Cookie = storedCookie;
  }
  if (storedAuthorization) {
    headers.Authorization = storedAuthorization;
  }
  const range = request.headers.get('range');
  if (range) {
    headers.Range = range;
  }

  const response = await fetch(targetUrl.toString(), {
    headers,
    redirect: 'follow',
  });

  if (!response.ok) {
    return new NextResponse(
      `HTTP Error ${response.status}: ${response.statusText}`,
      {
        status: response.status >= 500 ? 502 : response.status,
        headers: { 'Content-Type': 'text/plain' },
      }
    );
  }

  let contentType = response.headers.get('Content-Type') || '';
  const lowerType = contentType.toLowerCase();
  let body = response.body;
  if (
    lowerType.startsWith('text/html') ||
    lowerType.startsWith('application/json')
  ) {
    try {
      await response.body?.cancel();
    } catch {
      // ignore cleanup errors
    }
    return new NextResponse(
      `Unexpected segment content-type: ${contentType || 'unknown'}`,
      {
        status: 502,
        headers: { 'Content-Type': 'text/plain' },
      }
    );
  }
  if (lowerType.startsWith('image/')) {
    if (!allowImageSegments) {
      try {
        await response.body?.cancel();
      } catch {
        // ignore cleanup errors
      }
      return new NextResponse(
        `Unexpected segment content-type: ${contentType || 'unknown'}`,
        {
          status: 502,
          headers: { 'Content-Type': 'text/plain' },
        }
      );
    }
    if (!allowEncryptedImageSegments) {
      const peeked = await peekStream(response.body);
      if (!isLikelyMediaBytes(peeked.peek)) {
        try {
          await response.body?.cancel();
        } catch {
          // ignore cleanup errors
        }
        return new NextResponse(
          `Unexpected segment content-type: ${contentType || 'unknown'}`,
          {
            status: 502,
            headers: { 'Content-Type': 'text/plain' },
          }
        );
      }
      body = peeked.stream;
    }
    contentType = 'application/octet-stream';
  }

  const outHeaders = new Headers();
  if (contentType) outHeaders.set('Content-Type', contentType);
  const contentLength = response.headers.get('Content-Length');
  if (contentLength) outHeaders.set('Content-Length', contentLength);
  const contentRange = response.headers.get('Content-Range');
  if (contentRange) outHeaders.set('Content-Range', contentRange);
  const acceptRanges = response.headers.get('Accept-Ranges');
  if (acceptRanges) outHeaders.set('Accept-Ranges', acceptRanges);
  outHeaders.set('Cache-Control', 'no-store');

  return new Response(body, {
    status: response.status,
    headers: outHeaders,
  });
}
