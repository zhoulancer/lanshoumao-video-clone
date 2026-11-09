import { db } from "@/lib/db";
import { account, session, user, verification } from "@/lib/db/schema";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { nextCookies } from "better-auth/next-js";
import { anonymous, admin } from "better-auth/plugins";
import { eq } from "drizzle-orm";
import { getAuthBaseURL } from "@/lib/auth/origin";
import { LOCAL_USER } from "@/lib/auth/local-session";

export const auth = betterAuth({
  appName: "Prompt Analyzer",
  baseURL: getAuthBaseURL(),
  secret: process.env.BETTER_AUTH_SECRET,
  session: {
    expiresIn: 60 * 60 * 24 * 30, // Remember sign-ins for 30 days; renew on active use.
    updateAge: 60 * 60 * 24, // Update session every 24 hours
    freshAge: 60 * 5, // Consider session fresh for 5 minutes
    cookieCache: {
      enabled: true,
      maxAge: 10 * 60,
    },
  },
  advanced: {
    database: {
      generateId: () => crypto.randomUUID(),
    },
    cookies: {
      session_token: {
        name: "better-auth.session_token",
        attributes: {
          httpOnly: true,
          sameSite: "lax",
          path: "/",
        },
      },
    },
  },
  account: {
    // Keep state and PKCE encrypted. The auth route scopes this cookie per attempt
    // before sending it to the browser and restores the expected name on callbacks.
    storeStateStrategy: "cookie",
    accountLinking: {
      enabled: true,
      trustedProviders: [],
    },
  },
  user: {
    deleteUser: {
      enabled: true,
    },
  },
  database: drizzleAdapter(db, {
    provider: "pg",
    schema: {
      user: user,
      session: session,
      account: account,
      verification: verification,
    },
  }),
  databaseHooks: {
    user: {
      create: {
        after: async (createdUser) => {
          // 检查是否为管理员邮箱
          const adminEmails = (process.env.ADMIN_EMAILS || "").split(",").map(e => e.trim().toLowerCase());
          const userEmail = createdUser.email?.toLowerCase();

          if (userEmail && adminEmails.includes(userEmail)) {
            await db
              .update(user)
              .set({ role: "admin" })
              .where(eq(user.id, createdUser.id));
            console.log(`User ${createdUser.id} promoted to admin (email: ${createdUser.email})`);
          }
        },
      },
    },
  },
  trustedOrigins: [
    "http://localhost:3000",
    "https://prompt-lens.cc.cd",
    process.env.BETTER_AUTH_URL || "",
    process.env.NEXT_PUBLIC_SITE_URL || "",
    process.env.NEXT_PUBLIC_BETTER_AUTH_URL || "",
  ].filter(Boolean),
  plugins: [
    anonymous(),
    admin(),
    nextCookies(),
  ],
});

// ===================================================================
// 单机模式：移除登录
// -------------------------------------------------------------------
// 用一个固定的本地管理员会话替换 better-auth 的 getSession。
// 这样做的好处是：全部 16 个 API 路由（29 处 auth.api.getSession 调用）
// 无需逐个修改，自动获得已登录用户；配额、历史、上传等以 userId 关联的
// 数据链路照常工作。
//
// 本地用户必须带 role: "admin"，否则 /api/stats、/api/admin/* 等
// 管理员接口会返回 403。
// ===================================================================
const localSession = {
  user: LOCAL_USER,
  session: {
    id: "local-session",
    userId: LOCAL_USER.id,
    expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
    createdAt: new Date(),
    updatedAt: new Date(),
    token: "local-token",
    ipAddress: "127.0.0.1",
    userAgent: "local",
  },
};

// 确保本地用户在 user 表里存在（历史、配额、外键都依赖它）。
// 只在首次调用时执行一次；失败不阻塞请求。
let ensureLocalUserPromise: Promise<void> | null = null;
function ensureLocalUser(): Promise<void> {
  if (!ensureLocalUserPromise) {
    ensureLocalUserPromise = (async () => {
      try {
        await db
          .insert(user)
          .values({
            id: LOCAL_USER.id,
            email: LOCAL_USER.email,
            name: LOCAL_USER.name,
            emailVerified: LOCAL_USER.emailVerified,
            role: LOCAL_USER.role,
          })
          .onConflictDoNothing();
      } catch (error) {
        console.warn("ensureLocalUser failed:", error);
        ensureLocalUserPromise = null; // 允许下次重试
      }
    })();
  }
  return ensureLocalUserPromise;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(auth.api as any).getSession = async () => {
  await ensureLocalUser();
  return localSession;
};

// 辅助函数：检查用户是否为管理员
export async function isAdmin(userId: string): Promise<boolean> {
  const currentUser = await db.query.user.findFirst({
    where: eq(user.id, userId),
  });
  return currentUser?.role === "admin";
}

// 辅助函数：获取当前用户
export async function getCurrentUser(userId: string) {
  return db.query.user.findFirst({
    where: eq(user.id, userId),
  });
}
