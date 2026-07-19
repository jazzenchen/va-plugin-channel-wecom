import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { WeComBot } from "../dist/bot.js";

test("images with the same URL basename use distinct message item paths", async (t) => {
  const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), "wecom-media-test-"));
  t.after(() => fs.rm(cacheDir, { recursive: true, force: true }));

  t.mock.method(globalThis, "fetch", async (url) => new Response(
    url.endsWith("first") ? "first image" : "second image",
    { headers: { "content-disposition": 'attachment; filename="image.jpg"' } },
  ));

  const bot = new WeComBot(
    { bot_id: "bot-a", secret: "secret-a" },
    {},
    () => {},
    cacheDir,
    "wecom-work",
    "bot-a",
  );

  const first = await bot.downloadImage(
    "group:chat-a",
    "message-a",
    0,
    { url: "https://example.test/image.jpg?first" },
  );
  const second = await bot.downloadImage(
    "group:chat-a",
    "message-a",
    1,
    { url: "https://example.test/image.jpg?second" },
  );

  assert.notEqual(first.path, second.path);
  assert.equal(await fs.readFile(first.path, "utf8"), "first image");
  assert.equal(await fs.readFile(second.path, "utf8"), "second image");
});
