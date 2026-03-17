import https from 'https';
import { Api, Bot } from 'grammy';
import fs from 'fs';
import path from 'path';

import { ASSISTANT_NAME, TRIGGER_PATTERN, GROUPS_DIR } from '../config.js';
import { setCurrentSession } from '../db.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import { registerChannel, ChannelOpts } from './registry.js';
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';

function getSessionsDir(groupFolder: string): string {
  return path.join(GROUPS_DIR, groupFolder, 'sessions');
}

function getSessionDir(groupFolder: string, sessionId: string): string {
  return path.join(getSessionsDir(groupFolder), sessionId);
}

function listSessions(groupFolder: string): string[] {
  const sessionsDir = getSessionsDir(groupFolder);
  const sessions: string[] = [];

  if (fs.existsSync(sessionsDir)) {
    const dirs = fs.readdirSync(sessionsDir, { withFileTypes: true });
    for (const d of dirs) {
      if (d.isDirectory() && !d.name.startsWith('.')) {
        sessions.push(d.name);
      }
    }
  }

  return sessions;
}

function createSessionDir(groupFolder: string, sessionId: string): void {
  const sessionDir = getSessionDir(groupFolder, sessionId);
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.mkdirSync(path.join(sessionDir, 'logs'), { recursive: true });
  fs.writeFileSync(
    path.join(sessionDir, 'CLAUDE.md'),
    `# Session: ${sessionId}\n\n`
  );
}


export interface TelegramChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

/**
 * Send a message with Telegram Markdown parse mode, falling back to plain text.
 * Claude's output naturally matches Telegram's Markdown v1 format:
 *   *bold*, _italic_, `code`, ```code blocks```, [links](url)
 */
async function sendTelegramMessage(
  api: { sendMessage: Api['sendMessage'] },
  chatId: string | number,
  text: string,
  options: { message_thread_id?: number } = {},
): Promise<void> {
  try {
    await api.sendMessage(chatId, text, {
      ...options,
      parse_mode: 'Markdown',
    });
  } catch (err) {
    // Fallback: send as plain text if Markdown parsing fails
    logger.debug({ err }, 'Markdown send failed, falling back to plain text');
    await api.sendMessage(chatId, text, options);
  }
}


export class TelegramChannel implements Channel {
  name = 'telegram';

  private bot: Bot | null = null;
  private opts: TelegramChannelOpts;
  private botToken: string;

  constructor(botToken: string, opts: TelegramChannelOpts) {
    this.botToken = botToken;
    this.opts = opts;
  }

  async connect(): Promise<void> {
    this.bot = new Bot(this.botToken, {
      client: {
        baseFetchConfig: { agent: https.globalAgent, compress: true },
      },
    });

    // Command to get chat ID (useful for registration)
    this.bot.command('chatid', (ctx) => {
      const chatId = ctx.chat.id;
      const chatType = ctx.chat.type;
      const chatName =
        chatType === 'private'
          ? ctx.from?.first_name || 'Private'
          : (ctx.chat as any).title || 'Unknown';

      ctx.reply(
        `Chat ID: \`tg:${chatId}\`\nName: ${chatName}\nType: ${chatType}`,
        { parse_mode: 'Markdown' },
      );
    });

    // Command to check bot status
    this.bot.command('ping', (ctx) => {
      ctx.reply(`${ASSISTANT_NAME} is online.`);
    });

    // Command to create a new session
    this.bot.command('new', (ctx) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const group = this.opts.registeredGroups()[chatJid];

      if (!group) {
        ctx.reply('This chat is not registered.');
        return;
      }

      const args = ctx.message?.text?.split(/\s+/).slice(1) || [];
      const sessionId = args[0]?.replace(/[^a-zA-Z0-9_-]/g, '') ||
        `session_${Date.now().toString(36)}`;

      const sessions = listSessions(group.folder);
      if (sessions.includes(sessionId)) {
        ctx.reply(`Session "${sessionId}" already exists. Use /switch ${sessionId} to switch to it.`);
        return;
      }

      createSessionDir(group.folder, sessionId);
      setCurrentSession(chatJid, sessionId);

      logger.info({ chatJid, sessionId }, 'New session created');
      ctx.reply(`✅ New session created: ${sessionId}\n\nCurrent session: ${sessionId}`);
    });

