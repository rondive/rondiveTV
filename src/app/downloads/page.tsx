/* eslint-disable @typescript-eslint/no-explicit-any */

'use client';

import { useEffect, useMemo, useRef, useState } from 'react';

import PageLayout from '@/components/PageLayout';

type DownloadJob = {
  id: string;
  status: 'queued' | 'running' | 'completed' | 'failed';
  progress?: {
    percent?: number;
    speed?: string;
    message?: string;
  };
  filename?: string | null;
  sizeBytes?: number | null;
  error?: string | null;
  createdAt?: number;
  updatedAt?: number;
  title?: string | null;
  year?: string | null;
  episode?: string | null;
  episodeTitle?: string | null;
};

const formatBytes = (bytes?: number | null) => {
  if (!bytes || bytes <= 0) return '-';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let idx = 0;
  while (value >= 1024 && idx < units.length - 1) {
    value /= 1024;
    idx += 1;
  }
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[idx]}`;
};

const formatJobTitle = (job: DownloadJob) => {
  const parts: string[] = [];
  if (job.title) parts.push(job.title);
  if (job.year) parts.push(`(${job.year})`);
  if (job.episode) parts.push(`E${job.episode}`);
  if (job.episodeTitle) parts.push(job.episodeTitle);
  if (parts.length > 0) return parts.join(' ');
  return job.filename || job.id;
};

const formatTime = (timestamp?: number) => {
  if (!timestamp) return '-';
  return new Date(timestamp).toLocaleString();
};

const statusLabels: Record<DownloadJob['status'], string> = {
  queued: '排队中',
  running: '下载中',
  completed: '已完成',
  failed: '已失败',
};

const statusColors: Record<DownloadJob['status'], string> = {
  queued: 'bg-yellow-100 text-yellow-700',
  running: 'bg-blue-100 text-blue-700',
  completed: 'bg-green-100 text-green-700',
  failed: 'bg-red-100 text-red-700',
};

export default function DownloadsPage() {
  const [jobs, setJobs] = useState<DownloadJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const pollingRef = useRef<NodeJS.Timeout | null>(null);

  const hasActiveJobs = useMemo(
    () => jobs.some((job) => job.status === 'queued' || job.status === 'running'),
    [jobs]
  );

  const fetchJobs = async (silent = false) => {
    if (!silent) setLoading(true);
    setError(null);
    try {
      const resp = await fetch(`/api/download/list?_t=${Date.now()}`);
      if (!resp.ok) {
        const data = await resp.json().catch(() => ({}));
        throw new Error(data?.error || '获取下载列表失败');
      }
      const data = await resp.json();
      setJobs(Array.isArray(data?.jobs) ? data.jobs : []);
    } catch (err) {
      const message = err instanceof Error ? err.message : '获取下载列表失败';
      setError(message);
    } finally {
      if (!silent) setLoading(false);
    }
  };

  const triggerDownload = (jobId: string) => {
    const url = `/api/download/file?jobId=${encodeURIComponent(jobId)}&_t=${Date.now()}`;
    let iframe = iframeRef.current;
    if (!iframe) {
      iframe = document.createElement('iframe');
      iframe.style.display = 'none';
      iframe.setAttribute('aria-hidden', 'true');
      iframe.tabIndex = -1;
      document.body.appendChild(iframe);
      iframeRef.current = iframe;
    }
    iframe.src = url;
  };

  const cancelJob = async (jobId: string) => {
    await fetch('/api/download/cancel', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobId }),
    });
    await fetchJobs(true);
  };

  useEffect(() => {
    void fetchJobs();
    return () => {
      if (pollingRef.current) clearTimeout(pollingRef.current);
    };
  }, []);

  useEffect(() => {
    if (pollingRef.current) {
      clearTimeout(pollingRef.current);
      pollingRef.current = null;
    }
    if (!hasActiveJobs) return;
    pollingRef.current = setTimeout(() => {
      void fetchJobs(true);
    }, 4000);
  }, [hasActiveJobs, jobs]);

  return (
    <PageLayout activePath='/downloads'>
      <div className='w-full py-6'>
        <div className='flex items-center justify-between mb-6'>
          <div>
            <h1 className='text-2xl font-semibold text-gray-900 dark:text-white'>
              下载中心
            </h1>
            <p className='text-sm text-gray-500 dark:text-gray-400 mt-1'>
              查看正在下载与历史任务
            </p>
          </div>
          <button
            onClick={() => fetchJobs()}
            className='px-4 py-2 text-sm font-medium rounded-lg bg-blue-600 text-white hover:bg-blue-700 transition-colors'
          >
            刷新
          </button>
        </div>

        {loading ? (
          <div className='py-16 text-center text-gray-500'>加载中...</div>
        ) : error ? (
          <div className='py-16 text-center text-red-500'>{error}</div>
        ) : jobs.length === 0 ? (
          <div className='py-16 text-center text-gray-500'>暂无下载记录</div>
        ) : (
          <div className='space-y-4'>
            {jobs.map((job) => {
              const percent =
                typeof job.progress?.percent === 'number'
                  ? job.progress.percent
                  : null;
              return (
                <div
                  key={job.id}
                  className='border border-gray-200 dark:border-gray-700 rounded-xl p-4 bg-white/70 dark:bg-gray-900/60 backdrop-blur'
                >
                  <div className='flex flex-col md:flex-row md:items-center md:justify-between gap-4'>
                    <div className='flex-1 min-w-0'>
                      <div className='flex items-center gap-3 flex-wrap'>
                        <span className='text-base font-semibold text-gray-900 dark:text-white truncate max-w-[360px]'>
                          {formatJobTitle(job)}
                        </span>
                        <span
                          className={`text-xs font-medium px-2 py-1 rounded-full ${statusColors[job.status]}`}
                        >
                          {statusLabels[job.status]}
                        </span>
                        {job.progress?.speed && (
                          <span className='text-xs text-gray-500'>
                            {job.progress.speed}
                          </span>
                        )}
                      </div>
                      <div className='text-xs text-gray-500 mt-2 flex flex-wrap gap-4'>
                        <span>创建：{formatTime(job.createdAt)}</span>
                        <span>更新：{formatTime(job.updatedAt)}</span>
                        <span>大小：{formatBytes(job.sizeBytes)}</span>
                      </div>
                      {job.status === 'running' || job.status === 'queued' ? (
                        <div className='mt-3'>
                          <div className='w-full h-2 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden'>
                            <div
                              className='h-2 bg-blue-500 transition-all'
                              style={{
                                width: `${percent !== null ? percent : 10}%`,
                              }}
                            />
                          </div>
                          <div className='text-xs text-gray-500 mt-1'>
                            {percent !== null ? `${percent}%` : '准备中...'}
                          </div>
                        </div>
                      ) : null}
                      {job.status === 'failed' && job.error && (
                        <div className='text-xs text-red-500 mt-2'>
                          {job.error}
                        </div>
                      )}
                    </div>
                    <div className='flex items-center gap-3 flex-shrink-0'>
                      {job.status === 'completed' && (
                        <button
                          onClick={() => triggerDownload(job.id)}
                          className='px-4 py-2 text-sm font-medium rounded-lg bg-green-600 text-white hover:bg-green-700 transition-colors'
                        >
                          下载文件
                        </button>
                      )}
                      {(job.status === 'running' || job.status === 'queued') && (
                        <button
                          onClick={() => cancelJob(job.id)}
                          className='px-4 py-2 text-sm font-medium rounded-lg bg-red-600 text-white hover:bg-red-700 transition-colors'
                        >
                          取消
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </PageLayout>
  );
}
