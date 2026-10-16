import { Store } from "./store.ts";
import { email, password, text } from "./validation.ts";
import { hashPassword } from "./auth.ts";
try {
  const address = email(process.env.ADMIN_EMAIL),
    pass = password(process.env.ADMIN_PASSWORD),
    name = text(process.env.ADMIN_NAME || "平台管理员", "name", 40);
  const store = new Store(
    process.env.DATABASE_PATH || "data/corematrix.sqlite",
  );
  try {
    if (store.get("SELECT id FROM users WHERE email=?", address))
      throw new Error("该邮箱已存在，不会覆盖密码或提升权限。");
    store.createUser(name, address, await hashPassword(pass), "admin");
    console.log("管理员已创建。请使用配置的邮箱与密码登录。");
  } finally {
    store.close();
  }
} catch (e) {
  console.error(e instanceof Error ? e.message : "创建失败");
  process.exitCode = 1;
}
