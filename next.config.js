/** @type {import('next').NextConfig} */
const runtimeCaching = require('next-pwa/cache');

const customRuntimeCaching = [
  {
    urlPattern: /\/api\/image-proxy/,
    handler: 'CacheFirst',
    options: {
      cacheName: 'image-proxy',
      expiration: {
        maxEntries: 400,
        maxAgeSeconds: 60 * 60 * 24 * 30,
      },
      cacheableResponse: {
        statuses: [0, 200],
      },
    },
  },
  {
    urlPattern: /^https?:\/\/img\d*\.doubanio\.com\//,
    handler: 'CacheFirst',
    options: {
      cacheName: 'douban-images-direct',
      expiration: {
        maxEntries: 400,
        maxAgeSeconds: 60 * 60 * 24 * 30,
      },
      cacheableResponse: {
        statuses: [0, 200],
      },
    },
  },
  {
    urlPattern: /^https?:\/\/img\.doubanio\.cmliussss\.(net|com)\//,
    handler: 'CacheFirst',
    options: {
      cacheName: 'douban-images-cdn',
      expiration: {
        maxEntries: 400,
        maxAgeSeconds: 60 * 60 * 24 * 30,
      },
      cacheableResponse: {
        statuses: [0, 200],
      },
    },
  },
  {
    urlPattern: /\/api\/douban/,
    handler: 'StaleWhileRevalidate',
    options: {
      cacheName: 'douban-api',
      expiration: {
        maxEntries: 200,
        maxAgeSeconds: 60 * 60 * 6,
      },
      cacheableResponse: {
        statuses: [0, 200],
      },
    },
  },
];

const useStandalone =
  process.env.DOCKER_ENV === 'true' ||
  process.env.NEXT_OUTPUT_STANDALONE === 'true' ||
  process.env.VERCEL ||
  process.env.DOCKER_BUILD;

const nextConfig = {
  ...(useStandalone ? { output: 'standalone' } : {}),
  reactStrictMode: false,

  compiler: {
    removeConsole:
      process.env.NODE_ENV === 'production'
        ? { exclude: ['error', 'warn'] }
        : false,
  },

  experimental: {
    cpus: 1,
  },

  // Next.js 16 使用 Turbopack，配置 SVG 加载
  turbopack: {
    root: __dirname,
    rules: {
      '*.svg': {
        loaders: ['@svgr/webpack'],
        as: '*.js',
      },
    },
  },

  // Uncoment to add domain whitelist
  images: {
    unoptimized: true,
    remotePatterns: [
      {
        protocol: 'https',
        hostname: '**',
      },
      {
        protocol: 'http',
        hostname: '**',
      },
    ],
  },

  webpack(config) {
    // Grab the existing rule that handles SVG imports
    const fileLoaderRule = config.module.rules.find((rule) =>
      rule.test?.test?.('.svg'),
    );

    config.module.rules.push(
      // Reapply the existing rule, but only for svg imports ending in ?url
      {
        ...fileLoaderRule,
        test: /\.svg$/i,
        resourceQuery: /url/, // *.svg?url
      },
      // Convert all other *.svg imports to React components
      {
        test: /\.svg$/i,
        issuer: { not: /\.(css|scss|sass)$/ },
        resourceQuery: { not: /url/ }, // exclude if *.svg?url
        loader: '@svgr/webpack',
        options: {
          dimensions: false,
          titleProp: true,
        },
      },
    );

    // Modify the file loader rule to ignore *.svg, since we have it handled now.
    fileLoaderRule.exclude = /\.svg$/i;

    config.resolve.fallback = {
      ...config.resolve.fallback,
      net: false,
      tls: false,
      crypto: false,
    };

    return config;
  },
};

const withPWA = require('next-pwa')({
  dest: 'public',
  disable: process.env.NODE_ENV === 'development',
  register: true,
  skipWaiting: true,
  runtimeCaching: [...customRuntimeCaching, ...runtimeCaching],
});

module.exports = withPWA(nextConfig);
