import type { Config } from "drizzle-kit";
import path from "path";

export default {
  schema: "./lib/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  driver: "pglite",
  dbCredentials: {
    url: process.env.LOCAL_PGLITE_DIR || path.join(process.cwd(), "data", "pglite"),
  },
} satisfies Config;