    // Command to list all sessions
    this.bot.command('sessions', (ctx) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const group = this.opts.registeredGroups()[chatJid];

      if (!group) {
        ctx.reply('This chat is not registered.');
        return;
      }

      const sessions = listSessions(group.folder);
      const current = group.currentSession || 'default';

      if (sessions.length === 0) {
        ctx.reply('No sessions found. Use /new to create one.');
        return;
      }

      const list = sessions
        .map(s => s === current ? `📍 ${s} (current)` : `   ${s}`)
        .join('\n');

      ctx.reply(`📚 Sessions:\n\n${list}`);
    });

    // Command to switch session
    this.bot.command('switch', (ctx) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const group = this.opts.registeredGroups()[chatJid];

      if (!group) {
        ctx.reply('This chat is not registered.');
        return;
      }

      const args = ctx.message?.text?.split(/\s+/).slice(1) || [];
      const sessionId = args[0];

      if (!sessionId) {
        ctx.reply('Usage: /switch <session_name>');
        return;
      }

      const sessions = listSessions(group.folder);
      if (!sessions.includes(sessionId)) {
        ctx.reply(`Session "${sessionId}" not found. Use /sessions to see available sessions.`);
        return;
      }

      setCurrentSession(chatJid, sessionId);
      logger.info({ chatJid, sessionId }, 'Switched session');
      ctx.reply(`✅ Switched to session: ${sessionId}`);
    });

    // Command to show current session
    this.bot.command('current', (ctx) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const group = this.opts.registeredGroups()[chatJid];

      if (!group) {
        ctx.reply('This chat is not registered.');
        return;
      }

      const current = group.currentSession || 'default';
      const sessions = listSessions(group.folder);

      ctx.reply(`📍 Current session: ${current}\n\nTotal sessions: ${sessions.length}`);
    });

    // Command to delete a session
    this.bot.command('delete', (ctx) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const group = this.opts.registeredGroups()[chatJid];

      if (!group) {
        ctx.reply('This chat is not registered.');
        return;
      }

      const args = ctx.message?.text?.split(/\s+/).slice(1) || [];
      const sessionId = args[0];

      if (!sessionId) {
        ctx.reply('Usage: /delete <session_name>');
        return;
      }

      const current = group.currentSession || 'default';

      if (sessionId === current) {
        ctx.reply('Cannot delete the current session. Switch to another session first with /switch <name>');
        return;
      }

      if (sessionId === 'default') {
        ctx.reply('Cannot delete the default session.');
        return;
      }

      const sessionDir = getSessionDir(group.folder, sessionId);
      if (!fs.existsSync(sessionDir)) {
        ctx.reply(`Session "${sessionId}" not found.`);
        return;
      }

      try {
        fs.rmSync(sessionDir, { recursive: true, force: true });
        logger.info({ chatJid, sessionId }, 'Session deleted');
        ctx.reply(`✅ Session "${sessionId}" deleted.`);
      } catch (err) {
        logger.error({ err, chatJid, sessionId }, 'Failed to delete session');
        ctx.reply(`Failed to delete session "${sessionId}".`);
      }
    });


    this.bot.on('message:text', async (ctx) => {
      // Skip commands
      if (ctx.message.text.startsWith('/')) return;

      const chatJid = `tg:${ctx.chat.id}`;
      let content = ctx.message.text;
      // Use local timezone format for consistent string comparison with other channels
      const timestamp = new Date(ctx.message.date * 1000).toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' }).replace(' ', 'T') + '+08:00';
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id.toString() ||
        'Unknown';
      const sender = ctx.from?.id.toString() || '';
      const msgId = ctx.message.message_id.toString();

      // Determine chat name
      const chatName =
        ctx.chat.type === 'private'
          ? senderName
          : (ctx.chat as any).title || chatJid;

      // Translate Telegram @bot_username mentions into TRIGGER_PATTERN format.
      // Telegram @mentions (e.g., @andy_ai_bot) won't match TRIGGER_PATTERN
      // (e.g., ^@Andy\b), so we prepend the trigger when the bot is @mentioned.
      const botUsername = ctx.me?.username?.toLowerCase();
      if (botUsername) {
        const entities = ctx.message.entities || [];
        const isBotMentioned = entities.some((entity) => {
          if (entity.type === 'mention') {
            const mentionText = content
              .substring(entity.offset, entity.offset + entity.length)
              .toLowerCase();
            return mentionText === `@${botUsername}`;
          }
          return false;
        });
        if (isBotMentioned && !TRIGGER_PATTERN.test(content)) {
          content = `@${ASSISTANT_NAME} ${content}`;
        }
      }

      // Store chat metadata for discovery
      const isGroup =
        ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        chatName,
        'telegram',
        isGroup,
      );

      // Only deliver full message for registered groups
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) {
        logger.debug(
          { chatJid, chatName },
          'Message from unregistered Telegram chat',
        );
        return;
      }

      // Deliver message — startMessageLoop() will pick it up
      this.opts.onMessage(chatJid, {
        id: msgId,
        chat_jid: chatJid,
        sender,
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
      });

      logger.info(
        { chatJid, chatName, sender: senderName },
        'Telegram message stored',
      );
    });

    // Handle non-text messages with placeholders so the agent knows something was sent
    const storeNonText = (ctx: any, placeholder: string) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) return;

      // Use local timezone format for consistent string comparison
      const timestamp = new Date(ctx.message.date * 1000).toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' }).replace(' ', 'T') + '+08:00';
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id?.toString() ||
        'Unknown';
      const caption = ctx.message.caption ? ` ${ctx.message.caption}` : '';

      const isGroup =
        ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        undefined,
        'telegram',
        isGroup,
      );
      this.opts.onMessage(chatJid, {
        id: ctx.message.message_id.toString(),
        chat_jid: chatJid,
        sender: ctx.from?.id?.toString() || '',
        sender_name: senderName,
        content: `${placeholder}${caption}`,
        timestamp,
        is_from_me: false,
      });
    };

    this.bot.on('message:photo', (ctx) => storeNonText(ctx, '[Photo]'));
    this.bot.on('message:video', (ctx) => storeNonText(ctx, '[Video]'));
    this.bot.on('message:voice', (ctx) => storeNonText(ctx, '[Voice message]'));
    this.bot.on('message:audio', (ctx) => storeNonText(ctx, '[Audio]'));
    this.bot.on('message:document', (ctx) => {
      const name = ctx.message.document?.file_name || 'file';
      storeNonText(ctx, `[Document: ${name}]`);
    });
    this.bot.on('message:sticker', (ctx) => {
      const emoji = ctx.message.sticker?.emoji || '';
      storeNonText(ctx, `[Sticker ${emoji}]`);
    });
    this.bot.on('message:location', (ctx) => storeNonText(ctx, '[Location]'));
    this.bot.on('message:contact', (ctx) => storeNonText(ctx, '[Contact]'));

    // Handle errors gracefully
    this.bot.catch((err) => {
      logger.error({ err: err.message }, 'Telegram bot error');
    });

    // Start polling — returns a Promise that resolves when started
    return new Promise<void>((resolve) => {
      this.bot!.start({
        onStart: (botInfo) => {
          logger.info(
            { username: botInfo.username, id: botInfo.id },
            'Telegram bot connected',
          );
          console.log(`\n  Telegram bot: @${botInfo.username}`);
          console.log(
            `  Send /chatid to the bot to get a chat's registration ID\n`,
          );
          resolve();
        },
      });
    });
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.bot) {
      logger.warn('Telegram bot not initialized');
      return;
    }

    try {
      const numericId = jid.replace(/^tg:/, '');

      // Telegram has a 4096 character limit per message — split if needed
      const MAX_LENGTH = 4096;
      if (text.length <= MAX_LENGTH) {
        await sendTelegramMessage(this.bot.api, numericId, text);
      } else {
        for (let i = 0; i < text.length; i += MAX_LENGTH) {
          await sendTelegramMessage(
            this.bot.api,
            numericId,
            text.slice(i, i + MAX_LENGTH),
          );
        }
      }
      logger.info({ jid, length: text.length }, 'Telegram message sent');
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Telegram message');
    }
  }

  isConnected(): boolean {
    return this.bot !== null;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('tg:');
  }

  async disconnect(): Promise<void> {
    if (this.bot) {
      this.bot.stop();
      this.bot = null;
      logger.info('Telegram bot stopped');
    }
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (!this.bot || !isTyping) return;
    try {
      const numericId = jid.replace(/^tg:/, '');
      await this.bot.api.sendChatAction(numericId, 'typing');
    } catch (err) {
      logger.debug({ jid, err }, 'Failed to send Telegram typing indicator');
    }
  }
}

registerChannel('telegram', (opts: ChannelOpts) => {
  const envVars = readEnvFile(['TELEGRAM_BOT_TOKEN']);
  const token =
    process.env.TELEGRAM_BOT_TOKEN || envVars.TELEGRAM_BOT_TOKEN || '';
  if (!token) {
    logger.warn('Telegram: TELEGRAM_BOT_TOKEN not set');
    return null;
  }
  return new TelegramChannel(token, opts);
});
