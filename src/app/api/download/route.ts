/* eslint-disable no-console */

import { NextRequest, NextResponse } from 'next/server';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { createReadStream, createWriteStream, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';

import { getAuthInfoFromCookie } from '@/lib/auth';
import { getConfig } from '@/lib/config';
import { db } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const DEFAULT_DAILY_LIMIT = 3;
const DOWNLOAD_PROXY_TTL_SECONDS = 60 * 30;
const DEFAULT_SEGMENT_CONCURRENCY = 8;
const DEFAULT_SEGMENT_RETRY = 2;
const DEFAULT_SEGMENT_TIMEOUT_MS = 25000;
const DEFAULT_SEGMENT_MIN_COUNT = 6;
const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

class DownloadError extends Error {
  status: number;
  stderr?: string;

  constructor(message: string, status = 500, stderr?: string) {
    super(message);
    this.status = status;
    this.stderr = stderr;
  }
}

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

function sanitizeFilename(input: string): string {
  const sanitized = input
    .replace(/[\\/:*?"<>|]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!sanitized) return 'video';
  return sanitized.length > 150 ? sanitized.slice(0, 150).trim() : sanitized;
}

function sanitizeHeaderValue(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').trim();
}

function parseUrlWithHeaders(rawUrl: string): {
  url: string;
  headers: Record<string, string>;
} {
  const trimmed = rawUrl.trim();
  const pipeIndex = trimmed.indexOf('|');
  if (pipeIndex < 0) {
    return { url: trimmed, headers: {} };
  }

  const url = trimmed.slice(0, pipeIndex).trim();
  const headerPart = trimmed.slice(pipeIndex + 1).trim();
  if (!headerPart) {
    return { url, headers: {} };
  }

  const headers: Record<string, string> = {};
  const pairs = headerPart.split('&');
  for (const pair of pairs) {
    const trimmedPair = pair.trim();
    if (!trimmedPair) continue;
    const [rawKey, ...rest] = trimmedPair.split('=');
    if (!rawKey || rest.length === 0) continue;
    const key = rawKey.trim().toLowerCase();
    const rawValue = rest.join('=').trim();
    if (!rawValue) continue;
    let value = rawValue;
    try {
      value = decodeURIComponent(rawValue);
    } catch {
      value = rawValue;
    }
    value = sanitizeHeaderValue(value);
    if (!value) continue;

    if (key === 'referer' || key === 'referrer') {
      headers.Referer = value;
    } else if (key === 'user-agent' || key === 'useragent' || key === 'ua') {
      headers['User-Agent'] = value;
    } else if (key === 'origin') {
      headers.Origin = value;
    } else if (key === 'cookie') {
      headers.Cookie = value;
    } else if (key === 'authorization') {
      headers.Authorization = value;
    }
  }

  return { url, headers };
}

function looksLikeM3U8(content: string): boolean {
  const trimmed = content.trim();
  if (!trimmed) return false;
  if (trimmed.startsWith('#EXTM3U')) return true;
  return /#EXTINF|#EXT-X-STREAM-INF|#EXT-X-TARGETDURATION/i.test(trimmed);
}

const INVALID_SEGMENT_EXTENSIONS = [
  '.jpg',
  '.jpeg',
  '.png',
  '.gif',
  '.webp',
  '.bmp',
  '.svg',
  '.ico',
];

const SEGMENT_EXTENSION_FALLBACKS: Record<string, string[]> = {
  '.jpg': ['.ts', '.m4s', '.mp4'],
  '.jpeg': ['.ts', '.m4s', '.mp4'],
  '.png': ['.ts', '.m4s', '.mp4'],
  '.gif': ['.ts', '.m4s', '.mp4'],
  '.webp': ['.ts', '.m4s', '.mp4'],
};
const DEFAULT_FALLBACK_EXTENSIONS = ['.ts', '.m4s', '.mp4'];
const MAX_SEGMENT_PROBES = 5;

function getSegmentExtension(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.startsWith('#')) return null;
  const withoutHash = trimmed.split('#')[0] || trimmed;
  const withoutQuery = withoutHash.split('?')[0] || withoutHash;
  const dotIndex = withoutQuery.lastIndexOf('.');
  if (dotIndex < 0) return null;
  return withoutQuery.slice(dotIndex).toLowerCase();
}

function replaceSegmentExtension(
  raw: string,
  fromExt: string,
  toExt: string,
): string {
  const trimmed = raw.trim();
  if (!trimmed) return raw;
  const hashIndex = trimmed.indexOf('#');
  const queryIndex = trimmed.indexOf('?');
  const endIndexCandidates = [hashIndex, queryIndex].filter((idx) => idx >= 0);
  const endIndex =
    endIndexCandidates.length > 0
      ? Math.min(...endIndexCandidates)
      : trimmed.length;
  const base = trimmed.slice(0, endIndex);
  const suffix = trimmed.slice(endIndex);
  if (base.toLowerCase().endsWith(fromExt)) {
    return base.slice(0, base.length - fromExt.length) + toExt + suffix;
  }
  return raw;
}

function rewriteSegmentExtensions(
  content: string,
  mapping: Record<string, string>,
): string {
  const lines = content.split(/\r?\n/);
  const rewritten = lines.map((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return line;
    const ext = getSegmentExtension(trimmed);
    if (!ext) return line;
    const toExt = mapping[ext];
    if (!toExt) return line;
    return replaceSegmentExtension(line, ext, toExt);
  });
  return rewritten.join('\n');
}

function getFallbackExtensions(ext: string): string[] {
  const mapped = SEGMENT_EXTENSION_FALLBACKS[ext];
  return mapped && mapped.length > 0 ? mapped : DEFAULT_FALLBACK_EXTENSIONS;
}

function collectInvalidSegmentCandidates(
  content: string,
  baseUrl: string,
): Array<{ ext: string; resolved: string }> {
  const lines = content.split(/\r?\n/);
  const candidates: Array<{ ext: string; resolved: string }> = [];
  const seen = new Set<string>();

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const ext = getSegmentExtension(trimmed);
    if (!ext || !INVALID_SEGMENT_EXTENSIONS.includes(ext)) continue;
    let resolved = trimmed;
    try {
      resolved = new URL(trimmed, baseUrl).toString();
    } catch {
      resolved = trimmed;
    }
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    candidates.push({ ext, resolved });
  }

  return candidates;
}

function isLikelyMediaBytes(buffer: Uint8Array): boolean {
  if (!buffer || buffer.length === 0) return false;
  if (buffer[0] === 0x47) return true;
  if (buffer.length >= 8) {
    const signature = String.fromCharCode(
      buffer[4] || 0,
      buffer[5] || 0,
      buffer[6] || 0,
      buffer[7] || 0,
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

async function probeSegmentContent(
  url: string,
  headers: Headers,
): Promise<boolean> {
  const probeHeaders = new Headers(headers);
  probeHeaders.set('Range', 'bytes=0-15');
  try {
    const response = await fetch(url, {
      headers: probeHeaders,
      redirect: 'follow',
    });
    if (!response.ok) return false;
    const contentType = response.headers.get('Content-Type') || '';
    const lowerType = contentType.toLowerCase();
    if (
      lowerType.startsWith('text/html') ||
      lowerType.startsWith('application/json')
    ) {
      return false;
    }
    const buffer = new Uint8Array(await response.arrayBuffer());
    if (isLikelyMediaBytes(buffer)) return true;
    if (lowerType.startsWith('image/')) return false;
    return /video|mp2t|octet-stream/i.test(lowerType);
  } catch {
    return false;
  }
}

function findInvalidSegmentLine(
  content: string,
  baseUrl: string,
): string | null {
  if (!hasMediaSegments(content)) return null;
  const lines = content.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    let resolved = trimmed;
    try {
      resolved = new URL(trimmed, baseUrl).toString();
    } catch {
      resolved = trimmed;
    }
    const normalized = resolved.split('?')[0]?.split('#')[0]?.toLowerCase();
    if (!normalized) continue;
    if (INVALID_SEGMENT_EXTENSIONS.some((ext) => normalized.endsWith(ext))) {
      return trimmed;
    }
  }
  return null;
}

function hasEncryptionOrMap(content: string): boolean {
  return /#EXT-X-KEY/i.test(content) || /#EXT-X-MAP/i.test(content);
}

async function areImageSegmentsMedia(
  content: string,
  baseUrl: string,
  headers: Headers,
): Promise<boolean> {
  const candidates = collectInvalidSegmentCandidates(content, baseUrl);
  if (candidates.length === 0) return false;
  const sample = candidates.slice(0, MAX_SEGMENT_PROBES);
  for (const candidate of sample) {
    const ok = await probeSegmentContent(candidate.resolved, headers);
    if (!ok) return false;
  }
  return sample.length > 0;
}

async function tryRewriteImageSegments(
  content: string,
  baseUrl: string,
  headers: Headers,
): Promise<string | null> {
  const candidates = collectInvalidSegmentCandidates(content, baseUrl);
  if (candidates.length === 0) return null;

  const primaryExt = candidates[0]?.ext;
  if (!primaryExt) return null;
  const sample = candidates
    .filter((candidate) => candidate.ext === primaryExt)
    .slice(0, MAX_SEGMENT_PROBES);
  if (sample.length === 0) return null;

  const fallbackExts = getFallbackExtensions(primaryExt);
  for (const fallbackExt of fallbackExts) {
    let okCount = 0;
    for (const candidate of sample) {
      const rewrittenUrl = replaceSegmentExtension(
        candidate.resolved,
        primaryExt,
        fallbackExt,
      );
      if (rewrittenUrl === candidate.resolved) {
        okCount = 0;
        break;
      }
      const ok = await probeSegmentContent(rewrittenUrl, headers);
      if (!ok) {
        okCount = 0;
        break;
      }
      okCount += 1;
    }
    if (okCount === sample.length && okCount > 0) {
      const rewritten = rewriteSegmentExtensions(content, {
        [primaryExt]: fallbackExt,
      });
      if (
        hasMediaSegments(rewritten) &&
        !findInvalidSegmentLine(rewritten, baseUrl)
      ) {
        return rewritten;
      }
    }
  }

  return null;
}

function filterInvalidSegments(
  content: string,
  baseUrl: string,
): { content: string; removed: number } {
  if (!hasMediaSegments(content)) return { content, removed: 0 };
  const lines = content.split(/\r?\n/);
  const filtered: string[] = [];
  let pendingSegmentTags: string[] = [];
  let removed = 0;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      if (pendingSegmentTags.length === 0) {
        filtered.push(line);
      }
      continue;
    }

    if (
      trimmed.startsWith('#EXTINF') ||
      trimmed.startsWith('#EXT-X-BYTERANGE')
    ) {
      pendingSegmentTags.push(line);
      continue;
    }

    if (trimmed.startsWith('#')) {
      if (pendingSegmentTags.length > 0) {
        filtered.push(...pendingSegmentTags);
        pendingSegmentTags = [];
      }
      filtered.push(line);
      continue;
    }

    let resolved = trimmed;
    try {
      resolved = new URL(trimmed, baseUrl).toString();
    } catch {
      resolved = trimmed;
    }
    const normalized = resolved.split('?')[0]?.split('#')[0]?.toLowerCase();
    const isInvalid =
      !!normalized &&
      INVALID_SEGMENT_EXTENSIONS.some((ext) => normalized.endsWith(ext));
    if (isInvalid) {
      removed += 1;
      pendingSegmentTags = [];
      continue;
    }

    if (pendingSegmentTags.length > 0) {
      filtered.push(...pendingSegmentTags);
      pendingSegmentTags = [];
    }
    filtered.push(line);
  }

  return { content: filtered.join('\n'), removed };
}

function isLikelyPlayableMediaPlaylist(
  content: string,
  baseUrl: string,
): boolean {
  if (!looksLikeM3U8(content)) return false;
  if (!hasMediaSegments(content)) return false;
  return !findInvalidSegmentLine(content, baseUrl);
}

function detectUnsupportedFfmpegOptions(stderr: string): string[] {
  const unsupported = new Set<string>();
  const patterns = [
    /Unrecognized option '([^']+)'/gi,
    /Option ([^ ]+) not found/gi,
    /Unknown option "?([^"\s]+)"?/gi,
  ];
  for (const pattern of patterns) {
    let match: RegExpExecArray | null = null;
    while ((match = pattern.exec(stderr)) !== null) {
      const option = match[1]?.replace(/^-+/, '').trim();
      if (option) {
        unsupported.add(option);
      }
    }
  }
  return Array.from(unsupported);
}

