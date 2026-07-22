/**
 * WeCom stream renderer — uses replyStream to replace message content.
 *
 * WeCom `replyStream` uses a single `streamId` per inbound message and
 * REPLACES the content each time. This renderer rebuilds the full message
 * from scratch on every flush: header + sealed blocks + current block.
 *
 * Overrides host notifications to accumulate in header
 * (instead of sending separate messages via sendText).
 */

import {
  BlockRenderer,
  type BlockKind,
  type ChannelSessionInfo,
  type ChannelTarget,
  type OutboundFile,
  type VerboseConfig,
  channelTargetKey,
} from "@vibearound/plugin-channel-sdk";
import type { WeComBot } from "./bot.js";

type LogFn = (level: string, msg: string) => void;

export class AgentStreamHandler extends BlockRenderer<string> {
  private wecomBot: WeComBot;
  private log: LogFn;

  /** Persistent header per turn: agent info, session id, system messages. */
  private header = new Map<string, string[]>();
  /** Completed blocks from this turn. */
  private sealedBlocks = new Map<string, string[]>();
  /** Currently-streaming block content. */
  private currentBlock = new Map<string, string>();

  constructor(wecomBot: WeComBot, log: LogFn, verbose?: Partial<VerboseConfig>) {
    super({
      streaming: true,
      flushIntervalMs: 800,
      minEditIntervalMs: 1000,
      verbose,
    });
    this.wecomBot = wecomBot;
    this.log = log;
  }

  protected async sendText(target: ChannelTarget, text: string): Promise<void> {
    // Text notifications and permission prompts can arrive mid-turn. Only
    // onAfterTurnEnd/onAfterTurnError may finish the pinned reply stream.
    await this.wecomBot.replyMarkdown(target, text, false);
  }

  protected async sendFile(
    target: ChannelTarget,
    file: OutboundFile,
  ): Promise<void> {
    await this.wecomBot.replyFile(target, file);
  }

  protected formatContent(kind: BlockKind, content: string, _sealed: boolean): string {
    switch (kind) {
      case "thinking": return `> 💭 ${content}`;
      case "tool":     return `\`${content.trim()}\``;
      case "text":     return content;
    }
  }

  protected async sendBlock(target: ChannelTarget, _kind: BlockKind, content: string): Promise<string | null> {
    const key = channelTargetKey(target);
    const prev = this.currentBlock.get(key);
    if (prev) {
      const sealed = this.sealedBlocks.get(key) ?? [];
      sealed.push(prev);
      this.sealedBlocks.set(key, sealed);
    }
    this.currentBlock.set(key, content);
    await this.flushToWeCom(target, false);
    return "stream";
  }

  protected async editBlock(
    target: ChannelTarget,
    _ref: string,
    _kind: BlockKind,
    content: string,
    _sealed: boolean,
  ): Promise<void> {
    this.currentBlock.set(channelTargetKey(target), content);
    await this.flushToWeCom(target, false);
  }

  protected async onAfterTurnEnd(target: ChannelTarget): Promise<void> {
    await this.flushToWeCom(target, true);
    this.clearState(target);
    this.log("debug", `turn_complete chat=${target.chatId}`);
  }

  protected async onAfterTurnError(target: ChannelTarget, error: string): Promise<void> {
    this.currentBlock.set(channelTargetKey(target), `❌ Error: ${error}`);
    await this.flushToWeCom(target, true);
    this.clearState(target);
  }

  // Override prompt lifecycle to clear WeCom-specific state
  onPromptSent(target: ChannelTarget): void {
    this.clearState(target);
    super.onPromptSent(target);
  }

  // Override notification handlers — accumulate in header instead of sendText
  onSystemText(target: ChannelTarget, text: string): void {
    this.appendHeader(target, text);
    super.onSystemText(target, this.buildFull(target));
  }

  onSessionInfo(target: ChannelTarget, info: ChannelSessionInfo): void {
    this.rememberSessionInfo(target, info);
    if (!target.replyTo) return;
    const agentVersion = info.agent.version ? ` v${info.agent.version}` : "";
    const profile = info.agent.profileId ?? "default";
    const sessionLine =
      info.start === "new"
        ? `📋 New session: ${info.sessionId}`
        : `📋 Continuing session: ${info.sessionId}`;
    this.appendHeader(
      target,
      [
        "ℹ️ VibeAround session",
        `Workspace: ${info.workspacePath}`,
        `Agent: ${info.agent.name}${agentVersion}`,
        `Profile: ${profile}`,
        sessionLine,
      ].join("\n"),
    );
    super.onSystemText(target, this.buildFull(target));
  }

  /** @deprecated `va/session_info` carries the visible startup card. */
  onAgentReady(target: ChannelTarget, agent: string, version: string): void {
    if (!target.replyTo) return;
    this.appendHeader(target, `🤖 Agent: ${agent} v${version}`);
    super.onSystemText(target, this.buildFull(target));
  }

  /** @deprecated `va/session_info` carries the visible startup card. */
  onSessionReady(target: ChannelTarget, sessionId: string): void {
    if (!target.replyTo) return;
    this.appendHeader(target, `📋 Session: ${sessionId}`);
    super.onSystemText(target, this.buildFull(target));
  }

  // --- Internals ---

  private appendHeader(target: ChannelTarget, text: string): void {
    const key = channelTargetKey(target);
    const h = this.header.get(key) ?? [];
    h.push(text);
    this.header.set(key, h);
  }

  private buildFull(target: ChannelTarget): string {
    const key = channelTargetKey(target);
    const h = this.header.get(key) ?? [];
    const sealed = this.sealedBlocks.get(key) ?? [];
    const current = this.currentBlock.get(key) ?? "";
    const parts: string[] = [];
    if (h.length > 0) parts.push(h.join("\n"));
    if (sealed.length > 0) parts.push(sealed.join("\n\n"));
    if (current) parts.push(current);
    return parts.join("\n\n");
  }

  private async flushToWeCom(target: ChannelTarget, finish: boolean): Promise<void> {
    const full = this.buildFull(target);
    if (full) await this.wecomBot.replyMarkdown(target, full, finish);
  }

  private clearState(target: ChannelTarget): void {
    const key = channelTargetKey(target);
    this.header.delete(key);
    this.sealedBlocks.delete(key);
    this.currentBlock.delete(key);
  }
}
