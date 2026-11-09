import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import * as schema from "./schema";
import path from "path";

/**
 * 本地化数据库（PGlite 嵌入式 PostgreSQL）
 * ------------------------------------------------------------------
 * PGlite 是 WASM 内核的嵌入式 PostgreSQL，无需安装任何数据库服务，
 * 数据直接持久化在本地文件夹。此方案让本项目完全脱离 Docker /
 * 独立 PostgreSQL 安装。
 *
 * 数据目录：LOCAL_PGLITE_DIR（默认 <项目根>/data/pglite）
 */

const pgliteDir = process.env.LOCAL_PGLITE_DIR
  ? path.resolve(process.env.LOCAL_PGLITE_DIR)
  : path.join(process.cwd(), "data", "pglite");

// ⚠️ 必须是全局单例
// Next.js 开发模式下每个路由/页面都是独立编译的模块，模块级变量会被重复执行。
// 如果每次都 new PGlite(同一目录)，就会同时存在多个实例争用同一数据目录，表现为：
//     RuntimeError: Aborted(). Build with -sASSERTIONS for more info.
// 所以把实例挂到 globalThis 复用，保证整进程只有一个连接。
type GlobalWithPglite = typeof globalThis & {
  __promptLensPglite?: PGlite;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  __promptLensDb?: any;
};

const globalForDb = globalThis as GlobalWithPglite;

const client = globalForDb.__promptLensPglite ?? new PGlite(pgliteDir);

export const db = globalForDb.__promptLensDb ?? drizzle(client, { schema });

globalForDb.__promptLensPglite = client;
globalForDb.__promptLensDb = db;

export { client as pgliteClient };
export * from "./schema";