function buildProxyUrl(
  proxyBase: string,
  targetUrl: string,
  token?: string | null,
): string {
  const encodedTarget = Buffer.from(targetUrl, 'utf-8').toString('base64url');
  const params = new URLSearchParams({ u: encodedTarget });
  if (token) params.set('token', token);
  return `${proxyBase}?${params.toString()}`;
}

function rewriteUriAttributes(
  line: string,
  baseUrl: string,
  proxyBase?: string,
  token?: string | null,
): string {
  return line.replace(/URI="([^"]+)"/g, (_, uri: string) => {
    let resolved = uri;
    try {
      resolved = new URL(uri, baseUrl).toString();
    } catch {
      resolved = uri;
    }
    if (proxyBase) {
      try {
        const resolvedUrl = new URL(resolved);
        if (['http:', 'https:'].includes(resolvedUrl.protocol)) {
          resolved = buildProxyUrl(proxyBase, resolved, token);
        }
      } catch {
        // leave non-URL or unsupported schemes untouched
      }
    }
    return `URI="${resolved}"`;
  });
}

function sanitizeM3U8Content(
  content: string,
  baseUrl: string,
  proxyBase?: string,
  token?: string | null,
): string {
  if (!content) return '';
  const lines = content.split(/\r?\n/);
  const filtered: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i].trim();
    if (!line) {
      filtered.push(line);
      continue;
    }

    if (line.startsWith('#')) {
      if (
        line.startsWith('#EXT-X-KEY:') ||
        line.startsWith('#EXT-X-MAP:') ||
        line.startsWith('#EXT-X-SESSION-KEY:') ||
        line.startsWith('#EXT-X-MEDIA:') ||
        line.startsWith('#EXT-X-PART:') ||
        line.startsWith('#EXT-X-PRELOAD-HINT:')
      ) {
        line = rewriteUriAttributes(line, baseUrl, proxyBase, token);
      }
      filtered.push(line);
      continue;
    }

    let resolved = line;
    try {
      resolved = new URL(line, baseUrl).toString();
    } catch {
      resolved = line;
    }
    if (proxyBase) {
      try {
        const resolvedUrl = new URL(resolved);
        if (['http:', 'https:'].includes(resolvedUrl.protocol)) {
          resolved = buildProxyUrl(proxyBase, resolved, token);
        }
      } catch {
        // leave non-URL or unsupported schemes untouched
      }
    }
    filtered.push(resolved);
  }

  return filtered.join('\n');
}

