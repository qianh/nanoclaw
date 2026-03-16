import { WebSocket } from 'ws';
import fs from 'fs';
import path from 'path';

import { ASSISTANT_NAME, TRIGGER_PATTERN, GROUPS_DIR } from '../config.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import { registerChannel, ChannelOpts } from './registry.js';
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  OnRegisterGroup,
  RegisteredGroup,
} from '../types.js';

export interface QQGuildChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
  registerGroup?: OnRegisterGroup;
}

// QQ 频道 API 配置
const API_BASE = 'https://api.sgroup.qq.com';
const SANDBOX_API_BASE = 'https://sandbox.api.sgroup.qq.com';

interface QQGuildConfig {
  appId: string;
  appSecret: string;
  accessToken: string; // 获取到的 access_token
}

interface QQMessage {
  id: string;
  channel_id: string;
  guild_id: string;
  content: string;
  timestamp: string;
  author: {
    id: string;
    username: string;
    avatar?: string;
    bot?: boolean;
  };
  mentions?: Array<{ id: string; username: string }>;
  attachments?: QQAttachment[];
}

interface QQChannel {
  id: string;
  guild_id: string;
  name: string;
  type: number;
}

// 私聊消息结构
interface C2CMessage {
  id: string;
  author: {
    id: string;
    username?: string;
    avatar?: string;
    bot?: boolean;
  };
  content: string;
  timestamp: string;
  attachments?: Array<{
    id: string;
    filename: string;
    url: string;
    content_type?: string;
  }>;
}

// 频道消息的附件结构
interface QQAttachment {
  url: string;
}

interface QQGuild {
  id: string;
  name: string;
  icon?: string;
}

interface WSPayload {
  op: number;
  d?: unknown;
  s?: number;
  t?: string;
}

export class QQGuildChannel implements Channel {
  name = 'qq-guild';

  private ws: WebSocket | null = null;
  private opts: QQGuildChannelOpts;
  private appId: string;
  private appSecret: string;
  private accessToken: string;
  private sessionId: string | null = null;
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private lastSeq: number = 0;
  private guilds: Map<string, QQGuild> = new Map();
  private channels: Map<string, QQChannel> = new Map();
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 5;

  constructor(config: QQGuildConfig, opts: QQGuildChannelOpts) {
    this.appId = config.appId;
    this.appSecret = config.appSecret;
    this.accessToken = config.accessToken;
    this.opts = opts;
  }

  getAppId(): string {
    return this.appId;
  }

  private get apiBase(): string {
    // Use sandbox if env is set
    return process.env.QQ_GUILD_SANDBOX === '1' ? SANDBOX_API_BASE : API_BASE;
  }

  private get authHeader(): string {
    return `QQBot ${this.accessToken}`;
  }

  /**
   * 下载附件文件到本地
   * @param url 附件下载地址
   * @param groupFolder 组文件夹名称
   * @param filename 文件名
   * @returns 本地文件路径（容器内路径）
   */
  private async downloadAttachment(
    url: string,
    groupFolder: string,
    filename: string,
  ): Promise<string | null> {
    try {
      // 创建 uploads 目录
      const uploadsDir = path.join(GROUPS_DIR, groupFolder, 'uploads');
      fs.mkdirSync(uploadsDir, { recursive: true });

      // 生成唯一文件名（添加时间戳避免冲突）
      // 只替换文件系统不安全的字符，保留中文等 Unicode 字符
      const timestamp = Date.now();
      const safeName = filename.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_');
      const uniqueName = `${timestamp}-${safeName}`;
      const localPath = path.join(uploadsDir, uniqueName);

      // 下载文件 - QQ 的附件 URL 可能需要跟随重定向
      let downloadUrl = url;
      let response = await fetch(downloadUrl, {
        headers: { Authorization: this.authHeader },
        redirect: 'manual', // 手动处理重定向以添加 Authorization header
      });

      // 处理重定向（最多跟随 5 次）
      let redirectCount = 0;
      while (response.status >= 300 && response.status < 400 && redirectCount < 5) {
        const location = response.headers.get('location');
        if (!location) break;
        downloadUrl = location;
        redirectCount++;
        logger.debug(
          { redirectCount, newUrl: downloadUrl, groupFolder },
          'Following redirect for QQ attachment',
        );
        response = await fetch(downloadUrl, {
          headers: { Authorization: this.authHeader },
          redirect: 'manual',
        });
      }

      if (!response.ok) {
        logger.error(
          { url, finalUrl: downloadUrl, status: response.status, groupFolder },
          'Failed to download QQ attachment',
        );
        return null;
      }

      // 保存文件
      const buffer = Buffer.from(await response.arrayBuffer());
      fs.writeFileSync(localPath, buffer);

      logger.info(
        { localPath, size: buffer.length, groupFolder, finalUrl: downloadUrl },
        'QQ attachment downloaded',
      );

      // 返回容器内的路径（agent 可以通过 /workspace/group/uploads/ 访问）
      return `/workspace/group/uploads/${uniqueName}`;
    } catch (err) {
      logger.error(
        { err, url, groupFolder },
        'Failed to download QQ attachment',
      );
      return null;
    }
  }

