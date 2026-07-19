import test from "node:test";
import assert from "node:assert/strict";

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
  const bot = new WeComBot(
    { bot_id: "bot-a", secret: "secret-a" },
    {},
    () => {},
    "/tmp",
    "wecom-work",
    "bot-a",
  );

  await assert.rejects(
    bot.replyMarkdown(target, "reply", false),
    /WeCom reply context is unavailable/,
  );
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
  assert.deepEqual(logs, [{ level: "error", message: "replyStream failed" }]);
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