type ParsedHlsSegment = {
  lineIndex: number;
  resolved: string;
  localPath: string;
};

type ParsedHlsKey = {
  lineIndex: number;
  resolved: string;
  localPath: string;
};

type ParsedHlsMap = {
  lineIndex: number;
  resolved: string;
  localPath: string;
};

function parseAttributeList(line: string): Record<string, string> {
  const idx = line.indexOf(':');
  if (idx < 0) return {};
  const list = line.slice(idx + 1).trim();
  if (!list) return {};
  const parts = list.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/);
  const attrs: Record<string, string> = {};
  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const [rawKey, ...rest] = trimmed.split('=');
    if (!rawKey || rest.length === 0) continue;
    const key = rawKey.trim().toUpperCase();
    let value = rest.join('=').trim();
    if (value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1);
    }
    attrs[key] = value;
  }
  return attrs;
}

function replaceUriAttribute(line: string, newUri: string): string {
  if (/URI="[^"]*"/i.test(line)) {
    return line.replace(/URI="[^"]*"/i, `URI="${newUri}"`);
  }
  if (/URI=[^,]+/i.test(line)) {
    return line.replace(/URI=[^,]+/i, `URI="${newUri}"`);
  }
  return line;
}

function getSafeSegmentExtension(resolvedUrl: string): string {
  try {
    const url = new URL(resolvedUrl);
    const ext = path.posix.extname(url.pathname || '').toLowerCase();
    if (!ext || INVALID_SEGMENT_EXTENSIONS.includes(ext)) return '.ts';
    return ext;
  } catch {
    return '.ts';
  }
}

async function writeResponseToFile(response: Response, filePath: string) {
  if (!response.body) {
    const buffer = Buffer.from(await response.arrayBuffer());
    await fs.writeFile(filePath, buffer);
    return;
  }
  const readable = Readable.fromWeb(
    response.body as unknown as NodeReadableStream,
  ) as NodeJS.ReadableStream;
  await pipeline(readable, createWriteStream(filePath));
}

async function fetchWithTimeout(
  url: string,
  headers: Headers,
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) {
      controller.abort();
    } else {
      signal.addEventListener('abort', onAbort);
    }
  }
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      headers,
      redirect: 'follow',
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeoutId);
    if (signal) {
      signal.removeEventListener('abort', onAbort);
    }
  }
}

async function downloadFileWithRetry(options: {
  url: string;
  filePath: string;
  headers: Headers;
  signal?: AbortSignal;
  timeoutMs: number;
  retries: number;
}) {
  const { url, filePath, headers, signal, timeoutMs, retries } = options;
  let attempt = 0;
  while (attempt <= retries) {
    try {
      const response = await fetchWithTimeout(url, headers, signal, timeoutMs);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      await writeResponseToFile(response, filePath);
      return;
    } catch (error) {
      if (signal?.aborted) throw new Error('Download aborted');
      if (attempt >= retries) {
        throw error instanceof Error
          ? error
          : new Error('Segment download failed');
      }
      attempt += 1;
      await new Promise((resolve) => setTimeout(resolve, 400 * attempt));
    }
  }
}