  /**
   * 处理消息附件，下载并返回文件信息
   */
  private async processAttachments(
    attachments: Array<{ url: string; filename?: string; content_type?: string }> | undefined,
    groupFolder: string,
  ): Promise<string[]> {
    if (!attachments || attachments.length === 0) {
      return [];
    }

    const fileInfoList: string[] = [];

    for (const attachment of attachments) {
      const filename = attachment.filename || 'file';
      const containerPath = await this.downloadAttachment(
        attachment.url,
        groupFolder,
        filename,
      );

      if (containerPath) {
        const contentType = attachment.content_type || '';
        let fileType = 'File';
        if (contentType.startsWith('image/')) {
          fileType = 'Image';
        } else if (contentType.startsWith('video/')) {
          fileType = 'Video';
        } else if (contentType.startsWith('audio/')) {
          fileType = 'Audio';
        } else if (contentType.includes('pdf')) {
          fileType = 'PDF';
        } else if (
          contentType.includes('word') ||
          contentType.includes('document') ||
          filename.endsWith('.doc') ||
          filename.endsWith('.docx')
        ) {
          fileType = 'Document';
        } else if (
          contentType.includes('excel') ||
          contentType.includes('spreadsheet') ||
          filename.endsWith('.xls') ||
          filename.endsWith('.xlsx')
        ) {
          fileType = 'Spreadsheet';
        } else if (filename.endsWith('.txt') || filename.endsWith('.md')) {
          fileType = 'Text';
        }

        fileInfoList.push(`[${fileType}: ${filename} - path: ${containerPath}]`);
      }
    }

    return fileInfoList;
  }

  async connect(): Promise<void> {
    try {
      // 如果没有 accessToken，需要先获取
      if (!this.accessToken) {
        this.accessToken = await this.fetchAccessToken();
        logger.info('QQ Guild access token obtained');
      }

      // Get WebSocket gateway URL
      const gatewayUrl = await this.getGateway();
      logger.info({ gatewayUrl }, 'QQ Guild gateway URL obtained');

      // Connect to WebSocket
      await this.connectWebSocket(gatewayUrl);

      logger.info('QQ Guild bot connected');
      console.log(`\n  QQ 频道机器人已连接`);
      console.log(`  AppID: ${this.appId}\n`);
    } catch (err) {
      logger.error({ err }, 'Failed to connect QQ Guild bot');
      throw err;
    }
  }

