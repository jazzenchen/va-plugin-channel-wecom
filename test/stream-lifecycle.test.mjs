import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { AgentStreamHandler } from "../dist/agent-stream.js";
import { WeComBot } from "../dist/bot.js";

const target = {
  channelInstanceId: "wecom-work",
  actorId: "bot-a",
  chatId: "group:chat-a",
  replyTo: "message-a",
};

test("mode updates do not finish the WeCom reply stream before turn end", async () => {
  const replies = [];
  const bot = {
    async replyMarkdown(channelTarget, content, finish) {
      replies.push({ channelTarget, content, finish });
    },
  };
  const renderer = new AgentStreamHandler(bot, () => {});

  renderer.onPromptSent(target);
  renderer.onSessionUpdate(target, {
    sessionId: "session-a",
    update: {
      sessionUpdate: "current_mode_update",
      currentModeId: "plan",
    },
  });
  renderer.onSessionUpdate(target, {
    sessionId: "session-a",
    update: {
      sessionUpdate: "agent_message_chunk",
      messageId: "message-a",
      content: { type: "text", text: "still running" },
    },
  });

  await renderer.onTurnEnd(target);

  assert.ok(replies.length >= 3);
  assert.equal(replies.at(-1).finish, true);
  assert.equal(replies.slice(0, -1).every((reply) => reply.finish === false), true);
  assert.equal(
    replies.some((reply) => reply.content.includes("Plan mode")),
    true,
  );
  assert.equal(
    replies.some((reply) => reply.content.includes("still running")),
    true,
  );
});

test("replyMarkdown rejects when its inbound reply context is missing", async () => {
  const logs = [];
  const bot = new WeComBot(
    { bot_id: "bot-a", secret: "secret-a" },
    {},
    (level, message) => logs.push({ level, message }),
    "/tmp",
    "wecom-work",
    "bot-a",
  );

  await assert.rejects(
    bot.replyMarkdown(target, "reply", false),
    /WeCom reply context is unavailable/,
  );
  assert.deepEqual(logs, []);
});

test("replyMarkdown propagates replyStream API failures", async () => {
  const logs = [];
  const bot = new WeComBot(
    { bot_id: "bot-a", secret: "secret-a" },
    {},
    (level, message) => logs.push({ level, message }),
    "/tmp",
    "wecom-work",
    "bot-a",
  );
  bot.pending.set(target.replyTo, { frame: {}, streamId: "stream-a" });
  const failure = new Error("WeCom replyStream failed");
  bot.client.replyStream = async () => { throw failure; };

  await assert.rejects(
    bot.replyMarkdown(target, "reply", false),
    failure,
  );
  assert.deepEqual(logs, []);
});

test("custom session rendering still enables workspace file delivery", async (t) => {
  const workspace = await mkdtemp(path.join(tmpdir(), "wecom-outbound-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const filePath = path.join(workspace, "report.pdf");
  await writeFile(filePath, "report");
  const files = [];
  const bot = {
    async replyMarkdown() {},
    async replyFile(_target, file) {
      files.push(file);
    },
  };
  const renderer = new AgentStreamHandler(bot, () => {});

  renderer.onPromptSent(target);
  renderer.onSessionInfo(target, {
    workspacePath: workspace,
    sessionId: "session-a",
    start: "new",
    agent: { name: "Agent" },
  });
  renderer.onSessionUpdate(target, {
    sessionId: "session-a",
    update: {
      sessionUpdate: "agent_message_chunk",
      content: {
        type: "resource_link",
        uri: pathToFileURL(filePath).href,
        name: "report.pdf",
      },
    },
  });
  await renderer.onTurnEnd(target);

  assert.equal(files.length, 1);
  assert.equal(files[0].path, await realpath(filePath));
  assert.equal(files[0].name, "report.pdf");
});

test("WeCom uploads a file against the pinned reply frame", async (t) => {
  const workspace = await mkdtemp(path.join(tmpdir(), "wecom-upload-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const filePath = path.join(workspace, "report.pdf");
  await writeFile(filePath, "report");
  const bot = new WeComBot(
    { bot_id: "bot-a", secret: "secret-a" },
    {},
    () => {},
    "/tmp",
    "wecom-work",
    "bot-a",
  );
  const frame = {};
  bot.pending.set(target.replyTo, { frame, streamId: "stream-a" });
  bot.client.uploadMedia = async (contents, options) => {
    assert.equal(contents.toString(), "report");
    assert.deepEqual(options, { type: "file", filename: "report.pdf" });
    return { media_id: "media-a" };
  };
  const replies = [];
  bot.client.replyMedia = async (...args) => replies.push(args);

  await bot.replyFile(target, {
    path: filePath,
    name: "report.pdf",
  });

  assert.deepEqual(replies, [[frame, "file", "media-a"]]);
});

test("SDK logger stays silent while lifecycle handlers own failures", () => {
  const logs = [];
  const bot = new WeComBot(
    { bot_id: "bot-a", secret: "secret-a" },
    {},
    (level, message) => logs.push({ level, message }),
    "/tmp",
    "wecom-work",
    "bot-a",
  );

  bot.client.logger.debug("inbound frame");
  bot.client.logger.info("outbound frame");
  bot.client.logger.warn("connection warning");
  bot.client.logger.error("connection error");

  assert.deepEqual(logs, []);
});

test("notification delivery failure is reported by onTurnEnd", async () => {
  const bot = {
    async replyMarkdown() {
      throw new Error("notification delivery failed");
    },
  };
  const renderer = new AgentStreamHandler(bot, () => {});

  renderer.onPromptSent(target);
  renderer.onSystemText(target, "system notice");

  await assert.rejects(
    renderer.onTurnEnd(target),
    /notification delivery failed/,
  );
});

test("final replyStream failure rejects onTurnEnd", async () => {
  const bot = {
    async replyMarkdown(_channelTarget, _content, finish) {
      if (finish) throw new Error("final reply failed");
    },
  };
  const renderer = new AgentStreamHandler(bot, () => {});

  renderer.onPromptSent(target);
  renderer.onSessionUpdate(target, {
    sessionId: "session-a",
    update: {
      sessionUpdate: "agent_message_chunk",
      messageId: "message-a",
      content: { type: "text", text: "agent reply" },
    },
  });

  await assert.rejects(renderer.onTurnEnd(target), /final reply failed/);
});