async function downloadHlsSegmentsParallel(options: {
  content: string;
  baseUrl: string;
  headers: Headers;
  tempDir: string;
  signal?: AbortSignal;
  onProgress?: (progress: DownloadProgressUpdate) => void;
}): Promise<{ playlistPath: string; segmentCount: number } | null> {
  const { content, baseUrl, headers, tempDir, signal, onProgress } = options;
  if (!isVodPlaylist(content) || !hasMediaSegments(content)) return null;

  const lines = content.split(/\r?\n/);
  const segments: ParsedHlsSegment[] = [];
  const keys: ParsedHlsKey[] = [];
  const maps: ParsedHlsMap[] = [];
  const keyMap = new Map<string, string>();
  const mapMap = new Map<string, string>();
  let hasByterange = false;
  let hasPartial = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    if (line.startsWith('#EXT-X-BYTERANGE')) {
      hasByterange = true;
      continue;
    }
    if (
      line.startsWith('#EXT-X-PART') ||
      line.startsWith('#EXT-X-PRELOAD-HINT')
    ) {
      hasPartial = true;
      continue;
    }
    if (line.startsWith('#EXT-X-KEY')) {
      const attrs = parseAttributeList(line);
      const method = (attrs.METHOD || '').toUpperCase();
      const keyformat = attrs.KEYFORMAT ? attrs.KEYFORMAT.toLowerCase() : '';
      if (keyformat && keyformat !== 'identity') {
        return null;
      }
      const uri = attrs.URI;
      if (method && method !== 'NONE' && uri) {
        let resolved = uri;
        try {
          resolved = new URL(uri, baseUrl).toString();
        } catch {
          resolved = uri;
        }
        if (!keyMap.has(resolved)) {
          const name = `key_${keyMap.size + 1}.key`;
          keyMap.set(resolved, name);
        }
        const localName = keyMap.get(resolved);
        if (localName) {
          keys.push({
            lineIndex: i,
            resolved,
            localPath: path.posix.join('keys', localName),
          });
        }
      }
      continue;
    }
    if (line.startsWith('#EXT-X-MAP')) {
      const attrs = parseAttributeList(line);
      const uri = attrs.URI;
      if (uri) {
        let resolved = uri;
        try {
          resolved = new URL(uri, baseUrl).toString();
        } catch {
          resolved = uri;
        }
        if (!mapMap.has(resolved)) {
          const ext = getSafeSegmentExtension(resolved);
          mapMap.set(resolved, `init_${mapMap.size + 1}${ext}`);
        }
        const localName = mapMap.get(resolved);
        if (localName) {
          maps.push({
            lineIndex: i,
            resolved,
            localPath: path.posix.join('maps', localName),
          });
        }
      }
      continue;
    }
    if (line.startsWith('#')) {
      continue;
    }

    let resolved = line;
    try {
      resolved = new URL(line, baseUrl).toString();
    } catch {
      resolved = line;
    }
    const ext = getSafeSegmentExtension(resolved);
    const name = `seg_${String(segments.length + 1).padStart(5, '0')}${ext}`;
    segments.push({
      lineIndex: i,
      resolved,
      localPath: path.posix.join('segments', name),
    });
  }

  if (hasByterange || hasPartial) return null;
  if (segments.length < DEFAULT_SEGMENT_MIN_COUNT) return null;

  const segmentConcurrency = Math.max(
    2,
    Math.floor(
      toNumber(
        process.env.DOWNLOAD_SEGMENT_CONCURRENCY,
        DEFAULT_SEGMENT_CONCURRENCY,
      ),
    ),
  );
  const retries = Math.max(
    0,
    Math.floor(
      toNumber(process.env.DOWNLOAD_SEGMENT_RETRY, DEFAULT_SEGMENT_RETRY),
    ),
  );
  const timeoutMs = Math.max(
    5000,
    Math.floor(
      toNumber(
        process.env.DOWNLOAD_SEGMENT_TIMEOUT_MS,
        DEFAULT_SEGMENT_TIMEOUT_MS,
      ),
    ),
  );

  const segmentsDir = path.join(tempDir, 'segments');
  await fs.mkdir(segmentsDir, { recursive: true });
  if (keyMap.size > 0) {
    await fs.mkdir(path.join(tempDir, 'keys'), { recursive: true });
  }
  if (mapMap.size > 0) {
    await fs.mkdir(path.join(tempDir, 'maps'), { recursive: true });
  }

  for (const [resolved, localName] of Array.from(keyMap.entries())) {
    const keyPath = path.join(tempDir, 'keys', localName);
    await downloadFileWithRetry({
      url: resolved,
      filePath: keyPath,
      headers,
      signal,
      timeoutMs,
      retries,
    });
  }

  for (const [resolved, localName] of Array.from(mapMap.entries())) {
    const mapPath = path.join(tempDir, 'maps', localName);
    await downloadFileWithRetry({
      url: resolved,
      filePath: mapPath,
      headers,
      signal,
      timeoutMs,
      retries,
    });
  }

  let completed = 0;
  let lastReport = 0;
  const reportProgress = () => {
    if (!onProgress) return;
    const now = Date.now();
    if (now - lastReport < 800) return;
    lastReport = now;
    const percent = Math.min(
      99,
      Math.round((completed / segments.length) * 1000) / 10,
    );
    onProgress({
      percent: Number.isFinite(percent) ? percent : undefined,
      message: 'segments',
    });
  };

  let nextIndex = 0;
  const workers = new Array(Math.min(segmentConcurrency, segments.length))
    .fill(0)
    .map(async () => {
      while (nextIndex < segments.length) {
        if (signal?.aborted) {
          throw new Error('Download aborted');
        }
        const index = nextIndex;
        nextIndex += 1;
        if (index >= segments.length) return;
        const segment = segments[index];
        const filePath = path.join(tempDir, segment.localPath);
        await downloadFileWithRetry({
          url: segment.resolved,
          filePath,
          headers,
          signal,
          timeoutMs,
          retries,
        });
        completed += 1;
        reportProgress();
      }
    });

  await Promise.all(workers);

  const keyLines = new Map<number, string>();
  for (const key of keys) {
    keyLines.set(key.lineIndex, key.localPath);
  }
  const mapLines = new Map<number, string>();
  for (const map of maps) {
    mapLines.set(map.lineIndex, map.localPath);
  }
  const segmentLines = new Map<number, string>();
  for (const segment of segments) {
    segmentLines.set(segment.lineIndex, segment.localPath);
  }

  const rewritten = lines.map((line, index) => {
    if (keyLines.has(index)) {
      return replaceUriAttribute(line, keyLines.get(index) || '');
    }
    if (mapLines.has(index)) {
      return replaceUriAttribute(line, mapLines.get(index) || '');
    }
    if (segmentLines.has(index)) {
      return segmentLines.get(index) || line;
    }
    return line;
  });

  const playlistPath = path.join(tempDir, 'playlist-local.m3u8');
  await fs.writeFile(playlistPath, rewritten.join('\n'), 'utf-8');
  return { playlistPath, segmentCount: segments.length };
}

type PlaylistResult = {
  content: string;
  url: string;
};

type DownloadProgressUpdate = {
  percent?: number;
  outTimeMs?: number;
  totalDurationMs?: number;
  speed?: string;
  message?: string;
};

type ExecuteDownloadOptions = {
  request: NextRequest;
  urlParam: string;
  title?: string | null;
  year?: string | null;
  episode?: string | null;
  episodeTitle?: string | null;
  refererParam?: string | null;
  username: string;
  checkOnly?: boolean;
  onProgress?: (progress: DownloadProgressUpdate) => void;
  signal?: AbortSignal;
  preferProxy?: boolean;
};

type ExecuteDownloadResult = {
  quotaInfo: {
    limitEnabled: boolean;
    limitPerDay: number | null;
    remaining: number | null;
  };
  filename?: string;
  outputPath?: string;
  tempDir?: string;
  sizeBytes?: number;
  stderrSummary?: string;
  expectedDurationMs?: number | null;
  outputDurationMs?: number | null;
  cleanupTemp?: () => Promise<void>;
};

function hasMediaSegments(content: string): boolean {
  return content
    .split(/\r?\n/)
    .some((line) => line.trim().startsWith('#EXTINF'));
}

function parsePlaylistDurationMs(content: string): number | null {
  const lines = content.split(/\r?\n/);
  let total = 0;
  let hasDuration = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('#EXTINF:')) continue;
    const match = trimmed.match(/^#EXTINF:([\d.]+)/);
    if (!match) continue;
    const seconds = Number.parseFloat(match[1]);
    if (!Number.isFinite(seconds)) continue;
    total += seconds;
    hasDuration = true;
  }
  if (!hasDuration) return null;
  return Math.round(total * 1000);
}

function isVodPlaylist(content: string): boolean {
  return /#EXT-X-ENDLIST/i.test(content);
}

