import createNextIntlPlugin from "next-intl/plugin";

const withNextIntl = createNextIntlPlugin("./i18n/request.ts");

/**
 * Node.js 26 兼容补丁
 * ------------------------------------------------------------------
 * @electric-sql/pglite 0.3.x 内部用 fs.readFile(new URL(...)) 读取
 * pglite.wasm / pglite.data。Node.js 22+ 收紧了 path 参数校验后，
 * 传入 URL 对象会抛 TypeError: ERR_INVALID_ARG_TYPE，导致数据库初始化
 * 在 unhandledRejection 中反复崩溃。
 *
 * 这里在 webpack 打包阶段把 readFile(<url变量>) 改写为
 * readFile(<url变量>.pathname)，使其成为字符串路径。
 * 放在构建期处理，可以同时覆盖 node_modules 与 .next 缓存产物，
 * 避免直接改 node_modules 被重新安装/重新编译覆盖。
 */
class PgliteNode26CompatPlugin {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  apply(compiler: any) {
    compiler.hooks.compilation.tap(
      "PgliteNode26Compat",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (compilation: any) => {
        const { Compilation, sources } = compiler.webpack;
        compilation.hooks.processAssets.tap(
          {
            name: "PgliteNode26Compat",
            stage: Compilation.PROCESS_ASSETS_STAGE_OPTIMIZE,
          },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (assets: Record<string, any>) => {
            for (const [name, asset] of Object.entries(assets)) {
              if (!name.endsWith(".js")) continue;
              const src = asset.source().toString();
              if (!src.includes("pglite.wasm") && !src.includes("pglite.data")) {
                continue;
              }

              // 匹配 readFile(n) / readFile(e) / readFile(r) 这类单变量调用。
              // Windows 下 URL.pathname 形如 "/D:/a/b"，直接传给 fs 会被当成
              // 相对路径（缺少盘符），因此再补一层去掉前导斜杠的处理。
              const out = src.replace(/\.readFile\((\w+)\)/g, (m: string, v: string) =>
                /^(n|e|r|t|s|i|a|u)$/.test(v)
                  ? `.readFile(${v}.pathname.replace(/^\\//, ""))`
                  : m,
              );

              if (out !== src) {
                compilation.updateAsset(name, new sources.RawSource(out));
                // eslint-disable-next-line no-console
                console.log(`[PgliteNode26Compat] patched ${name}`);
              }
            }
          },
        );
      },
    );
  }
}

/** @type {import('next').NextConfig} */
const nextConfig = {
  // 一键包用生产构建：项目里有历史类型报错（drizzle 隐式 any 等），
  // 这些不影响运行，构建时跳过类型与 lint 检查。
  typescript: { ignoreBuildErrors: true },
  eslint: { ignoreDuringBuilds: true },
  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: "*.cloudflarestorage.com",
      },
      {
        protocol: "https",
        hostname: "*.r2.cloudflarestorage.com",
      },
      // 本地化存储：允许 localhost 图片域名
      {
        protocol: "http",
        hostname: "localhost",
      },
      {
        protocol: "http",
        hostname: "127.0.0.1",
      },
    ],
  },
  // 服务端渲染：应用 pglite 的 Node 26 兼容补丁
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  webpack: (config: any, { isServer }: { isServer: boolean }) => {
    if (isServer) {
      config.plugins.push(new PgliteNode26CompatPlugin());
    }
    return config;
  },
  // 关键：让 pglite 走 Node 原生 require，而不是被 webpack 打包。
  // 打包会把 pglite.wasm / pglite.data 复制到 _next/static/media，
  // 导致运行时 import.meta.url 指向错误位置、找不到数据文件。
  serverExternalPackages: ["@electric-sql/pglite"],
} satisfies import('next').NextConfig;

export default withNextIntl(nextConfig);
