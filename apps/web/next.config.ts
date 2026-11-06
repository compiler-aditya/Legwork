import type { NextConfig } from 'next';

const config: NextConfig = {
  reactStrictMode: true,
  // The monorepo root holds the lockfile; trace from there.
  outputFileTracingRoot: new URL('../../', import.meta.url).pathname,
};

export default config;