function parseVariantStreams(
  content: string,
  baseUrl: string,
): Array<{
  url: string;
  bandwidth: number;
}> {
  const lines = content.split(/\r?\n/);
  const variants: Array<{ url: string; bandwidth: number }> = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line.startsWith('#EXT-X-STREAM-INF:')) continue;

    const bandwidthMatch = line.match(/BANDWIDTH=(\d+)/);
    const bandwidth = bandwidthMatch ? Number(bandwidthMatch[1]) : 0;

    let nextIndex = i + 1;
    while (nextIndex < lines.length) {
      const nextLine = lines[nextIndex].trim();
      if (!nextLine) {
        nextIndex += 1;
        continue;
      }
      if (nextLine.startsWith('#')) {
        break;
      }
      let resolved = nextLine;
      try {
        resolved = new URL(nextLine, baseUrl).toString();
      } catch {
        resolved = nextLine;
      }
      variants.push({ url: resolved, bandwidth });
      break;
    }
  }

  return variants;
}

async function fetchPlaylist(
  url: string,
  headers: Headers,
): Promise<PlaylistResult> {
  const response = await fetch(url, { headers, redirect: 'follow' });
  if (!response.ok) {
    throw new Error(`Playlist fetch failed with ${response.status}`);
  }
  const content = await response.text();
  return { content, url: response.url || url };
}

async function resolveMediaPlaylist(
  initialUrl: string,
  headers: Headers,
  maxDepth = 3,
): Promise<PlaylistResult> {
  let current = await fetchPlaylist(initialUrl, headers);
  const visited = new Set<string>();

  for (let depth = 0; depth < maxDepth; depth += 1) {
    if (visited.has(current.url)) {
      return current;
    }
    visited.add(current.url);

    const variants = parseVariantStreams(current.content, current.url);
    if (variants.length === 0) {
      return current;
    }
    variants.sort((a, b) => b.bandwidth - a.bandwidth);
    let fallback: PlaylistResult | null = null;

    for (const variant of variants) {
      if (!variant.url || visited.has(variant.url)) {
        continue;
      }
      const candidate = await fetchPlaylist(variant.url, headers);
      if (!fallback) {
        fallback = candidate;
      }
      if (isLikelyPlayableMediaPlaylist(candidate.content, candidate.url)) {
        return candidate;
      }
    }

    if (!fallback) {
      return current;
    }
    current = fallback;
  }

  return current;
}

function buildFilename(params: {
  title?: string | null;
  year?: string | null;
  episode?: string | null;
  episodeTitle?: string | null;
}): string {
  const title = sanitizeFilename(params.title || 'video').replace(
    /\.mp4$/i,
    '',
  );
  const year = params.year ? sanitizeFilename(params.year) : '';
  const episodeLabel = params.episodeTitle
    ? sanitizeFilename(params.episodeTitle)
    : params.episode
      ? `第${params.episode}集`
      : '';

  const parts = [title];
  if (year) parts.push(`(${year})`);
  if (episodeLabel) parts.push(episodeLabel);
  return `${parts.join(' ')}.mp4`;
}

function formatDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function secondsUntilNextDay(date: Date): number {
  const next = new Date(date);
  next.setHours(24, 0, 0, 0);
  return Math.max(1, Math.ceil((next.getTime() - date.getTime()) / 1000));
}

