import { test } from "node:test";
import assert from "node:assert/strict";
import { publicOrigin, allowedHost } from "../src/server/hosting.js";
test("hosted mode requires a configured HTTPS origin and preserves strict host boundaries", () => {
  for (const value of [
    "http://example.com",
    "https://user:secret@example.com",
    "https://example.com/path",
    "https://example.com/?key=secret",
  ])
    assert.throws(() => publicOrigin(value));
  const origin = publicOrigin("https://books.example.com/");
  assert.equal(origin, "https://books.example.com");
  assert.equal(allowedHost("books.example.com", 10000, origin), true);
  assert.equal(allowedHost("evil.example", 10000, origin), false);
  assert.equal(allowedHost("127.0.0.1:10000", 10000, origin), false);
  assert.equal(allowedHost("127.0.0.1:4317", 4317, null), true);
  assert.equal(allowedHost("books.example.com", 4317, null), false);
});