  /**
   * 使用 appId 和 clientSecret 获取 access_token
   * QQ 频道 API 文档: https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/interface-framework/api-use.html
   */
  private async fetchAccessToken(): Promise<string> {
    try {
      const response = await fetch('https://bots.qq.com/app/getAppAccessToken', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          appId: this.appId,
          clientSecret: this.appSecret,
        }),
      });

      if (!response.ok) {
        throw new Error(`Failed to get access token: ${response.status}`);
      }

      const data = (await response.json()) as { access_token?: string; expires_in?: number };
      if (!data.access_token) {
        throw new Error('No access_token in response');
      }

      logger.info({ expiresIn: data.expires_in }, 'QQ Guild access token obtained');
      return data.access_token;
    } catch (err) {
      logger.error({ err }, 'Failed to fetch QQ Guild access token');
      throw err;
    }
  }

  private async getGateway(): Promise<string> {
    const response = await fetch(`${this.apiBase}/gateway`, {
      headers: {
        Authorization: this.authHeader,
      },
    });

    if (!response.ok) {
      throw new Error(`Failed to get gateway: ${response.status}`);
    }

    const data = (await response.json()) as { url: string };
    return data.url;
  }

  private connectWebSocket(gatewayUrl: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(gatewayUrl);

      this.ws.on('open', () => {
        logger.debug('QQ Guild WebSocket connected');
      });

      this.ws.on('message', (data: Buffer) => {
        try {
          const payload: WSPayload = JSON.parse(data.toString());
          this.handleWSPayload(payload);
        } catch (err) {
          logger.error({ err }, 'Failed to parse QQ Guild WebSocket message');
        }
      });

      this.ws.on('error', (err) => {
        logger.error({ err }, 'QQ Guild WebSocket error');
        reject(err);
      });

      this.ws.on('close', (code, reason) => {
        logger.warn({ code, reason: reason.toString() }, 'QQ Guild WebSocket closed');
        this.cleanup();

        // Attempt reconnect
        this.scheduleReconnect();
      });

      // Resolve when we receive HELLO
      const checkHello = (data: Buffer) => {
        try {
          const payload: WSPayload = JSON.parse(data.toString());
          if (payload.op === 10) { // HELLO
            this.ws?.off('message', checkHello);
            resolve();
          }
        } catch {
          // Ignore parse errors during initial check
        }
      };
      this.ws.on('message', checkHello);
    });
  }

  private handleWSPayload(payload: WSPayload): void {
    this.lastSeq = payload.s ?? this.lastSeq;

    switch (payload.op) {
      case 10: // HELLO
        this.handleHello(payload.d as { heartbeat_interval: number });
        break;
      case 11: // HEARTBEAT_ACK
        logger.debug('QQ Guild heartbeat ACK');
        break;
      case 0: // Dispatch
        this.handleDispatch(payload.t, payload.d);
        break;
      case 9: // Invalid Session
        logger.warn('QQ Guild invalid session, reconnecting');
        this.sessionId = null;
        this.ws?.close();
        break;
      case 7: // Reconnect
        logger.info('QQ Guild server requesting reconnect');
        this.ws?.close();
        break;
    }
  }

  private handleHello(data: { heartbeat_interval: number }): void {
    // Start heartbeat
    this.heartbeatInterval = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ op: 1, d: this.lastSeq }));
      }
    }, data.heartbeat_interval);

    // Send identify or resume
    if (this.sessionId) {
      this.sendResume();
    } else {
      this.sendIdentify();
    }

    this.reconnectAttempts = 0;
  }

  private sendIdentify(): void {
    // Intents 位掩码：
    // C2C_GROUP_AT_MESSAGES (1 << 25) = 33554432 - 私聊/群 @消息
    // 这是私聊机器人需要的 intent
    const intents = 1 << 25;

    const identify = {
      op: 2,
      d: {
        token: this.authHeader,
        intents,
        shard: [0, 1],
        properties: {
          $os: process.platform,
          $browser: 'nanoclaw',
          $device: 'nanoclaw',
        },
      },
    };
    this.ws?.send(JSON.stringify(identify));
    logger.debug({ intents }, 'QQ Guild identify sent');
  }

  private sendResume(): void {
    const resume = {
      op: 6,
      d: {
        token: this.authHeader,
        session_id: this.sessionId,
        seq: this.lastSeq,
      },
    };
    this.ws?.send(JSON.stringify(resume));
    logger.debug('QQ Guild resume sent');
  }

  private handleDispatch(eventType: string | undefined, data: unknown): void {
    if (!eventType || !data) return;

    switch (eventType) {
      case 'READY':
        const ready = data as { session_id?: string; guilds?: QQGuild[] };
        if (ready.session_id) {
          this.sessionId = ready.session_id;
        }
        if (ready.guilds && Array.isArray(ready.guilds)) {
          ready.guilds.forEach((g) => this.guilds.set(g.id, g));
        }
        logger.info({ guildCount: this.guilds.size }, 'QQ Guild ready');
        break;

      case 'GUILD_CREATE':
        const guild = data as QQGuild;
        this.guilds.set(guild.id, guild);
        logger.debug({ guildId: guild.id, name: guild.name }, 'QQ Guild joined');
        break;

      case 'CHANNEL_CREATE':
        const channel = data as QQChannel;
        this.channels.set(channel.id, channel);
        break;

      case 'C2C_MESSAGE_CREATE':
        // 私聊消息
        logger.debug(
          { msgData: JSON.stringify(data, null, 2) },
          'QQ C2C message received',
        );
        this.handleC2CMessage(data as C2CMessage);
        break;

      case 'AT_MESSAGE_CREATE':
        // Message that @mentions the bot
      case 'MESSAGE_CREATE':
        // Regular message (if subscribed)
        this.handleMessage(data as QQMessage);
        break;
    }
  }

  /**
   * 处理私聊消息 (C2C)
   */
  private async handleC2CMessage(msg: C2CMessage): Promise<void> {
    // 忽略机器人消息
    if (msg.author?.bot) return;

    logger.debug(
      {
        msgId: msg.id,
        authorId: msg.author.id,
        contentLength: msg.content?.length,
        attachmentCount: msg.attachments?.length || 0,
        attachments: msg.attachments,
      },
      'handleC2CMessage called',
    );

    // 私聊的 chatJid 包含机器人 ID，确保不同机器人的消息隔离
    // 格式: qq:c2c:{botAppId}:{senderId}
    const chatJid = `qq:c2c:${this.appId}:${msg.author.id}`;
    let content = msg.content;
    const timestamp = msg.timestamp;
    const senderName = msg.author.username || `QQ用户${msg.author.id}`;
    const sender = msg.author.id;
    const msgId = msg.id;

    // 获取或注册 groupFolder
    let groupFolder = `qq-c2c-${this.appId.slice(-8)}-${msg.author.id.slice(-8)}`;
    const registered = this.opts.registeredGroups();
    if (registered[chatJid]) {
      groupFolder = registered[chatJid].folder;
    }

    // 处理附件：下载文件并添加到消息中
    if (msg.attachments && msg.attachments.length > 0) {
      logger.info(
        { chatJid, attachmentCount: msg.attachments.length, attachments: msg.attachments },
        'QQ C2C message has attachments, processing...',
      );
      const attachmentInfos = await this.processAttachments(
        msg.attachments.map(att => ({
          url: att.url,
          filename: att.filename,
          content_type: att.content_type,
        })),
        groupFolder,
      );
      if (attachmentInfos.length > 0) {
        content = content
          ? `${content}\n${attachmentInfos.join('\n')}`
          : attachmentInfos.join('\n');
      }
    }

    // 私聊消息直接处理，不需要 @提及
    // 添加触发前缀
    if (!TRIGGER_PATTERN.test(content)) {
      content = `@${ASSISTANT_NAME} ${content}`;
    }

    // 存储聊天元数据
    this.opts.onChatMetadata(chatJid, timestamp, `QQ私聊 ${senderName}`, 'qq-c2c', false);

    // 自动注册 C2C 聊天（如果尚未注册）
    if (!registered[chatJid] && this.opts.registerGroup) {
      this.opts.registerGroup(chatJid, {
        name: `QQ私聊 ${senderName}`,
        folder: groupFolder,
        trigger: `@${ASSISTANT_NAME}`,
        added_at: new Date().toISOString(),
        requiresTrigger: false, // 私聊不需要触发前缀
      });
      logger.info({ chatJid, sender: senderName, botId: this.appId }, 'QQ C2C chat auto-registered');
    }

    // 直接处理消息
    this.opts.onMessage(chatJid, {
      id: msgId,
      chat_jid: chatJid,
      sender,
      sender_name: senderName,
      content,
      timestamp,
      is_from_me: false,
    });

    logger.info({ chatJid, sender: senderName, botId: this.appId }, 'QQ C2C message stored');
  }

  private async handleMessage(msg: QQMessage): Promise<void> {
    // Ignore bot messages
    if (msg.author.bot) return;

    const chatJid = `qq:${msg.channel_id}`;
    let content = msg.content;
    const timestamp = msg.timestamp;
    const senderName = msg.author.username;
    const sender = msg.author.id;
    const msgId = msg.id;

    // Get channel and guild info
    let channelInfo = this.channels.get(msg.channel_id);
    if (!channelInfo) {
      channelInfo = await this.fetchChannel(msg.channel_id);
      if (channelInfo) {
        this.channels.set(channelInfo.id, channelInfo);
      }
    }

    const guildInfo = this.guilds.get(msg.guild_id);
    const chatName = guildInfo && channelInfo
      ? `${guildInfo.name} #${channelInfo.name}`
      : `QQ频道 ${msg.channel_id}`;

    // Handle @mentions - QQ uses <@!userId> format
    const botMentionRegex = new RegExp(`<@!?${this.appId}>`, 'g');
    const isBotMentioned = botMentionRegex.test(content);

    // QQ 频道：只有 @机器人 的消息才处理（不需要预先注册）
    if (!isBotMentioned) {
      return;
    }

    // Strip the mention and add trigger
    content = content.replace(botMentionRegex, '').trim();

    // 获取或创建 groupFolder
    const registered = this.opts.registeredGroups();
    let groupFolder = registered[chatJid]?.folder || `qq-guild-${msg.channel_id.slice(-12)}`;

    // 处理附件：下载文件并添加到消息中
    if (msg.attachments && msg.attachments.length > 0) {
      const attachmentInfos = await this.processAttachments(
        msg.attachments.map(att => ({
          url: att.url,
        })),
        groupFolder,
      );
      if (attachmentInfos.length > 0) {
        content = content
          ? `${content}\n${attachmentInfos.join('\n')}`
          : attachmentInfos.join('\n');
      }
    }

    if (!TRIGGER_PATTERN.test(content)) {
      content = `@${ASSISTANT_NAME} ${content}`;
    }

    // Store chat metadata for discovery
    this.opts.onChatMetadata(chatJid, timestamp, chatName, 'qq-guild', true);

    // Deliver message (QQ 频道不需要预先注册，直接响应 @机器人 的消息)
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
      'QQ Guild message stored',
    );
  }

  private async fetchChannel(channelId: string): Promise<QQChannel | undefined> {
    try {
      const response = await fetch(`${this.apiBase}/channels/${channelId}`, {
        headers: { Authorization: this.authHeader },
      });
      if (!response.ok) return undefined;
      return (await response.json()) as QQChannel;
    } catch {
      return undefined;
    }
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    await this.sendMessageWithRetry(jid, text, false);
  }

  /**
   * 发送文件消息（需要公网可访问的文件 URL）
   * @param jid 目标 JID
   * @param fileUrl 文件的公网 URL（QQ 服务端去拉取）
   * @param filename 文件名（用于展示）
   * @param fileType 1=图片 2=视频 3=语音 4=文件（默认 4）
   */
  async sendFile(jid: string, fileUrl: string, filename: string, fileType = 4, localFilePath?: string): Promise<void> {
    await this.sendFileWithRetry(jid, fileUrl, filename, fileType, false, localFilePath);
  }

  private async sendFileWithRetry(
    jid: string,
    fileUrl: string,
    filename: string,
    fileType: number,
    isRetry: boolean,
    localFilePath?: string,
  ): Promise<void> {
    try {
      if (jid.startsWith('qq:c2c:')) {
        // 私聊：先上传获取 file_info，再发富媒体消息
        const parts = jid.replace(/^qq:c2c:/, '').split(':');
        const openid = parts.length > 1 ? parts[1] : parts[0];

        // If we have a local file, always use base64 upload for correct filename handling
        if (localFilePath) {
          return this.sendFileViaBase64(jid, localFilePath, filename, fileType);
        }

        // 第一步：上传文件
        const uploadRes = await fetch(`${this.apiBase}/v2/users/${openid}/files`, {
          method: 'POST',
          headers: {
            Authorization: this.authHeader,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            file_type: fileType,
            url: fileUrl,
            srv_send_msg: false,
          }),
        });

        if (!uploadRes.ok) {
          const error = await uploadRes.text();
          if (!isRetry && error.includes('token not exist or expire')) {
            this.accessToken = await this.fetchAccessToken();
            return this.sendFileWithRetry(jid, fileUrl, filename, fileType, true, localFilePath);
          }
          // If URL download failed and we have a local file, try file_data (base64) upload
          if (localFilePath && (error.includes('850011') || error.includes('download file error'))) {
            logger.info({ jid, localFilePath }, 'URL upload failed, trying file_data base64 upload');
            return this.sendFileViaBase64(jid, localFilePath, filename, fileType);
          }
          logger.error({ jid, status: uploadRes.status, error }, 'Failed to upload QQ C2C file');
          return;
        }

        const uploadData = (await uploadRes.json()) as { file_info?: string };
        if (!uploadData.file_info) {
          logger.error({ jid, uploadData }, 'QQ C2C file upload returned no file_info');
          return;
        }

        // 第二步：发送富媒体消息
        const sendRes = await fetch(`${this.apiBase}/v2/users/${openid}/messages`, {
          method: 'POST',
          headers: {
            Authorization: this.authHeader,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            content: filename,
            msg_type: 7, // 富媒体
            media: { file_info: uploadData.file_info },
          }),
        });

        if (!sendRes.ok) {
          const error = await sendRes.text();
          logger.error({ jid, status: sendRes.status, error }, 'Failed to send QQ C2C file message');
          return;
        }

        logger.info({ jid, filename, fileType, botId: this.appId }, 'QQ C2C file sent');
      } else {
        // 频道：先上传获取 file_info，再发富媒体消息
        const channelId = jid.replace(/^qq:/, '');

        // 第一步：上传文件
        const uploadRes = await fetch(`${this.apiBase}/v2/channels/${channelId}/files`, {
          method: 'POST',
          headers: {
            Authorization: this.authHeader,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            file_type: fileType,
            url: fileUrl,
            srv_send_msg: false,
          }),
        });

        if (!uploadRes.ok) {
          const error = await uploadRes.text();
          if (!isRetry && error.includes('token not exist or expire')) {
            this.accessToken = await this.fetchAccessToken();
            return this.sendFileWithRetry(jid, fileUrl, filename, fileType, true);
          }
          logger.error({ jid, status: uploadRes.status, error }, 'Failed to upload QQ Guild file');
          return;
        }

        const uploadData = (await uploadRes.json()) as { file_info?: string };
        if (!uploadData.file_info) {
          logger.error({ jid, uploadData }, 'QQ Guild file upload returned no file_info');
          return;
        }

        // 第二步：发送富媒体消息
        const sendRes = await fetch(`${this.apiBase}/channels/${channelId}/messages`, {
          method: 'POST',
          headers: {
            Authorization: this.authHeader,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            content: filename,
            msg_type: 7,
            media: { file_info: uploadData.file_info },
          }),
        });

        if (!sendRes.ok) {
          const error = await sendRes.text();
          logger.error({ jid, status: sendRes.status, error }, 'Failed to send QQ Guild file message');
          return;
        }

        logger.info({ jid, filename, fileType, botId: this.appId }, 'QQ Guild file sent');
      }
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send QQ file');
    }
  }

  private async sendFileViaBase64(jid: string, localFilePath: string, filename: string, fileType: number, isRetry = false): Promise<void> {
    try {
      const fileBuffer = fs.readFileSync(localFilePath);
      const fileData = fileBuffer.toString('base64');

      const parts = jid.replace(/^qq:c2c:/, '').split(':');
      const openid = parts.length > 1 ? parts[1] : parts[0];

      const uploadRes = await fetch(`${this.apiBase}/v2/users/${openid}/files`, {
        method: 'POST',
        headers: {
          Authorization: this.authHeader,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          file_type: fileType,
          file_data: fileData,
          file_name: filename,
          srv_send_msg: false,
        }),
      });

      if (!uploadRes.ok) {
        const error = await uploadRes.text();
        if (!isRetry && error.includes('token not exist or expire')) {
          this.accessToken = await this.fetchAccessToken();
          return this.sendFileViaBase64(jid, localFilePath, filename, fileType, true);
        }
        logger.error({ jid, status: uploadRes.status, error }, 'Failed to upload QQ C2C file via base64');
        return;
      }

      const uploadData = (await uploadRes.json()) as { file_info?: string };
      if (!uploadData.file_info) {
        logger.error({ jid, uploadData }, 'QQ C2C base64 file upload returned no file_info');
        return;
      }

      const sendRes = await fetch(`${this.apiBase}/v2/users/${openid}/messages`, {
        method: 'POST',
        headers: {
          Authorization: this.authHeader,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          content: filename,
          msg_type: 7,
          media: { file_info: uploadData.file_info },
        }),
      });

      if (!sendRes.ok) {
        const error = await sendRes.text();
        logger.error({ jid, status: sendRes.status, error }, 'Failed to send QQ C2C file message (base64)');
        return;
      }

      logger.info({ jid, filename, fileType }, 'QQ C2C file sent via base64');
    } catch (err) {
      logger.error({ jid, localFilePath, err }, 'Failed to send QQ file via base64');
    }
  }

  private async sendMessageWithRetry(jid: string, text: string, isRetry: boolean): Promise<void> {
    try {
      // 区分频道消息和私聊消息
      if (jid.startsWith('qq:c2c:')) {
        // 私聊消息 - 使用 C2C API
        // 新格式: qq:c2c:{botId}:{senderId} 或旧格式: qq:c2c:{senderId}
        const parts = jid.replace(/^qq:c2c:/, '').split(':');
        const openid = parts.length > 1 ? parts[1] : parts[0];

        const response = await fetch(`${this.apiBase}/v2/users/${openid}/messages`, {
          method: 'POST',
          headers: {
            Authorization: this.authHeader,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            content: text,
            msg_type: 0, // 文本消息
          }),
        });

        if (!response.ok) {
          const error = await response.text();
          // Check if token expired - refresh and retry once
          if (!isRetry && error.includes('token not exist or expire')) {
            logger.info('QQ token expired, refreshing...');
            this.accessToken = await this.fetchAccessToken();
            return this.sendMessageWithRetry(jid, text, true);
          }
          logger.error({ jid, status: response.status, error }, 'Failed to send QQ C2C message');
          return;
        }

        logger.info({ jid, length: text.length, botId: this.appId }, 'QQ C2C message sent');
      } else {
        // 频道消息
        const channelId = jid.replace(/^qq:/, '');
        const response = await fetch(`${this.apiBase}/channels/${channelId}/messages`, {
          method: 'POST',
          headers: {
            Authorization: this.authHeader,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ content: text }),
        });

        if (!response.ok) {
          const error = await response.text();
          // Check if token expired - refresh and retry once
          if (!isRetry && error.includes('token not exist or expire')) {
            logger.info('QQ token expired, refreshing...');
            this.accessToken = await this.fetchAccessToken();
            return this.sendMessageWithRetry(jid, text, true);
          }
          logger.error({ jid, status: response.status, error }, 'Failed to send QQ Guild message');
          return;
        }

        logger.info({ jid, length: text.length, botId: this.appId }, 'QQ Guild message sent');
      }
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send QQ message');
    }
  }

  /**
   * Check if this bot instance owns the given JID.
   * For C2C messages with bot ID, only match if the bot ID matches.
   */
  ownsJidWithBotId(jid: string): boolean {
    if (!jid.startsWith('qq:')) return false;

    // For C2C with bot ID: qq:c2c:{botId}:{senderId}
    if (jid.startsWith('qq:c2c:')) {
      const rest = jid.slice('qq:c2c:'.length);
      const parts = rest.split(':');
      // New format with bot ID
      if (parts.length > 1) {
        return parts[0] === this.appId;
      }
      // Old format without bot ID - accept for backward compatibility
      return true;
    }

    // Guild messages - accept all
    return true;
  }

  isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('qq:');
  }

  async disconnect(): Promise<void> {
    this.cleanup();
    logger.info('QQ Guild bot stopped');
  }

  private cleanup(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      logger.error(
        { attempts: this.reconnectAttempts },
        'QQ Guild max reconnect attempts reached, will retry in 5 minutes',
      );
      // 重置计数器，5分钟后再次尝试
      this.reconnectAttempts = 0;
      setTimeout(() => this.scheduleReconnect(), 5 * 60 * 1000);
      return;
    }

    this.reconnectAttempts++;
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000);
    logger.info({ attempt: this.reconnectAttempts, delay }, 'Scheduling QQ Guild reconnect');

    setTimeout(async () => {
      try {
        // Force refresh token on reconnect - old token may have expired
        this.accessToken = await this.fetchAccessToken();
        logger.info('QQ Guild access token refreshed for reconnect');

        await this.connect();
        // 连接成功，重置重连计数
        this.reconnectAttempts = 0;
      } catch (err) {
        logger.error({ err, attempt: this.reconnectAttempts }, 'QQ Guild reconnect failed');
        // 连接失败，继续重试
        this.scheduleReconnect();
      }
    }, delay);
  }

  async setTyping(_jid: string, _isTyping: boolean): Promise<void> {
    // QQ Guild doesn't support typing indicator
  }
}

