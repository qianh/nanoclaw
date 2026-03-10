import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { QQGuildChannel } from './qq-guild.js';
import type { RegisteredGroup } from '../types.js';

// Mock WebSocket
vi.mock('ws', () => {
  const mockWs = {
    on: vi.fn(),
    off: vi.fn(),
    send: vi.fn(),
    close: vi.fn(),
    readyState: 1, // OPEN
  };
  return {
    WebSocket: vi.fn(() => mockWs),
  };
});

// Mock fetch
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// Mock logger
vi.mock('../logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// Mock config
vi.mock('../config.js', () => ({
  ASSISTANT_NAME: 'Andy',
  TRIGGER_PATTERN: /^@Andy\b/i,
}));

// Mock env
vi.mock('../env.js', () => ({
  readEnvFile: () => ({
    QQ_GUILD_APP_ID: '123456',
    QQ_GUILD_APP_SECRET: 'test-secret',
  }),
}));

describe('QQGuildChannel', () => {
  let channel: QQGuildChannel;
  const mockOpts = {
    onMessage: vi.fn(),
    onChatMetadata: vi.fn(),
    registeredGroups: () =>
      ({
        'qq:123456789': {
          name: 'Test Channel',
          folder: 'test',
          trigger: '@Andy',
          added_at: new Date().toISOString(),
        },
      }) as Record<string, RegisteredGroup>,
  };

  const config = {
    appId: '123456',
    appSecret: 'test-secret',
    accessToken: 'abcdef',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    channel = new QQGuildChannel(config, mockOpts);
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ url: 'wss://test.gateway.qq.com' }),
    });
  });

  afterEach(() => {
    channel.disconnect();
  });

  describe('name', () => {
    it('should return qq-guild', () => {
      expect(channel.name).toBe('qq-guild');
    });
  });

  describe('ownsJid', () => {
    it('should return true for qq: prefixed jids', () => {
      expect(channel.ownsJid('qq:123456789')).toBe(true);
    });

    it('should return false for non-qq jids', () => {
      expect(channel.ownsJid('dc:123456789')).toBe(false);
      expect(channel.ownsJid('tg:-1001234567890')).toBe(false);
    });
  });

  describe('isConnected', () => {
    it('should return false before connect', () => {
      expect(channel.isConnected()).toBe(false);
    });
  });

  describe('sendMessage', () => {
    it('should call the QQ Guild API to send a message', async () => {
      mockFetch.mockResolvedValueOnce({ ok: true });

      await channel.sendMessage('qq:123456789', 'Hello, QQ!');

      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.sgroup.qq.com/channels/123456789/messages',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            Authorization: 'QQBot abcdef',
            'Content-Type': 'application/json',
          }),
          body: JSON.stringify({ content: 'Hello, QQ!' }),
        })
      );
    });

    it('should log error when send fails', async () => {
      const { logger } = await import('../logger.js');
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 403,
        text: () => Promise.resolve('Forbidden'),
      });

      await channel.sendMessage('qq:123456789', 'Hello!');

      expect(logger.error).toHaveBeenCalled();
    });
  });

  describe('constructor', () => {
    it('should store config and opts', () => {
      expect(channel.name).toBe('qq-guild');
    });
  });
});
