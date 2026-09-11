import type { NextConfig } from 'next';

const config: NextConfig = {
  // pg is a native Node driver; keep it out of the bundle (server-only).
  serverExternalPackages: ['pg'],
};

export default config;
