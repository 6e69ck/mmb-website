import { afterEach, describe, expect, it, vi } from 'vitest';
import { Collection, Events, GatewayIntentBits, MessageFlags, Partials, PermissionFlagsBits, type Client, type Interaction, type Message, type MessageReaction, type TextChannel, type User } from 'discord.js';
import { createBot } from '../src/bot';
import type { BotConfig } from '../src/config';
import type { MediaStore } from '../src/contracts';

const config: BotConfig = {
  token: 'test-token-never-used', channelId: '100000000000000001', endpoint: 'https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com',
  accessKeyId: 'test-key', secretAccessKey: 'test-secret', bucket: 'mmb-media', publishToGallery: true, confirmationTtlMs: 60000,
};
const bots: ReturnType<typeof createBot>[] = [];
afterEach(async () => { vi.useRealTimers(); await Promise.all(bots.splice(0).map(bot => bot.shutdown())); vi.restoreAllMocks(); });
function setup(existing = false) {
  const store = {
    hasMessage: vi.fn<MediaStore['hasMessage']>().mockResolvedValue(existing),
    uploadMessage: vi.fn<MediaStore['uploadMessage']>().mockResolvedValue({ uploaded: 1 }),
    deleteMessage: vi.fn<MediaStore['deleteMessage']>().mockResolvedValue(undefined),
  };
  const bot = createBot(config, store); bots.push(bot);
  return { ...bot, store };
}
function source(id = 'source-message') {
  const admins = new Set<string>();
  const successRemove = vi.fn().mockResolvedValue(undefined);
  const confirmation = { id: `confirmation-${id}`, edit: vi.fn().mockResolvedValue(undefined) };
  const message = {
    id, guildId: 'guild-id', channelId: config.channelId, partial: false, content: '@everyone Parade photos', createdAt: new Date('2026-11-18T12:00:00Z'),
    author: { id: 'author-id', bot: false }, inGuild: () => true,
    guild: { members: { fetch: vi.fn(async ({ user }: { user: string }) => ({ permissions: { has: () => admins.has(user) } })) } },
    attachments: new Map([['image-1', { id: 'image-1', name: 'parade.jpg', url: 'https://cdn.discordapp.com/attachments/1/2/parade.jpg', contentType: 'image/jpeg', size: 100 }]]),
    react: vi.fn().mockResolvedValue(undefined), reply: vi.fn().mockResolvedValue(confirmation),
    reactions: { cache: new Collection([['check', { emoji: { name: '✅' }, users: { remove: successRemove } }]]) },
    delete: vi.fn(),
  };
  return { message, confirmation, admins, successRemove };
}
type Source = ReturnType<typeof source>;
const emitMessage = (bot: ReturnType<typeof createBot>, item: Source) => bot.client.emit(Events.MessageCreate, item.message as unknown as Message<true>);
const emitTrash = (bot: ReturnType<typeof createBot>, item: Source, userId = 'author-id', emoji = '🗑️') => bot.client.emit(Events.MessageReactionAdd, { message: item.message, partial: false, emoji: { name: emoji } } as unknown as MessageReaction, { id: userId, bot: false, partial: false } as User, { burst: false, type: 0 });
function interaction(item: Source, customId: string, userId = 'author-id') {
  const button = {
    customId, guildId: item.message.guildId, channelId: config.channelId, message: item.confirmation, user: { id: userId }, deferred: false, replied: false,
    isButton: () => true, reply: vi.fn().mockResolvedValue(undefined), followUp: vi.fn().mockResolvedValue(undefined), editReply: vi.fn().mockResolvedValue(undefined),
    deferUpdate: vi.fn(async () => { button.deferred = true; }),
  };
  return button;
}
const emitButton = (bot: ReturnType<typeof createBot>, button: ReturnType<typeof interaction>) => bot.client.emit(Events.InteractionCreate, button as unknown as Interaction);
async function openConfirmation(bot: ReturnType<typeof createBot>, item: Source, user = 'author-id') {
  emitTrash(bot, item, user);
  await vi.waitFor(() => expect(item.message.reply).toHaveBeenCalledOnce());
  return item.message.reply.mock.calls[0][0].components[0].toJSON().components[0].custom_id as string;
}