/**
 * Multi-bot wrapper that manages multiple QQ Guild bots.
 * Routes messages to the correct bot instance based on context.
 */
class MultiQQGuildChannel implements Channel {
  name = 'qq-guild';
  private bots: QQGuildChannel[] = [];
  private botById: Map<string, QQGuildChannel> = new Map();

  constructor(bots: QQGuildChannel[]) {
    this.bots = bots;
    // Build lookup map by appId
    for (const bot of bots) {
      this.botById.set(bot.getAppId(), bot);
    }
  }

  async connect(): Promise<void> {
    // Connect all bots in parallel
    await Promise.all(this.bots.map(bot => bot.connect()));
  }

  /**
   * Extract bot ID from JID if present.
   * Format: qq:c2c:{botId}:{senderId}
   */
  private extractBotId(jid: string): string | null {
    if (!jid.startsWith('qq:c2c:')) return null;
    const rest = jid.slice('qq:c2c:'.length);
    const parts = rest.split(':');
    return parts.length > 1 ? parts[0] : null;
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    // For C2C with bot ID, route to specific bot
    const botId = this.extractBotId(jid);
    if (botId) {
      const bot = this.botById.get(botId);
      if (bot) {
        await bot.sendMessage(jid, text);
        return;
      }
      logger.warn({ jid, botId }, 'Bot ID not found for JID, trying all bots');
    }

    // Fallback: try each bot until one succeeds
    for (const bot of this.bots) {
      try {
        await bot.sendMessage(jid, text);
        return;
      } catch (err) {
        logger.debug({ jid, err }, 'Failed to send with bot, trying next');
      }
    }
    logger.error({ jid }, 'All QQ bots failed to send message');
  }

