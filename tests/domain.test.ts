import test from "node:test";
import assert from "node:assert/strict";
import { cost, email, validateEndpoint } from "../server/validation.ts";
import { hashPassword, verifyPassword } from "../server/auth.ts";

test("按实际 Token 使用 BigInt 计算微元费用，向上取整到最小单位", () => {
  assert.equal(cost(2_000_000, 6_000_000, 1200, 600), 6000);
  assert.equal(cost(1, 1, 1, 0), 1);
  assert.equal(
    cost(10_000_000_000, 10_000_000_000, 1_000_000, 100_000),
    11_000_000_000,
  );
});
test("密码使用随机盐，正确与错误密码验证", async () => {
  const a = await hashPassword("test-password-123"),
    b = await hashPassword("test-password-123");
  assert.notEqual(a, b);
  assert.equal(await verifyPassword("test-password-123", a), true);
  assert.equal(await verifyPassword("wrong-password", a), false);
});
test("邮箱规范化与推理地址白名单", () => {
  assert.equal(email(" USER@Example.COM "), "user@example.com");
  const origins = new Set(["http://127.0.0.1:8000"]);
  assert.equal(
    validateEndpoint("http://127.0.0.1:8000/v1/chat/completions", origins),
    "http://127.0.0.1:8000/v1/chat/completions",
  );
  for (const url of [
    "http://169.254.169.254/latest/meta-data",
    "file:///etc/passwd",
    "http://name:secret@127.0.0.1:8000/v1",
    "http://127.0.0.1:8000/v1?secret=x",
  ])
    assert.throws(() => validateEndpoint(url, origins));
});