describe('Discord image ingestion and deletion controls', () => {
  it('creates a disconnected client with required intents, partials, and no mentions', async () => {
    const bot = setup();
    for (const intent of [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.GuildMessageReactions]) expect(bot.client.options.intents.has(intent)).toBe(true);
    expect(bot.client.options.partials).toEqual(expect.arrayContaining([Partials.Message, Partials.Reaction, Partials.User]));
    expect(bot.client.options.allowedMentions?.parse).toEqual([]);
    expect(bot.client.isReady()).toBe(false);
  });

  it('uploads image attachments once, then adds both reactions in order', async () => {
    const bot = setup(), item = source();
    item.message.attachments.set('movie', { id: 'movie', name: 'movie.mp4', url: 'https://cdn.discordapp.com/movie.mp4', contentType: 'video/mp4', size: 200 });
    emitMessage(bot, item); emitMessage(bot, item);
    await vi.waitFor(() => expect(item.message.react).toHaveBeenCalledTimes(2));
    expect(bot.store.uploadMessage).toHaveBeenCalledOnce();
    expect(bot.store.uploadMessage).toHaveBeenCalledWith(expect.objectContaining({ guildId: 'guild-id', channelId: config.channelId, messageId: item.message.id, authorId: 'author-id', caption: '@everyone Parade photos', attachments: [expect.objectContaining({ filename: 'parade.jpg', contentType: 'image/jpeg' })] }));
    expect(item.message.react.mock.calls.map(call => call[0])).toEqual(['✅', '🗑️']);
    expect(item.message.reply).not.toHaveBeenCalled();
  });

  it.each([1, 2])('reports successful storage if status reaction %i fails, without asking for a repost', async failAt => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const bot = setup(), item = source();
    if (failAt === 2) item.message.react.mockResolvedValueOnce(undefined);
    item.message.react.mockRejectedValueOnce(new Error('Missing reaction permissions'));
    emitMessage(bot, item);
    await vi.waitFor(() => expect(item.message.reply).toHaveBeenCalledOnce());
    expect(bot.store.uploadMessage).toHaveBeenCalledOnce();
    expect(item.message.reply.mock.calls[0][0].content).toBe('Photos were uploaded to the gallery, but status reactions could not be added. Check bot permissions.');
    expect(item.message.reply.mock.calls[0][0].content).not.toMatch(/posting|repost/i);
    expect(item.message.reply.mock.calls[0][0].allowedMentions).toEqual({ parse: [], repliedUser: false });
  });

  it('ignores bots, direct messages, other channels, and posts without supported images', async () => {
    const bot = setup();
    const robot = source('bot'); robot.message.author.bot = true;
    const dm = source('dm'); dm.message.inGuild = () => false;
    const elsewhere = source('elsewhere'); elsewhere.message.channelId = 'other-channel';
    const empty = source('empty'); empty.message.attachments.clear();
    const badMime = source('bad-mime'); badMime.message.attachments.get('image-1')!.contentType = 'application/javascript';
    for (const item of [robot, dm, elsewhere, empty, badMime]) emitMessage(bot, item);
    await bot.shutdown();
    expect(bot.store.hasMessage).not.toHaveBeenCalled(); expect(bot.store.uploadMessage).not.toHaveBeenCalled();
  });

  it('accepts supported MIME without an extension and generic MIME with an image filename', async () => {
    const bot = setup(), item = source();
    item.message.attachments.get('image-1')!.name = 'extensionless';
    item.message.attachments.set('generic', { id: 'generic', name: 'photo.webp', contentType: 'application/octet-stream', url: 'https://cdn.discordapp.com/photo.webp', size: 100 });
    emitMessage(bot, item);
    await vi.waitFor(() => expect(bot.store.uploadMessage).toHaveBeenCalledOnce());
    expect(bot.store.uploadMessage.mock.calls[0][0].attachments.map(file => file.filename)).toEqual(['extensionless', 'photo.webp']);
  });

  it('does not react or report an error when the store ignores a deleted-message replay', async () => {
    const bot = setup(true), item = source(); bot.store.uploadMessage.mockResolvedValue({ uploaded: 0 }); emitMessage(bot, item);
    await bot.shutdown();
    expect(bot.store.uploadMessage).toHaveBeenCalledOnce(); expect(item.message.react).not.toHaveBeenCalled(); expect(item.message.reply).not.toHaveBeenCalled();
  });

  it('lets the store reconcile persisted uploads and supports trash reactions after a restart', async () => {
    const bot = setup(true), item = source(); emitMessage(bot, item);
    await vi.waitFor(() => expect(item.message.react).toHaveBeenCalledTimes(2)); expect(bot.store.uploadMessage).toHaveBeenCalledOnce();
    const id = await openConfirmation(bot, item);
    expect(id).toMatch(/^mmb-delete:[a-f0-9]{48}:delete$/);
    expect(item.message.reply.mock.calls[0][0].allowedMentions).toEqual({ parse: [], repliedUser: false });
    expect(item.message.reply.mock.calls[0][0].components[0].toJSON().components.map((button: { label: string }) => button.label)).toEqual(['Delete photos', 'Keep photos']);
  });

  it('fetches uncached reaction, original message, and user after a restart', async () => {
    const bot = setup(true), item = source();
    const message = { ...item.message, partial: true, fetch: vi.fn().mockResolvedValue(item.message) };
    const reaction = { partial: true, message, emoji: { name: '🗑' }, fetch: vi.fn().mockResolvedValue({ message }) };
    const user = { id: 'author-id', bot: false, partial: true, fetch: vi.fn().mockResolvedValue({ id: 'author-id', bot: false }) };
    bot.client.emit(Events.MessageReactionAdd, reaction as unknown as MessageReaction, user as unknown as User, { burst: false, type: 0 });
    await vi.waitFor(() => expect(item.message.reply).toHaveBeenCalledOnce());
    expect(reaction.fetch).toHaveBeenCalledOnce(); expect(message.fetch).toHaveBeenCalledOnce(); expect(user.fetch).toHaveBeenCalledOnce();
    expect(bot.store.uploadMessage).not.toHaveBeenCalled();
  });

  it('checks configured-channel permissions when ready without logging credentials', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const bot = setup();
    const channel = {
      guild: { members: { fetchMe: vi.fn().mockResolvedValue({ id: 'bot-user' }) } },
      isTextBased: () => true, isSendable: () => true, isThread: () => false,
      permissionsFor: () => ({ has: (permission: bigint) => permission !== PermissionFlagsBits.AddReactions }),
    };
    const fetch = vi.spyOn(bot.client.channels, 'fetch').mockResolvedValue(channel as unknown as TextChannel);
    bot.client.emit(Events.ClientReady, bot.client as Client<true>);
    await vi.waitFor(() => expect(log).toHaveBeenCalledWith('[discord-bot] Missing upload-channel permissions: AddReactions.'));
    expect(fetch).toHaveBeenCalledWith(config.channelId); expect(JSON.stringify(log.mock.calls)).not.toContain(config.token);
  });

  it('requires fresh administrator permission both when opening and confirming', async () => {
    const bot = setup(true), item = source(); item.admins.add('admin-id');
    const id = await openConfirmation(bot, item, 'admin-id');
    expect(item.message.guild.members.fetch).toHaveBeenLastCalledWith({ user: 'admin-id', force: true });
    item.admins.delete('admin-id'); const button = interaction(item, id, 'admin-id'); emitButton(bot, button);
    await vi.waitFor(() => expect(button.followUp).toHaveBeenCalledOnce());
    expect(button.followUp).toHaveBeenCalledWith(expect.objectContaining({ flags: MessageFlags.Ephemeral, allowedMentions: { parse: [], repliedUser: false } }));
    expect(bot.store.deleteMessage).not.toHaveBeenCalled(); expect(button.deferUpdate).toHaveBeenCalledOnce();
  });

  it('acknowledges a valid button before waiting for a slow administrator lookup', async () => {
    const bot = setup(true), item = source(); const id = await openConfirmation(bot, item);
    const button = interaction(item, id, 'admin-id');
    let grant!: (member: { permissions: { has(): boolean } }) => void;
    const lookup = new Promise<{ permissions: { has(): boolean } }>(resolve => { grant = resolve; });
    item.message.guild.members.fetch.mockImplementationOnce(async () => {
      expect(button.deferUpdate).toHaveBeenCalledOnce(); return lookup;
    });
    emitButton(bot, button);
    await vi.waitFor(() => expect(item.message.guild.members.fetch).toHaveBeenCalledOnce());
    expect(button.deferred).toBe(true); expect(bot.store.deleteMessage).not.toHaveBeenCalled();
    grant({ permissions: { has: () => true } });
    await vi.waitFor(() => expect(bot.store.deleteMessage).toHaveBeenCalledOnce());
  });

  it('rechecks expiration after a delayed administrator lookup completes', async () => {
    vi.useFakeTimers(); const bot = setup(true), item = source(); emitTrash(bot, item);
    await vi.advanceTimersByTimeAsync(0);
    const id = item.message.reply.mock.calls[0][0].components[0].toJSON().components[0].custom_id;
    const button = interaction(item, id, 'admin-id');
    let grant!: (member: { permissions: { has(): boolean } }) => void;
    item.message.guild.members.fetch.mockImplementationOnce(() => new Promise(resolve => { grant = resolve; }));
    emitButton(bot, button); await vi.advanceTimersByTimeAsync(0);
    expect(button.deferUpdate).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(60000); grant({ permissions: { has: () => true } });
    await vi.advanceTimersByTimeAsync(0);
    expect(button.followUp).toHaveBeenCalledWith(expect.objectContaining({ content: 'This deletion request has expired.', flags: MessageFlags.Ephemeral }));
    expect(bot.store.deleteMessage).not.toHaveBeenCalled();
  });

  it('rejects forged IDs, wrong guilds/messages, and unauthorized users without deleting photos', async () => {
    const bot = setup(true), item = source(); const id = await openConfirmation(bot, item);
    const forged = interaction(item, `mmb-delete:${'a'.repeat(48)}:delete`);
    const wrongGuild = interaction(item, id); wrongGuild.guildId = 'other-guild';
    const wrongMessage = interaction(item, id); wrongMessage.message = { ...item.confirmation, id: 'copied-confirmation' };
    const unauthorized = interaction(item, id, 'unrelated-user');
    for (const button of [forged, wrongGuild, wrongMessage, unauthorized]) emitButton(bot, button);
    await vi.waitFor(() => {
      for (const button of [forged, wrongGuild, wrongMessage]) expect(button.reply).toHaveBeenCalledOnce();
      expect(unauthorized.followUp).toHaveBeenCalledWith(expect.objectContaining({ flags: MessageFlags.Ephemeral }));
    });
    const wrongChannel = interaction(item, id); wrongChannel.channelId = 'other-channel'; emitButton(bot, wrongChannel);
    await bot.shutdown(); expect(wrongChannel.reply).not.toHaveBeenCalled(); expect(bot.store.deleteMessage).not.toHaveBeenCalled();
  });

  it('acknowledges before deleting, locks double clicks, and keeps the original Discord message', async () => {
    const bot = setup(true), item = source(); const id = await openConfirmation(bot, item);
    const first = interaction(item, id), second = interaction(item, id);
    bot.store.deleteMessage.mockImplementation(async () => { expect(first.deferUpdate).toHaveBeenCalledOnce(); });
    emitButton(bot, first); emitButton(bot, second);
    await vi.waitFor(() => expect(item.successRemove).toHaveBeenCalledOnce());
    expect(bot.store.deleteMessage).toHaveBeenCalledOnce(); expect(item.message.delete).not.toHaveBeenCalled();
    expect(first.editReply).toHaveBeenCalledWith(expect.objectContaining({ components: [], allowedMentions: { parse: [], repliedUser: false } }));
    expect(second.followUp).toHaveBeenCalledWith(expect.objectContaining({ flags: MessageFlags.Ephemeral }));
  });

  it('allows the author to keep photos and ignores duplicate trash requests', async () => {
    const bot = setup(true), item = source(); emitTrash(bot, item, 'author-id', '🗑'); emitTrash(bot, item);
    await vi.waitFor(() => expect(item.message.reply).toHaveBeenCalledOnce());
    const id = item.message.reply.mock.calls[0][0].components[0].toJSON().components[1].custom_id;
    const button = interaction(item, id); emitButton(bot, button);
    await vi.waitFor(() => expect(button.editReply).toHaveBeenCalledWith(expect.objectContaining({ content: 'Photos kept.', components: [] })));
    expect(bot.store.deleteMessage).not.toHaveBeenCalled();
  });

  it('expires confirmation buttons after 60 seconds and rejects late clicks', async () => {
    vi.useFakeTimers(); const bot = setup(true), item = source(); emitTrash(bot, item);
    await vi.advanceTimersByTimeAsync(0); expect(item.message.reply).toHaveBeenCalledOnce();
    const id = item.message.reply.mock.calls[0][0].components[0].toJSON().components[0].custom_id;
    await vi.advanceTimersByTimeAsync(60000);
    const edit = item.confirmation.edit.mock.calls[0][0];
    expect(edit.components[0].toJSON().components.every((button: { disabled: boolean }) => button.disabled)).toBe(true);
    const late = interaction(item, id); emitButton(bot, late); await vi.advanceTimersByTimeAsync(0);
    expect(late.reply).toHaveBeenCalledWith(expect.objectContaining({ flags: MessageFlags.Ephemeral })); expect(bot.store.deleteMessage).not.toHaveBeenCalled();
  });

  it('bounds uploads to two messages and drains accepted jobs during shutdown', async () => {
    const bot = setup(); const finish: (() => void)[] = [];
    bot.store.uploadMessage.mockImplementation(() => new Promise(resolve => finish.push(() => resolve({ uploaded: 1 }))));
    const messages = [source('first'), source('second'), source('third')]; for (const item of messages) emitMessage(bot, item);
    await vi.waitFor(() => expect(bot.store.uploadMessage).toHaveBeenCalledTimes(2));
    finish[0](); await vi.waitFor(() => expect(bot.store.uploadMessage).toHaveBeenCalledTimes(3));
    const destroy = vi.spyOn(bot.client, 'destroy'); const shutdown = bot.shutdown();
    expect(destroy).not.toHaveBeenCalled(); emitMessage(bot, source('ignored-after-shutdown'));
    finish[1](); finish[2](); await shutdown;
    expect(bot.store.uploadMessage).toHaveBeenCalledTimes(3); expect(destroy).toHaveBeenCalledOnce();
    for (const item of messages) expect(item.message.react).toHaveBeenCalledTimes(2);
  });

  it('reports upload failures without echoing tokens or exception contents', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const bot = setup(), item = source(); bot.store.uploadMessage.mockRejectedValue(new Error(config.token)); emitMessage(bot, item);
    await vi.waitFor(() => expect(item.message.reply).toHaveBeenCalledOnce());
    expect(item.message.react).not.toHaveBeenCalled(); expect(JSON.stringify(log.mock.calls)).not.toContain(config.token);
    expect(item.message.reply.mock.calls[0][0].allowedMentions).toEqual({ parse: [], repliedUser: false });
  });
});