  async sendFile(jid: string, fileUrl: string, filename: string, fileType?: number, localFilePath?: string): Promise<void> {
    const botId = this.extractBotId(jid);
    if (botId) {
      const bot = this.botById.get(botId);
      if (bot) {
        await bot.sendFile(jid, fileUrl, filename, fileType, localFilePath);
        return;
      }
      logger.warn({ jid, botId }, 'Bot ID not found for JID, trying all bots');
    }

    for (const bot of this.bots) {
      try {
        await bot.sendFile(jid, fileUrl, filename, fileType, localFilePath);
        return;
      } catch (err) {
        logger.debug({ jid, err }, 'Failed to send file with bot, trying next');
      }
    }
    logger.error({ jid }, 'All QQ bots failed to send file');
  }

  isConnected(): boolean {
    return this.bots.some(bot => bot.isConnected());
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('qq:');
  }

  async disconnect(): Promise<void> {
    await Promise.all(this.bots.map(bot => bot.disconnect()));
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    // QQ Guild doesn't support typing indicator
  }
}

/**
 * Parse QQ_GUILD_BOTS JSON config or fall back to single-bot env vars.
 * Supports both formats:
 * - QQ_GUILD_BOTS=[{"appId":"xxx","appSecret":"xxx"},...]
 * - QQ_GUILD_APP_ID + QQ_GUILD_APP_SECRET (single bot, legacy)
 */
