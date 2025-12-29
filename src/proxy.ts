/* eslint-disable no-console */

import { NextRequest, NextResponse } from 'next/server';

import { getAuthInfoFromCookie } from '@/lib/auth';

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const requestId = Math.random().toString(36).substring(7);

  console.log(`[Middleware ${requestId}] Path:`, pathname);

  if (pathname.startsWith('/adult/')) {
    console.log(`[Middleware ${requestId}] Adult path detected, rewriting...`);

    const newPathname = pathname.replace(/^\/adult/, '');
    const url = request.nextUrl.clone();
    url.pathname = newPathname || '/';

    if (!url.searchParams.has('adult')) {
      url.searchParams.set('adult', '1');
    }

    console.log(
      `[Middleware ${requestId}] Rewritten path: ${url.pathname}${url.search}`,
    );

    const response = NextResponse.rewrite(url);
    response.headers.set('X-Content-Mode', 'adult');

    if (newPathname.startsWith('/api')) {
      const modifiedRequest = new NextRequest(url, request);
      return handleAuthentication(
        modifiedRequest,
        newPathname,
        requestId,
        response,
      );
    }

    return response;
  }

  if (shouldSkipAuth(pathname)) {
    console.log(`[Middleware ${requestId}] Skipping auth for path:`, pathname);
    return NextResponse.next();
  }

  return handleAuthentication(request, pathname, requestId);
}

async function handleAuthentication(
  request: NextRequest,
  pathname: string,
  requestId: string,
  response?: NextResponse,
) {
  const storageType = process.env.NEXT_PUBLIC_STORAGE_TYPE || 'localstorage';
  console.log(`[Middleware ${requestId}] Storage type:`, storageType);

  if (!process.env.PASSWORD) {
    console.log(
      `[Middleware ${requestId}] PASSWORD env not set, redirecting to warning`,
    );
    const warningUrl = new URL('/warning', request.url);
    return NextResponse.redirect(warningUrl);
  }

  console.log(
    `[Middleware ${requestId}] All cookies:`,
    request.cookies.getAll(),
  );
  console.log(
    `[Middleware ${requestId}] Cookie header:`,
    request.headers.get('cookie'),
  );

  const authInfo = getAuthInfoFromCookie(request);
  console.log(
    `[Middleware ${requestId}] Auth info from cookie:`,
    authInfo
      ? {
          username: authInfo.username,
          hasSignature: !!authInfo.signature,
          hasPassword: !!authInfo.password,
          timestamp: authInfo.timestamp,
        }
      : null,
  );

  if (!authInfo) {
    console.log(`[Middleware ${requestId}] No auth info, failing auth`);
    return handleAuthFailure(request, pathname);
  }

  if (storageType === 'localstorage') {
    if (!authInfo.password || authInfo.password !== process.env.PASSWORD) {
      return handleAuthFailure(request, pathname);
    }
    return response || NextResponse.next();
  }

  if (!authInfo.username || !authInfo.signature) {
    console.log(`[Middleware ${requestId}] Missing username or signature:`, {
      hasUsername: !!authInfo.username,
      hasSignature: !!authInfo.signature,
    });
    return handleAuthFailure(request, pathname);
  }

  if (authInfo.signature) {
    console.log(
      `[Middleware ${requestId}] Verifying signature for user:`,
      authInfo.username,
    );
    const isValidSignature = await verifySignature(
      authInfo.username,
      authInfo.signature,
      process.env.PASSWORD || '',
    );

    console.log(`[Middleware ${requestId}] Signature valid:`, isValidSignature);

    if (isValidSignature) {
      console.log(`[Middleware ${requestId}] Auth successful, allowing access`);
      return response || NextResponse.next();
    }
  }

  console.log(
    `[Middleware ${requestId}] Signature verification failed, denying access`,
  );
  return handleAuthFailure(request, pathname);
}

async function verifySignature(
  data: string,
  signature: string,
  secret: string,
): Promise<boolean> {
  const encoder = new TextEncoder();
  const keyData = encoder.encode(secret);
  const messageData = encoder.encode(data);

  try {
    const key = await crypto.subtle.importKey(
      'raw',
      keyData,
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['verify'],
    );

    const signatureBuffer = new Uint8Array(
      signature.match(/.{1,2}/g)?.map((byte) => parseInt(byte, 16)) || [],
    );

    return await crypto.subtle.verify(
      'HMAC',
      key,
      signatureBuffer,
      messageData,
    );
  } catch (error) {
    console.error('Signature verification failed:', error);
    return false;
  }
}

function handleAuthFailure(
  request: NextRequest,
  pathname: string,
): NextResponse {
  if (pathname.startsWith('/api')) {
    return new NextResponse('Unauthorized', { status: 401 });
  }

  const loginUrl = new URL('/login', request.url);
  const fullUrl = `${pathname}${request.nextUrl.search}`;
  loginUrl.searchParams.set('redirect', fullUrl);
  return NextResponse.redirect(loginUrl);
}

function shouldSkipAuth(pathname: string): boolean {
  const skipPaths = [
    '/_next',
    '/favicon.ico',
    '/robots.txt',
    '/manifest.json',
    '/icons/',
    '/logo.png',
    '/screenshot.png',
    '/api/telegram/',
    '/api/download/segment.ts',
  ];

  return skipPaths.some((path) => pathname.startsWith(path));
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|login|register|warning|api/login|api/register|api/logout|api/cron|api/server-config|api/tvbox|api/live/merged|api/parse|api/bing-wallpaper|api/proxy/spider.jar|api/telegram/|api/download/segment).*)',
  ],
};
