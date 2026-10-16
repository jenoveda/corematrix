import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import type { Server } from "node:http";
import { createApplication } from "../server/app.ts";
import { hashPassword } from "../server/auth.ts";

async function listen(server: Server) {
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert(address && typeof address === "object");
  return `http://127.0.0.1:${address.port}`;
}
test("separate listeners isolate roles, sessions, CSRF, registration and business APIs", async (t) => {
  const app = createApplication({ databasePath: ":memory:", splitPortals: true });
  assert(app.adminServer && app.providerServer);
  const servers = [app.server, app.adminServer, app.providerServer];
  t.after(async () => {
    await Promise.all(servers.map(server => { server.closeAllConnections(); return new Promise<void>(resolve => server.close(() => resolve())); }));
    await app.drain(); app.store.close();
  });
  const userOrigin = await listen(app.server), adminOrigin = await listen(app.adminServer);
  const providerOrigin = await listen(app.providerServer);
  const password = "portal-test-password-123";
  app.store.createUser("Admin", "admin@tests.invalid", await hashPassword(password), "admin");
  async function call(origin: string, path: string, method = "GET", body?: unknown, cookie = "", csrf = "", from = origin) {
    const response = await fetch(origin + path, { method, headers: {
      Origin: from, "Content-Type": "application/json", Cookie: cookie, "X-CSRF-Token": csrf,
      "X-CoreMatrix-Portal": "admin",
    }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, data: await response.json(), cookie: response.headers.get("set-cookie")?.split(";")[0] || "" };
  }
  const credentials = { email: "user@tests.invalid", password, name: "User", role: "admin" };
  assert.equal((await call(adminOrigin, "/api/auth/register", "POST", credentials)).status, 404);
  const user = await call(userOrigin, "/api/auth/register", "POST", credentials);
  assert.equal(user.status, 201); assert.equal(user.data.user.role, "user");
  assert(user.cookie.startsWith("cm_user_session="));
  const provider = await call(providerOrigin,"/api/auth/register","POST",{...credentials,email:"provider@tests.invalid"});
  assert.equal(provider.status,201); assert.equal(provider.data.user.role,"provider");
  assert(provider.cookie.startsWith("cm_provider_session="));
  assert.equal((await call(userOrigin,"/api/auth/login","POST",{...credentials,email:"provider@tests.invalid"})).status,401);
  assert.equal((await call(providerOrigin,"/api/auth/login","POST",credentials)).status,401);
  for(const path of ["/api/admin/providers","/api/wallet","/v1/models","/api/agent/poll"])
    assert.equal((await call(providerOrigin,path,"GET",undefined,provider.cookie)).status,404);
  assert.equal((await call(providerOrigin,"/api/provider/profile","GET",undefined,provider.cookie)).data.profile.status,"pending");
  assert.equal((await call(providerOrigin,"/api/provider/profile","GET",undefined,user.cookie.replace("cm_user_","cm_provider_"))).status,401);
  assert.equal((await call(userOrigin,"/api/provider/profile","GET",undefined,provider.cookie)).status,404);
  assert.equal((await call(adminOrigin, "/api/auth/login", "POST", credentials)).status, 401);
  assert.equal((await call(userOrigin, "/api/auth/login", "POST", { email: "admin@tests.invalid", password })).status, 401);
  const admin = await call(adminOrigin, "/api/auth/login", "POST", { email: "admin@tests.invalid", password });
  assert.equal(admin.status, 200); assert(admin.cookie.startsWith("cm_admin_session="));
  const both = user.cookie + "; " + admin.cookie;
  assert.equal((await call(userOrigin, "/api/state", "GET", undefined, both)).data.user.id, user.data.user.id);
  assert.equal((await call(adminOrigin, "/api/state", "GET", undefined, both)).data.user.id, admin.data.user.id);
  assert.equal((await call(userOrigin, "/api/admin/models", "GET", undefined, both)).status, 404);
  for (const path of ["/api/wallet", "/api/keys", "/v1/models", "/api/agent/poll", "/api/auth/forgot-password"])
    assert.equal((await call(adminOrigin, path, "GET", undefined, both)).status, 404);
  assert.equal((await call(adminOrigin, "/api/admin/models", "GET", undefined, user.cookie.replace("cm_user_", "cm_admin_"))).status, 401);
  assert(!((await call(userOrigin, "/api/state", "GET", undefined, admin.cookie.replace("cm_admin_", "cm_user_"))).data.user));
  assert.equal((await call(adminOrigin, "/api/account/preferences", "PUT", { locale: "en-US" }, both, user.data.csrfToken)).status, 403);
  assert.equal((await call(adminOrigin, "/api/account/preferences", "PUT", { locale: "en-US" }, both, admin.data.csrfToken, userOrigin)).status, 403);
  assert.equal((await call(adminOrigin, "/api/account/preferences", "PUT", { locale: "en-US" }, both, admin.data.csrfToken)).status, 200);
  assert.equal((await call(adminOrigin, "/api/auth/logout", "POST", {}, both, admin.data.csrfToken)).status, 200);
  assert(!((await call(adminOrigin, "/api/state", "GET", undefined, both)).data.user));
  assert.equal((await call(userOrigin, "/api/state", "GET", undefined, both)).data.user.id, user.data.user.id);
});
