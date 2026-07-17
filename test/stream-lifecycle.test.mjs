import test from "node:test";
import assert from "node:assert/strict";

import { AgentStreamHandler } from "../dist/agent-stream.js";

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
