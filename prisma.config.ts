// Prisma 7 config (same shape as Revise's). The CLI reads DATABASE_URL from backend/.env.
// Local dev database: `npm run db:start` (embedded Postgres on 127.0.0.1:5433, see scripts/dev-db.mjs).
import "dotenv/config";
import { defineConfig } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
    // `npx prisma db seed` / `npm run db:seed`: creates the local dev user (refuses in production).
    seed: "ts-node --transpile-only prisma/seed.ts",
  },
  // `prisma generate` (postinstall) works without a URL; migrate/seed need DATABASE_URL.
  datasource: process.env["DATABASE_URL"] ? { url: process.env["DATABASE_URL"] } : {},
});
