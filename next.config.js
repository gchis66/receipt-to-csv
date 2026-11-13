/** @type {import('next').NextConfig} */
const nextConfig = {
  eslint: { ignoreDuringBuilds: true },
  // A stray package-lock.json exists in a parent directory (C:\Users\Greg),
  // which makes Next infer the wrong workspace root and emit a warning. Pin the
  // root to this project so file tracing and the build are deterministic.
  outputFileTracingRoot: __dirname,
};

module.exports = nextConfig;
