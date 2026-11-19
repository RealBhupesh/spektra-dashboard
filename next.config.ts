import type { NextConfig } from "next";
const nextConfig: NextConfig = {
  images: { unoptimized: true },
  // Embedded Postgres is test-only (SQL_DRIVER=pglite); keep it out of the bundle.
  serverExternalPackages: ["@electric-sql/pglite"],
};
export default nextConfig;
