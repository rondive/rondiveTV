import { useEffect, useRef } from 'react';

type ImagePreloadOptions = {
  maxPreload?: number;
  maxBatch?: number;
  maxStored?: number;
  fetchPriority?: 'low' | 'auto' | 'high';
  idleTimeoutMs?: number;
  transformUrl?: (url: string) => string;
};

/**
 * Hook to preload images for better UX
 * Adds <link rel="preload"> tags for images that are about to enter the viewport
 */
export function useImagePreload(
  imageUrls: string[],
  enabled = true,
  options: ImagePreloadOptions = {}
) {
  const {
    maxPreload = 12,
    maxBatch = 4,
    maxStored = Math.max(maxPreload * 3, 24),
    fetchPriority = 'low',
    idleTimeoutMs = 200,
    transformUrl,
  } = options;
  const preloadLinksRef = useRef<Map<string, HTMLLinkElement>>(new Map());
  const pendingUrlsRef = useRef<string[]>([]);
  const idleIdRef = useRef<number | null>(null);
  const timeoutIdRef = useRef<number | null>(null);

  useEffect(() => {
    if (!enabled || !imageUrls.length) return;
    if (typeof document === 'undefined') return;

    const connection = (navigator as any)?.connection;
    if (connection?.saveData) return;
    if (typeof connection?.effectiveType === 'string') {
      const effectiveType = connection.effectiveType;
      if (effectiveType === 'slow-2g' || effectiveType === '2g') return;
    }

    const urlsToPreload: string[] = [];
    const seen = new Set<string>();

    for (const rawUrl of imageUrls) {
      if (!rawUrl) continue;
      const url = transformUrl ? transformUrl(rawUrl) : rawUrl;
      if (!url || seen.has(url)) continue;
      seen.add(url);
      urlsToPreload.push(url);
      if (urlsToPreload.length >= maxPreload) break;
    }

    if (!urlsToPreload.length) return;

    const queue = urlsToPreload.filter((url) => !preloadLinksRef.current.has(url));
    if (!queue.length) return;

    pendingUrlsRef.current = queue.slice();

    const enqueueLink = (url: string) => {
      if (preloadLinksRef.current.has(url)) return;
      const link = document.createElement('link');
      link.rel = 'preload';
      link.as = 'image';
      link.href = url;
      link.setAttribute('fetchpriority', fetchPriority);
      document.head.appendChild(link);
      preloadLinksRef.current.set(url, link);

      while (preloadLinksRef.current.size > maxStored) {
        const oldestKey = preloadLinksRef.current.keys().next().value as string | undefined;
        if (!oldestKey) break;
        const oldestLink = preloadLinksRef.current.get(oldestKey);
        if (oldestLink?.parentNode) {
          oldestLink.parentNode.removeChild(oldestLink);
        }
        preloadLinksRef.current.delete(oldestKey);
      }
    };

    const processQueue = () => {
      idleIdRef.current = null;
      timeoutIdRef.current = null;
      const batchSize = Math.min(maxBatch, maxPreload);
      let count = 0;
      while (pendingUrlsRef.current.length && count < batchSize) {
        const nextUrl = pendingUrlsRef.current.shift();
        if (nextUrl) {
          enqueueLink(nextUrl);
          count += 1;
        }
      }
      if (pendingUrlsRef.current.length) {
        scheduleQueue();
      }
    };

    const scheduleQueue = () => {
      if (typeof (window as any).requestIdleCallback === 'function') {
        idleIdRef.current = (window as any).requestIdleCallback(processQueue, {
          timeout: idleTimeoutMs,
        });
      } else {
        timeoutIdRef.current = window.setTimeout(processQueue, idleTimeoutMs);
      }
    };

    scheduleQueue();

    // Cleanup: remove preload links when component unmounts
    return () => {
      if (idleIdRef.current !== null && typeof (window as any).cancelIdleCallback === 'function') {
        (window as any).cancelIdleCallback(idleIdRef.current);
      }
      if (timeoutIdRef.current !== null) {
        clearTimeout(timeoutIdRef.current);
      }
      idleIdRef.current = null;
      timeoutIdRef.current = null;
      pendingUrlsRef.current = [];
    };
  }, [
    imageUrls,
    enabled,
    maxPreload,
    maxBatch,
    maxStored,
    fetchPriority,
    idleTimeoutMs,
    transformUrl,
  ]);

  useEffect(() => {
    return () => {
      preloadLinksRef.current.forEach((link) => {
        if (link.parentNode) {
          link.parentNode.removeChild(link);
        }
      });
      preloadLinksRef.current.clear();
    };
  }, []);
}
