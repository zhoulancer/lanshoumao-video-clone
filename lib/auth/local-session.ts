/**
 * 本地单用户模式。
 *
 * 移除用户登录系统后，所有需要认证的 API 均返回该固定本地用户，
 * 使配额、历史、上传等以 userId 关联的数据链路照常工作，同时无需任何登录。
 */
export interface LocalSessionUser {
  id: string;
  email: string;
  name: string;
  role: "user" | "admin";
  emailVerified: boolean;
}

export const LOCAL_USER: LocalSessionUser = {
  // 必须是合法 UUID：数据库 user.id 列类型为 uuid，
  // 用 "local-user" 这类字符串会报 invalid input syntax for type uuid
  id: "00000000-0000-4000-8000-000000000001",
  email: "local@local.local",
  name: "Local User",
  role: "admin", // 本地单用户：管理员权限，不受试用配额限制
  emailVerified: true,
};

/** 恒返回本地会话（替代 auth.api.getSession）。 */
export function getLocalSession(): { user: LocalSessionUser } {
  return { user: LOCAL_USER };
}

/** 获取本地用户 ID。 */
export function getLocalUserId(): string {
  return LOCAL_USER.id;
}
