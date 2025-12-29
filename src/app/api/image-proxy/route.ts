import { createHash } from 'crypto';
import { createReadStream, promises as fs } from 'fs';
import { NextResponse } from 'next/server';
import path from 'path';
import { Readable } from 'stream';

export const runtime = 'nodejs';

type CacheEntry = {
  contentType?: string | null;
  etag?: string | null;
  fetchedAt: number;
  sourceUrl: string;
  size: number;
};

const CACHE_ROOT =
  process.env.IMAGE_CACHE_DIR ||
  path.join(process.cwd(), '.cache', 'image-proxy');
const CACHE_TTL_MS =
  Number(process.env.IMAGE_CACHE_TTL_MS) || 1000 * 60 * 60 * 24 * 30;
type FetchResult =
  | { type: 'ok'; buffer: Buffer; entry: CacheEntry }
  | { type: 'redirect' }
  | { type: 'error'; status: number; statusText: string };

const inFlight = new Map<string, Promise<FetchResult>>();

const hashUrl = (url: string) => createHash('sha256').update(url).digest('hex');

const getCachePaths = (url: string) => {
  const hash = hashUrl(url);
  const subdir = hash.slice(0, 2);
  const dir = path.join(CACHE_ROOT, subdir);
  return {
    dir,
    dataPath: path.join(dir, hash),
    metaPath: path.join(dir, `${hash}.json`),
  };
};

const ensureDir = async (dir: string) => {
  await fs.mkdir(dir, { recursive: true });
};

const readCache = async (url: string) => {
  const { dataPath, metaPath } = getCachePaths(url);
  try {
    const metaRaw = await fs.readFile(metaPath, 'utf8');
    const entry = JSON.parse(metaRaw) as CacheEntry;
    if (Date.now() - entry.fetchedAt > CACHE_TTL_MS) {
      await fs.unlink(dataPath).catch(() => undefined);
      await fs.unlink(metaPath).catch(() => undefined);
      return null;
    }
    const stream = createReadStream(dataPath);
    return { stream, entry };
  } catch {
    return null;
  }
};

const writeCache = async (url: string, buffer: Buffer, entry: CacheEntry) => {
  const { dir, dataPath, metaPath } = getCachePaths(url);
  await ensureDir(dir);
  await fs.writeFile(dataPath, buffer);
  await fs.writeFile(metaPath, JSON.stringify(entry));
};

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const imageUrl = searchParams.get('url');

  if (!imageUrl) {
    return NextResponse.json({ error: 'Missing image URL' }, { status: 400 });
  }

  const userAgent =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36';

  const referer = imageUrl.includes('manmankan.com')
    ? 'https://g.manmankan.com/'
    : 'https://movie.douban.com/';

  const buildImageResponse = (
    body: BodyInit,
    contentType?: string | null,
    etag?: string | null,
    cacheStatus?: 'hit' | 'miss',
  ) => {
    const headers = new Headers();
    if (contentType) {
      headers.set('Content-Type', contentType);
    }
    if (etag) {
      headers.set('ETag', etag);
    }

    headers.set('Cache-Control', 'public, max-age=15720000, s-maxage=15720000');
    headers.set('CDN-Cache-Control', 'public, s-maxage=15720000');
    headers.set('Vercel-CDN-Cache-Control', 'public, s-maxage=15720000');
    headers.set('Netlify-Vary', 'query');
    if (cacheStatus) {
      headers.set('X-Image-Cache', cacheStatus);
    }

    return new Response(body, {
      status: 200,
      headers,
    });
  };

  const fetchImage = (url: string) =>
    fetch(url, {
      headers: {
        Referer: referer,
        'User-Agent': userAgent,
      },
    });

  try {
    const cached = await readCache(imageUrl);
    if (cached) {
      const body = Readable.toWeb(cached.stream) as ReadableStream;
      return buildImageResponse(
        body,
        cached.entry.contentType,
        cached.entry.etag,
        'hit',
      );
    }

    let fetchPromise = inFlight.get(imageUrl);
    if (!fetchPromise) {
      fetchPromise = (async (): Promise<FetchResult> => {
        const imageResponse = await fetchImage(imageUrl);
        if (imageResponse.ok) {
          const buffer = Buffer.from(await imageResponse.arrayBuffer());
          const entry: CacheEntry = {
            contentType: imageResponse.headers.get('content-type'),
            etag: imageResponse.headers.get('etag'),
            fetchedAt: Date.now(),
            sourceUrl: imageUrl,
            size: buffer.length,
          };
          try {
            await writeCache(imageUrl, buffer, entry);
          } catch {
            // Ignore cache write failures to keep image delivery working.
          }
          return { type: 'ok', buffer, entry };
        }

        const isDoubanImage = imageUrl.includes('doubanio.com');
        if (imageResponse.status === 403 && isDoubanImage) {
          const tencentUrl = imageUrl.replace(
            /img\d*\.doubanio\.com/g,
            'img.doubanio.cmliussss.net',
          );
          if (tencentUrl && tencentUrl !== imageUrl) {
            const tencentResponse = await fetchImage(tencentUrl);
            if (tencentResponse.ok) {
              const buffer = Buffer.from(await tencentResponse.arrayBuffer());
              const entry: CacheEntry = {
                contentType: tencentResponse.headers.get('content-type'),
                etag: tencentResponse.headers.get('etag'),
                fetchedAt: Date.now(),
                sourceUrl: tencentUrl,
                size: buffer.length,
              };
              try {
                await writeCache(imageUrl, buffer, entry);
              } catch {
                // Ignore cache write failures to keep image delivery working.
              }
              return { type: 'ok', buffer, entry };
            }
          }
          return { type: 'redirect' };
        }

        return {
          type: 'error',
          status: imageResponse.status,
          statusText: imageResponse.statusText,
        };
      })().finally(() => {
        inFlight.delete(imageUrl);
      });
      inFlight.set(imageUrl, fetchPromise);
    }

    const fetched = await fetchPromise;
    if (fetched.type === 'ok') {
      const body = new Uint8Array(fetched.buffer);
      return buildImageResponse(
        body,
        fetched.entry.contentType,
        fetched.entry.etag,
        'miss',
      );
    }

    if (fetched.type === 'redirect') {
      return NextResponse.redirect(imageUrl, 307);
    }

    return NextResponse.json(
      { error: fetched.statusText || 'Failed to fetch image' },
      { status: fetched.status || 502 },
    );
  } catch (error) {
    return NextResponse.json(
      { error: 'Error fetching image' },
      { status: 500 },
    );
  }
}
