import { NextResponse } from "next/server";

export async function GET() {
  return NextResponse.json({
    SILICONFLOW_API_KEY: !!process.env.SILICONFLOW_API_KEY,
    DEEPSEEK_API_KEY: !!process.env.DEEPSEEK_API_KEY,
    // 本地化部署：存储与数据库均指向本地目录
    LOCAL_STORAGE_DIR: process.env.LOCAL_STORAGE_DIR || "(default data/storage)",
    LOCAL_PGLITE_DIR: process.env.LOCAL_PGLITE_DIR || "(default data/pglite)",
    NEXT_PUBLIC_SITE_URL: process.env.NEXT_PUBLIC_SITE_URL,
  });
}