function formatSpeed(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function toNumber(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

async function checkAndConsumeQuota(options: {
  username: string;
  limitEnabled: boolean;
  limitPerDay: number;
  checkOnly: boolean;
}): Promise<{
  allowed: boolean;
  remaining: number | null;
  reason?: string;
  cacheKey?: string;
  expireSeconds?: number;
}> {
  if (!options.limitEnabled) {
    return { allowed: true, remaining: null };
  }

  if (options.limitPerDay <= 0) {
    return { allowed: false, remaining: 0, reason: '下载次数已用尽' };
  }

  const now = new Date();
  const dateKey = formatDateKey(now);
  const cacheKey = `download-limit:${options.username}:${dateKey}`;
  const expireSeconds = secondsUntilNextDay(now);

  try {
    const rawCount = await db.getCache(cacheKey);
    const currentCount = Math.max(0, Math.floor(toNumber(rawCount, 0)));

    if (currentCount >= options.limitPerDay) {
      return { allowed: false, remaining: 0, reason: '下载次数已用尽' };
    }

    if (options.checkOnly) {
      return {
        allowed: true,
        remaining: Math.max(0, options.limitPerDay - currentCount),
        cacheKey,
        expireSeconds,
      };
    }

    const nextCount = currentCount + 1;
    await db.setCache(cacheKey, nextCount, expireSeconds);
    return {
      allowed: true,
      remaining: Math.max(0, options.limitPerDay - nextCount),
      cacheKey,
      expireSeconds,
    };
  } catch (error) {
    console.error('Download quota check failed:', error);
    return { allowed: true, remaining: null };
  }
}

export async function executeDownloadCore(
  options: ExecuteDownloadOptions,
): Promise<ExecuteDownloadResult> {
  const {
    request,
    urlParam,
    title,
    year,
    episode,
    episodeTitle,
    refererParam,
    username,
    checkOnly,
    onProgress,
    signal,
    preferProxy,
  } = options;

  if (!urlParam) {
    throw new DownloadError('缺少播放地址', 400);
  }

  const { url: normalizedUrl, headers: urlHeaders } =
    parseUrlWithHeaders(urlParam);
  const userAgent = sanitizeHeaderValue(
    urlHeaders['User-Agent'] || DEFAULT_USER_AGENT,
  );
  let referer = refererParam || urlHeaders.Referer || null;
  if (referer) {
    referer = sanitizeHeaderValue(referer);
  }
  let origin = urlHeaders.Origin
    ? sanitizeHeaderValue(urlHeaders.Origin)
    : null;
  const cookie = urlHeaders.Cookie
    ? sanitizeHeaderValue(urlHeaders.Cookie)
    : null;
  const authorization = urlHeaders.Authorization
    ? sanitizeHeaderValue(urlHeaders.Authorization)
    : null;

  let targetUrl: URL;
  try {
    targetUrl = new URL(normalizedUrl, request.url);
  } catch {
    throw new DownloadError('播放地址无效', 400);
  }

  if (!['http:', 'https:'].includes(targetUrl.protocol)) {
    throw new DownloadError('不支持的协议', 400);
  }

  const requestHost = request.headers.get('host')?.split(':')[0]?.toLowerCase();
  if (
    isPrivateHost(targetUrl.hostname) &&
    targetUrl.hostname.toLowerCase() !== requestHost
  ) {
    throw new DownloadError('目标地址被阻止', 403);
  }

  const adminConfig = await getConfig();
  const userEntry = adminConfig.UserConfig.Users.find(
    (user) => user.username === username,
  );
  if (!userEntry || userEntry.banned) {
    throw new DownloadError('无权限', 403);
  }

  const limitEnabled = userEntry.downloadLimitEnabled !== false;
  const limitPerDay = Math.max(
    0,
    Math.floor(toNumber(userEntry.downloadLimitPerDay, DEFAULT_DAILY_LIMIT)),
  );

  const quotaResult = await checkAndConsumeQuota({
    username,
    limitEnabled,
    limitPerDay,
    checkOnly: !!checkOnly,
  });

  if (!quotaResult.allowed) {
    throw new DownloadError(quotaResult.reason || '下载次数已用尽', 429);
  }

  const quotaInfo = {
    limitEnabled,
    limitPerDay: limitEnabled ? limitPerDay : null,
    remaining: quotaResult.remaining,
  };

  if (checkOnly) {
    return { quotaInfo };
  }

  const refundQuota = async () => {
    if (!limitEnabled || !quotaResult.cacheKey || !quotaResult.expireSeconds)
      return;
    try {
      const rawCount = await db.getCache(quotaResult.cacheKey);
      const currentCount = Math.max(0, Math.floor(toNumber(rawCount, 0)));
      if (currentCount > 0) {
        await db.setCache(
          quotaResult.cacheKey,
          currentCount - 1,
          quotaResult.expireSeconds,
        );
      }
    } catch (error) {
      console.error('Failed to refund download quota:', error);
    }
  };

  const filename = buildFilename({ title, year, episode, episodeTitle });
  const ffmpegPath = process.env.FFMPEG_PATH || 'ffmpeg';

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'moontv-download-'));
  const outputPath = path.join(tempDir, 'video.mp4');
  const urlParamLower = normalizedUrl.toLowerCase();
  const isHls =
    targetUrl.pathname.toLowerCase().includes('.m3u8') ||
    urlParamLower.includes('m3u8');
  if (isHls && !referer) {
    referer = targetUrl.origin;
  }
  if (isHls && !origin) {
    origin = targetUrl.origin;
  }
  const requestHeaders = new Headers();
  requestHeaders.set('User-Agent', userAgent);
  if (referer) {
    requestHeaders.set('Referer', referer);
  }
  if (origin) {
    requestHeaders.set('Origin', origin);
  }
  if (cookie) {
    requestHeaders.set('Cookie', cookie);
  }
  if (authorization) {
    requestHeaders.set('Authorization', authorization);
  }

  const hostHeader = request.headers.get('host') || '';
  const hostParts = hostHeader.split(':');
  const serverPort =
    process.env.PORT || (hostParts.length > 1 ? hostParts[1] : '3000');
  const proxyBaseUrl =
    process.env.DOWNLOAD_PROXY_BASE_URL ||
    `http://127.0.0.1:${serverPort}/api/download/segment.ts`;

  let ffmpegFailed = false;
  let stderrSummary = '';
  let expectedDurationMs: number | null = null;
  let outputDurationMs: number | null = null;

  const cleanupTemp = async () => {
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch (error) {
      if (process.env.NODE_ENV !== 'production') {
        console.warn('Failed to remove temp download files:', error);
      }
    }
  };

  const headerLines = [`User-Agent: ${userAgent}`];
  if (referer) {
    headerLines.push(`Referer: ${referer}`);
  }
  if (origin) {
    headerLines.push(`Origin: ${origin}`);
  }
  if (cookie) {
    headerLines.push(`Cookie: ${cookie}`);
  }
  if (authorization) {
    headerLines.push(`Authorization: ${authorization}`);
  }
  const headerArgs =
    headerLines.length > 0
      ? ['-headers', `${headerLines.join('\r\n')}\r\n`]
      : [];

  const attemptModes = isHls
    ? preferProxy
      ? [true, false]
      : [false, true]
    : [false];

  const runAttempt = async (useProxy: boolean) => {
    onProgress?.({ message: useProxy ? 'proxy' : 'direct' });

    let proxyBase: string | undefined;
    let proxyToken: string | null = null;
    if (isHls && useProxy) {
      proxyToken = crypto.randomUUID();
      try {
        await db.setCache(
          `download-proxy:${proxyToken}`,
          {
            username,
            referer: referer || null,
            userAgent,
            origin: origin || null,
            cookie: cookie || null,
            authorization: authorization || null,
          },
          DOWNLOAD_PROXY_TTL_SECONDS,
        );
        proxyBase = proxyBaseUrl;
      } catch (error) {
        console.error('Failed to create download proxy token:', error);
        throw new DownloadError('Proxy token unavailable', 500);
      }
    }

    let playlistError: Error | null = null;
    let inputUrl = targetUrl.toString();
    let attemptDurationMs: number | null = null;

    if (isHls) {
      try {
        const playlistResult = await resolveMediaPlaylist(
          targetUrl.toString(),
          requestHeaders,
        );
        if (!looksLikeM3U8(playlistResult.content)) {
          throw new Error('Playlist content is not a valid M3U8');
        }
        let contentToSanitize = playlistResult.content;
        let allowImageSegments = false;
        let allowEncryptedImageSegments = false;
        const hasInvalidCandidates =
          collectInvalidSegmentCandidates(contentToSanitize, playlistResult.url)
            .length > 0;
        const hasEncryption = hasEncryptionOrMap(contentToSanitize);
        if (hasInvalidCandidates) {
          if (hasEncryption) {
            allowImageSegments = true;
            allowEncryptedImageSegments = true;
          } else {
            const imagesAreMedia = await areImageSegmentsMedia(
              contentToSanitize,
              playlistResult.url,
              requestHeaders,
            );
            if (imagesAreMedia) {
              allowImageSegments = true;
            } else {
              const rewritten = await tryRewriteImageSegments(
                contentToSanitize,
                playlistResult.url,
                requestHeaders,
              );
              if (rewritten) {
                contentToSanitize = rewritten;
                if (
                  findInvalidSegmentLine(contentToSanitize, playlistResult.url)
                ) {
                  allowImageSegments = true;
                }
              } else {
                allowImageSegments = true;
              }
            }
          }
        }
        if (allowImageSegments && proxyToken) {
          await db.setCache(
            `download-proxy:${proxyToken}`,
            {
              username,
              referer: referer || null,
              userAgent,
              origin: origin || null,
              cookie: cookie || null,
              authorization: authorization || null,
              allowImageSegments: true,
              allowEncryptedImageSegments,
            },
            DOWNLOAD_PROXY_TTL_SECONDS,
          );
        }
        const invalidSegment = allowImageSegments
          ? null
          : findInvalidSegmentLine(contentToSanitize, playlistResult.url);
        if (invalidSegment) {
          const filtered = filterInvalidSegments(
            contentToSanitize,
            playlistResult.url,
          );
          if (filtered.removed > 0 && hasMediaSegments(filtered.content)) {
            contentToSanitize = filtered.content;
          } else {
            throw new Error(
              `Playlist contains non-media segment: ${invalidSegment}`,
            );
          }
        }
        const sanitized = sanitizeM3U8Content(
          contentToSanitize,
          playlistResult.url,
          proxyBase,
          proxyToken,
        );
        const playlistContent = hasMediaSegments(sanitized)
          ? sanitized
          : contentToSanitize;
        if (!hasMediaSegments(playlistContent)) {
          throw new Error('No playable media segments found in playlist');
        }
        expectedDurationMs =
          isVodPlaylist(playlistContent) &&
          parsePlaylistDurationMs(playlistContent)
            ? parsePlaylistDurationMs(playlistContent)
            : null;

        let parallelPlaylistPath: string | null = null;
        if (!useProxy) {
          try {
            onProgress?.({ message: 'segments' });
            const parallelResult = await downloadHlsSegmentsParallel({
              content: playlistContent,
              baseUrl: playlistResult.url,
              headers: requestHeaders,
              tempDir,
              signal,
              onProgress,
            });
            if (parallelResult) {
              parallelPlaylistPath = parallelResult.playlistPath;
            }
          } catch (error) {
            if (process.env.NODE_ENV !== 'production') {
              console.warn(
                'Parallel segment download failed, fallback to ffmpeg.',
                error,
              );
            }
          }
        }

        if (parallelPlaylistPath) {
          inputUrl = parallelPlaylistPath;
        } else {
          const playlistPath = path.join(
            tempDir,
            useProxy ? 'playlist-proxy.m3u8' : 'playlist.m3u8',
          );
          await fs.writeFile(playlistPath, playlistContent, 'utf-8');
          inputUrl = playlistPath;
        }
      } catch (error) {
        if (error instanceof Error) {
          if (
            error.message.includes('No playable media segments') ||
            error.message.includes('valid M3U8') ||
            error.message.includes('non-media segment')
          ) {
            playlistError = error;
          }
        }
        if (process.env.NODE_ENV !== 'production') {
          console.warn(
            'Failed to sanitize playlist, fallback to direct URL.',
            error,
          );
        }
      }
    }
    if (playlistError) {
      throw new DownloadError(playlistError.message, 422);
    }

    const baseArgs = [
      '-hide_banner',
      '-loglevel',
      'error',
      '-progress',
      'pipe:1',
      '-nostats',
    ];

    const inputArgs = [
      '-i',
      inputUrl,
      '-c',
      'copy',
      '-movflags',
      '+faststart',
      '-y',
      outputPath,
    ];

    const buildArgs = (argsOptions: {
      includeHeaders: boolean;
      includeProtocolWhitelist: boolean;
      includeAllowedExtensions: boolean;
      includeAllowedSegmentExtensions: boolean;
    }) => [
      ...baseArgs,
      ...(argsOptions.includeHeaders ? headerArgs : []),
      ...(isHls && argsOptions.includeProtocolWhitelist
        ? ['-protocol_whitelist', 'file,http,https,tcp,tls,crypto,data']
        : []),
      ...(isHls && argsOptions.includeAllowedExtensions
        ? ['-allowed_extensions', 'ALL']
        : []),
      ...(isHls && argsOptions.includeAllowedSegmentExtensions
        ? ['-allowed_segment_extensions', 'ALL']
        : []),
      ...inputArgs,
    ];

    const runFfmpeg = async (argsOptions: {
      includeHeaders: boolean;
      includeProtocolWhitelist: boolean;
      includeAllowedExtensions: boolean;
      includeAllowedSegmentExtensions: boolean;
    }) => {
      const args = buildArgs(argsOptions);
      let stderrBytes = 0;
      let stderrOutput = '';
      let stdoutBuffer = '';
      let lastOutTimeMs = 0;
      let lastSpeed: string | undefined;
      let lastReport = 0;

      const emitProgress = (force = false) => {
        if (!onProgress) return;
        const now = Date.now();
        if (!force && now - lastReport < 1000) return;
        lastReport = now;
        const percent =
          expectedDurationMs && lastOutTimeMs > 0
            ? Math.min(
                100,
                Math.max(0, (lastOutTimeMs / expectedDurationMs) * 100),
              )
            : undefined;
        onProgress({
          percent: percent ? Math.round(percent * 10) / 10 : undefined,
          outTimeMs: lastOutTimeMs || undefined,
          totalDurationMs: expectedDurationMs || undefined,
          speed: formatSpeed(lastSpeed),
          message: 'downloading',
        });
      };

      return await new Promise<{
        ok: boolean;
        stderr: string;
        error?: Error;
        unsupportedOptions?: string[];
        outTimeMs?: number;
      }>((resolve) => {
        const ffmpeg = spawn(ffmpegPath, args, {
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let aborted = false;

        const abortHandler = () => {
          aborted = true;
          ffmpeg.kill('SIGKILL');
        };

        signal?.addEventListener('abort', abortHandler);

        ffmpeg.stdout?.on('data', (chunk) => {
          stdoutBuffer += chunk.toString();
          let idx = stdoutBuffer.indexOf('\n');
          while (idx >= 0) {
            const line = stdoutBuffer.slice(0, idx).trim();
            stdoutBuffer = stdoutBuffer.slice(idx + 1);
            if (line) {
              const [key, value] = line.split('=');
              if (key === 'out_time_ms') {
                const parsed = Number.parseInt(value || '0', 10);
                if (Number.isFinite(parsed) && parsed >= 0) {
                  lastOutTimeMs = parsed / 1000;
                  emitProgress();
                }
              }
              if (key === 'speed') {
                lastSpeed = value;
                emitProgress();
              }
              if (key === 'progress' && value === 'end') {
                emitProgress(true);
              }
            }
            idx = stdoutBuffer.indexOf('\n');
          }
        });

        ffmpeg.stderr?.on('data', (chunk) => {
          if (stderrBytes < 4096) {
            const text = chunk.toString();
            stderrOutput += text;
            stderrBytes += text.length;
          }
          if (process.env.NODE_ENV !== 'production') {
            console.warn(`ffmpeg: ${chunk.toString()}`);
          }
        });

        const finalize = (result: {
          ok: boolean;
          stderr: string;
          error?: Error;
          unsupportedOptions?: string[];
          outTimeMs?: number;
        }) => {
          signal?.removeEventListener('abort', abortHandler);
          resolve(result);
        };

        ffmpeg.once('error', (error) => {
          finalize({
            ok: false,
            stderr: stderrOutput,
            error,
            unsupportedOptions: detectUnsupportedFfmpegOptions(stderrOutput),
          });
        });

        ffmpeg.once('close', (code) => {
          if (aborted) {
            finalize({
              ok: false,
              stderr: stderrOutput,
              error: new Error('Download aborted'),
            });
            return;
          }
          if (code === 0) {
            finalize({
              ok: true,
              stderr: stderrOutput,
              outTimeMs: lastOutTimeMs,
            });
            return;
          }
          finalize({
            ok: false,
            stderr: stderrOutput,
            error: new Error(`FFmpeg exited with code ${code ?? 'unknown'}`),
            unsupportedOptions: detectUnsupportedFfmpegOptions(stderrOutput),
          });
        });
      });
    };

    const optionState = {
      includeHeaders: headerArgs.length > 0,
      includeProtocolWhitelist: isHls,
      includeAllowedExtensions: isHls,
      includeAllowedSegmentExtensions: isHls,
    };

    let ffmpegResult = await runFfmpeg(optionState);
    let attempts = 0;
    while (!ffmpegResult.ok && attempts < 3) {
      const unsupported = new Set(ffmpegResult.unsupportedOptions || []);
      if (unsupported.size === 0) break;
      let changed = false;
      if (
        optionState.includeHeaders &&
        (unsupported.has('headers') || unsupported.has('user_agent'))
      ) {
        optionState.includeHeaders = false;
        changed = true;
      }
      if (
        optionState.includeProtocolWhitelist &&
        unsupported.has('protocol_whitelist')
      ) {
        optionState.includeProtocolWhitelist = false;
        changed = true;
      }
      if (
        optionState.includeAllowedExtensions &&
        unsupported.has('allowed_extensions')
      ) {
        optionState.includeAllowedExtensions = false;
        changed = true;
      }
      if (
        optionState.includeAllowedSegmentExtensions &&
        unsupported.has('allowed_segment_extensions')
      ) {
        optionState.includeAllowedSegmentExtensions = false;
        changed = true;
      }
      if (!changed) break;
      attempts += 1;
      ffmpegResult = await runFfmpeg(optionState);
    }

    if (!ffmpegResult.ok) {
      ffmpegFailed = true;
      stderrSummary = ffmpegResult.stderr;
      throw new DownloadError(
        ffmpegResult.error?.message || 'FFmpeg failed',
        500,
        ffmpegResult.stderr,
      );
    }

    stderrSummary = ffmpegResult.stderr;
    attemptDurationMs = ffmpegResult.outTimeMs
      ? Math.round(ffmpegResult.outTimeMs)
      : null;

    const stats = await fs.stat(outputPath).catch(() => null);
    if (!stats || stats.size <= 0) {
      ffmpegFailed = true;
      throw new DownloadError('Empty output from ffmpeg', 500);
    }

    if (
      expectedDurationMs &&
      attemptDurationMs &&
      attemptDurationMs < expectedDurationMs * 0.9
    ) {
      ffmpegFailed = true;
      throw new DownloadError('Output appears incomplete', 500);
    }

    outputDurationMs = attemptDurationMs;
  };

  try {
    let lastError: Error | null = null;
    for (const useProxy of attemptModes) {
      try {
        await runAttempt(useProxy);
        const stats = await fs.stat(outputPath);
        return {
          quotaInfo,
          filename,
          outputPath,
          tempDir,
          sizeBytes: stats.size,
          stderrSummary,
          expectedDurationMs,
          outputDurationMs,
          cleanupTemp,
        };
      } catch (error) {
        lastError =
          error instanceof Error ? error : new Error('Download failed');
        if (!isHls) break;
      }
    }
    if (ffmpegFailed) {
      void refundQuota();
    }
    await cleanupTemp();
    if (lastError instanceof DownloadError) {
      throw lastError;
    }
    throw new DownloadError(lastError?.message || 'Download failed', 500);
  } catch (error) {
    if (ffmpegFailed) {
      void refundQuota();
    }
    await cleanupTemp();
    if (error instanceof DownloadError) {
      throw error;
    }
    const details = error instanceof Error ? error.message : 'Download failed';
    throw new DownloadError(details, 500);
  }
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const urlParam = searchParams.get('url');
  const title = searchParams.get('title');
  const year = searchParams.get('year');
  const episode = searchParams.get('episode');
  const episodeTitle = searchParams.get('episode_title');
  const checkOnly = searchParams.get('check') === '1';
  const refererParam = searchParams.get('referer');

  if (!urlParam) {
    return NextResponse.json({ error: '缺少播放地址' }, { status: 400 });
  }

  const authInfo = getAuthInfoFromCookie(request);
  if (!authInfo?.username) {
    return NextResponse.json({ error: '未登录' }, { status: 401 });
  }

  try {
    const result = await executeDownloadCore({
      request,
      urlParam,
      title,
      year,
      episode,
      episodeTitle,
      refererParam,
      username: authInfo.username,
      checkOnly,
      signal: request.signal,
    });

    if (checkOnly) {
      return NextResponse.json({
        ok: true,
        limitEnabled: result.quotaInfo.limitEnabled,
        limitPerDay: result.quotaInfo.limitPerDay,
        remaining: result.quotaInfo.remaining,
      });
    }

    if (
      !result.outputPath ||
      !result.filename ||
      !result.cleanupTemp ||
      !result.sizeBytes
    ) {
      throw new DownloadError('Download failed', 500);
    }

    const headers = new Headers();
    headers.set('Content-Type', 'video/mp4');
    headers.set('Content-Length', String(result.sizeBytes));
    const asciiFallback =
      result.filename.replace(/[^ -~]/g, '').trim() || 'video.mp4';
    headers.set(
      'Content-Disposition',
      `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encodeURIComponent(result.filename)}`,
    );
    headers.set('Cache-Control', 'no-store');
    if (result.quotaInfo.limitEnabled && result.quotaInfo.remaining !== null) {
      headers.set('X-Download-Remaining', String(result.quotaInfo.remaining));
      if (result.quotaInfo.limitPerDay !== null) {
        headers.set('X-Download-Limit', String(result.quotaInfo.limitPerDay));
      }
    }

    const fileStream = createReadStream(result.outputPath);
    let cleaned = false;
    const scheduleCleanup = () => {
      if (cleaned) return;
      cleaned = true;
      void result.cleanupTemp?.();
    };

    fileStream.on('close', scheduleCleanup);
    fileStream.on('error', scheduleCleanup);

    const stream = Readable.toWeb(fileStream) as ReadableStream<Uint8Array>;
    return new Response(stream, { headers });
  } catch (error) {
    if (error instanceof DownloadError) {
      const status = error.status || 500;
      if (checkOnly) {
        return NextResponse.json({ error: error.message }, { status });
      }
      return NextResponse.json(
        {
          error: 'Download failed',
          details: error.message,
          stderr: error.stderr,
        },
        { status },
      );
    }
    const details =
      error instanceof Error
        ? error.message
        : 'FFmpeg failed to build download';
    return NextResponse.json(
      { error: 'Download failed', details: details.trim() },
      { status: 500 },
    );
  }
}