function parseQQGuildConfigs(): QQGuildConfig[] {
  const envVars = readEnvFile(['QQ_GUILD_BOTS', 'QQ_GUILD_APP_ID', 'QQ_GUILD_APP_SECRET', 'QQ_GUILD_TOKEN']);

  // Try JSON array format first
  const botsJson = process.env.QQ_GUILD_BOTS || envVars.QQ_GUILD_BOTS;
  if (botsJson) {
    try {
      const bots = JSON.parse(botsJson);
      if (Array.isArray(bots) && bots.length > 0) {
        return bots.map(bot => ({
          appId: bot.appId || bot.appID || '',
          appSecret: bot.appSecret || bot.secret || '',
          accessToken: bot.token || '',
        }));
      }
    } catch (err) {
      logger.warn({ err }, 'Failed to parse QQ_GUILD_BOTS JSON');
    }
  }

  // Fall back to single-bot env vars
  const appId = process.env.QQ_GUILD_APP_ID || envVars.QQ_GUILD_APP_ID || '';
  const appSecret = process.env.QQ_GUILD_APP_SECRET || envVars.QQ_GUILD_APP_SECRET || '';
  const token = process.env.QQ_GUILD_TOKEN || envVars.QQ_GUILD_TOKEN || '';

  if (appId && appSecret) {
    return [{ appId, appSecret, accessToken: token }];
  }

  return [];
}

registerChannel('qq-guild', (opts: ChannelOpts) => {
  const configs = parseQQGuildConfigs();

  if (configs.length === 0) {
    logger.warn('QQ Guild: No bots configured. Set QQ_GUILD_BOTS or QQ_GUILD_APP_ID + QQ_GUILD_APP_SECRET');
    return null;
  }

  logger.info({ botCount: configs.length }, 'QQ Guild: Creating bot instances');

  // Create bot instances
  const bots = configs.map((config, index) => {
    logger.info({ botIndex: index, appId: config.appId }, 'QQ Guild bot configured');
    return new QQGuildChannel(config, opts);
  });

  // Return multi-bot wrapper
  return new MultiQQGuildChannel(bots);
});
