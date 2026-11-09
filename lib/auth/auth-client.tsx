"use client";

import { createAuthClient } from "better-auth/react";
import { anonymousClient } from "better-auth/client/plugins";
import { ReactNode } from "react";
import { LOCAL_USER } from "@/lib/auth/local-session";

export const authClient = createAuthClient({
  baseURL: typeof window !== "undefined" ? window.location.origin : undefined,
  plugins: [anonymousClient()],
});

// -------------------------------------------------------------------
// 单机模式：前端也视为始终已登录
// 不再向后端轮询 session，直接返回本地用户，避免首页/看板跳转到 /login。
//
// 重要：必须返回「同一个对象引用」。
// 如果每次调用都新建 { data: {...} }，那么依赖 session?.user 的
// useCallback / useEffect 每次渲染都会认为依赖变化，从而无限重复请求
// 与重渲染，表现为页面不停抖动。
// -------------------------------------------------------------------
const LOCAL_SESSION = {
  data: { user: { ...LOCAL_USER, isAnonymous: false } },
  isPending: false,
  error: null,
} as const;

export const useSession = () => LOCAL_SESSION;

export const { signIn, signOut, signUp } = authClient;

// AuthProvider 组件
export function AuthProvider({ children }: { children: ReactNode }) {
  return children;
}
