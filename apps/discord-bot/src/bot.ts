import { randomBytes } from 'node:crypto';
import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, Client, Events, GatewayIntentBits,
  MessageFlags, Partials, PermissionFlagsBits,
  type ButtonInteraction, type Interaction, type Message, type MessageReaction, type PartialMessageReaction, type PartialUser, type User,
} from 'discord.js';
import type { BotConfig } from './config';
import type { AttachmentInput, MediaStore, MessageTarget } from './contracts';

const keyFor = (target: MessageTarget) => `${target.guildId}/${target.channelId}/${target.messageId}`;
const targetFor = (message: Message<true>): MessageTarget => ({ guildId: message.guildId, channelId: message.channelId, messageId: message.id });
const safeLog = (operation: string) => console.error(`[discord-bot] ${operation} failed. Check the bot permissions and service connection.`);
type Confirmation = {
  nonce: string; target: MessageTarget; source: Message<true>; message: Message;
  expiresAt: number; timer: ReturnType<typeof setTimeout>; locked: boolean;
};

function buttons(nonce: string, disabled = false) {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`mmb-delete:${nonce}:delete`).setLabel('Delete photos').setStyle(ButtonStyle.Danger).setDisabled(disabled),
    new ButtonBuilder().setCustomId(`mmb-delete:${nonce}:keep`).setLabel('Keep photos').setStyle(ButtonStyle.Secondary).setDisabled(disabled),
  );
}

function imageAttachments(message: Message): AttachmentInput[] {
  const supported = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
  return [...message.attachments.values()].filter(file => {
    const mime = file.contentType?.split(';')[0].trim().toLowerCase();
    return Boolean(mime && supported.has(mime)) || ((!mime || mime === 'application/octet-stream') && /\.(?:jpe?g|png|webp|gif)$/i.test(file.name));
  })
    .map(file => ({ id: file.id, url: file.url, filename: file.name, contentType: file.contentType, size: file.size }));
}

export function createBot(config: BotConfig, store: MediaStore): { client: Client; shutdown(): Promise<void> } {
  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.GuildMessageReactions],
    partials: [Partials.Message, Partials.Channel, Partials.Reaction, Partials.User],
    allowedMentions: { parse: [], repliedUser: false },
  });
  let stopping = false, runningUploads = 0, shutdownPromise: Promise<void> | undefined;
  const pending = new Set<Promise<void>>();
  const uploading = new Set<string>(), opening = new Set<string>();
  const confirmations = new Map<string, Confirmation>();
  const messageConfirmations = new Map<string, string>();
  const queue: { run: () => Promise<void>; resolve(): void; reject(error: unknown): void }[] = [];

  function track(operation: Promise<void>, label: string) {
    const guarded = operation.catch(() => safeLog(label)).finally(() => pending.delete(guarded));
    pending.add(guarded);
  }
  function pump() {
    while (runningUploads < 2 && queue.length) {
      const job = queue.shift()!; runningUploads++;
      void job.run().then(job.resolve, job.reject).finally(() => { runningUploads--; pump(); });
    }
  }
  function schedule(run: () => Promise<void>) {
    const operation = new Promise<void>((resolve, reject) => queue.push({ run, resolve, reject }));
    pump(); return operation;
  }
  function forget(confirmation: Confirmation) {
    clearTimeout(confirmation.timer);
    confirmations.delete(confirmation.nonce);
    messageConfirmations.delete(keyFor(confirmation.target));
  }
  async function authorized(source: Message<true>, userId: string) {
    if (source.author.id === userId) return true;
    try {
      const member = await source.guild.members.fetch({ user: userId, force: true });
      return member.permissions.has(PermissionFlagsBits.Administrator);
    } catch { return false; }
  }

  async function onMessage(message: Message) {
    if (stopping || !message.inGuild() || message.channelId !== config.channelId || message.author.bot) return;
    const attachments = imageAttachments(message);
    if (!attachments.length) return;
    const target = targetFor(message), key = keyFor(target);
    if (uploading.has(key)) return;
    uploading.add(key);
    let uploaded = false;
    try {
      await schedule(async () => {
        // The store reconciles pending manifests and deduplicates ready uploads.
        // hasMessage also includes partial states and cannot establish completion.
        const result = await store.uploadMessage({ ...target, authorId: message.author.id, createdAt: message.createdAt, caption: message.content, attachments });
        if (!result.uploaded) return;
        uploaded = true;
        await message.react('✅');
        await message.react('🗑️');
      });
    } catch {
      safeLog(uploaded ? 'Status reactions' : 'Image upload');
      const content = uploaded
        ? 'Photos were uploaded to the gallery, but status reactions could not be added. Check bot permissions.'
        : 'These photos could not be uploaded. Please try posting them again.';
      await message.reply({ content, allowedMentions: { parse: [], repliedUser: false }, failIfNotExists: false }).catch(() => safeLog('Upload notice'));
    } finally { uploading.delete(key); }
  }

  async function onReaction(reaction: MessageReaction | PartialMessageReaction, reactingUser: User | PartialUser) {
    if (stopping || reaction.message.channelId !== config.channelId || reactingUser.bot || reaction.emoji.name?.replace(/\uFE0F/g, '') !== '🗑') return;
    const resolved = reaction.partial ? await reaction.fetch() : reaction;
    const source = resolved.message.partial ? await resolved.message.fetch() : resolved.message;
    if (!source.inGuild() || source.channelId !== config.channelId || source.author.bot) return;
    const user = reactingUser.partial ? await reactingUser.fetch() : reactingUser;
    if (user.bot) return;
    const target = targetFor(source), key = keyFor(target);
    if (opening.has(key) || messageConfirmations.has(key)) return;
    opening.add(key);
    try {
      if (!await store.hasMessage(target) || !await authorized(source, user.id) || stopping) return;
      const nonce = randomBytes(24).toString('hex');
      const confirmationMessage = await source.reply({
        content: 'Delete the photos uploaded from this message? The original Discord message will stay.',
        components: [buttons(nonce)], allowedMentions: { parse: [], repliedUser: false }, failIfNotExists: false,
      });
      const ttl = Math.min(60000, Math.max(1, config.confirmationTtlMs));
      const confirmation: Confirmation = { nonce, target, source, message: confirmationMessage, expiresAt: Date.now() + ttl, locked: false, timer: undefined! };
      confirmation.timer = setTimeout(() => {
        if (confirmation.locked) return;
        forget(confirmation);
        track(confirmation.message.edit({ content: 'This deletion request expired. React with 🗑️ to try again.', components: [buttons(nonce, true)], allowedMentions: { parse: [], repliedUser: false } }).then(() => {}), 'Confirmation expiry');
      }, ttl);
      confirmation.timer.unref();
      confirmations.set(nonce, confirmation);
      messageConfirmations.set(key, nonce);
    } finally { opening.delete(key); }
  }

  async function deny(interaction: ButtonInteraction, content: string) {
    const response = { content, flags: MessageFlags.Ephemeral as const, allowedMentions: { parse: [] as never[], repliedUser: false } };
    if (interaction.deferred || interaction.replied) await interaction.followUp(response);
    else await interaction.reply(response);
  }
  async function onButton(interaction: ButtonInteraction) {
    if (interaction.channelId !== config.channelId) return;
    if (!interaction.customId.startsWith('mmb-delete:')) return;
    const match = /^mmb-delete:([a-f0-9]{48}):(delete|keep)$/.exec(interaction.customId);
    const confirmation = match ? confirmations.get(match[1]) : undefined;
    if (stopping || !confirmation || interaction.guildId !== confirmation.target.guildId || interaction.channelId !== confirmation.target.channelId || interaction.message.id !== confirmation.message.id) {
      await deny(interaction, 'This deletion request is invalid or has expired.'); return;
    }
    // Discord requires an acknowledgement within three seconds. A fresh guild
    // member lookup may take longer, so defer before checking administrator access.
    try { await interaction.deferUpdate(); }
    catch { safeLog('Confirmation acknowledgement'); return; }
    if (!await authorized(confirmation.source, interaction.user.id)) {
      await deny(interaction, 'Only the original author or a server administrator can do this.'); return;
    }
    if (Date.now() >= confirmation.expiresAt) { await deny(interaction, 'This deletion request has expired.'); return; }
    if (confirmation.locked || confirmations.get(confirmation.nonce) !== confirmation) { await deny(interaction, 'This request is already being handled.'); return; }
    confirmation.locked = true;
    try {
      clearTimeout(confirmation.timer);
      if (match![2] === 'keep') {
        await interaction.editReply({ content: 'Photos kept.', components: [], allowedMentions: { parse: [], repliedUser: false } });
        forget(confirmation); return;
      }
      await store.deleteMessage(confirmation.target);
      await interaction.editReply({ content: 'Photos deleted from media storage and the gallery. The original Discord message was kept.', components: [], allowedMentions: { parse: [], repliedUser: false } });
      forget(confirmation);
      const success = confirmation.source.reactions.cache.find(value => value.emoji.name === '✅');
      await success?.users.remove().catch(() => safeLog('Success reaction removal'));
    } catch {
      safeLog('Photo deletion');
      forget(confirmation);
      if (interaction.deferred) await interaction.editReply({ content: 'The request could not be completed. React with 🗑️ to try again.', components: [], allowedMentions: { parse: [], repliedUser: false } }).catch(() => safeLog('Deletion notice'));
    }
  }

  const messageListener = (message: Message) => track(onMessage(message), 'Message handling');
  const reactionListener = (reaction: MessageReaction | PartialMessageReaction, user: User | PartialUser) => track(onReaction(reaction, user), 'Reaction handling');
  const interactionListener = (interaction: Interaction) => {
    if (interaction.isButton()) track(onButton(interaction), 'Button handling');
  };
  const readyListener = () => track((async () => {
    const channel = await client.channels.fetch(config.channelId);
    if (!channel || !('guild' in channel) || !channel.isTextBased() || !channel.isSendable()) {
      console.error('[discord-bot] The configured upload channel must be a server text channel or sendable thread.'); return;
    }
    const member = await channel.guild.members.fetchMe();
    const permissions = channel.permissionsFor(member);
    const requirements = [
      ['ViewChannel', PermissionFlagsBits.ViewChannel], ['ReadMessageHistory', PermissionFlagsBits.ReadMessageHistory],
      [channel.isThread() ? 'SendMessagesInThreads' : 'SendMessages', channel.isThread() ? PermissionFlagsBits.SendMessagesInThreads : PermissionFlagsBits.SendMessages],
      ['AddReactions', PermissionFlagsBits.AddReactions],
    ] as const;
    const missing = requirements.filter(([, permission]) => !permissions?.has(permission)).map(([name]) => name);
    if (missing.length) console.error(`[discord-bot] Missing upload-channel permissions: ${missing.join(', ')}.`);
    else console.info('[discord-bot] Ready. Monitoring the configured image-upload channel.');
  })(), 'Upload-channel check');
  client.on(Events.MessageCreate, messageListener);
  client.on(Events.MessageReactionAdd, reactionListener);
  client.on(Events.InteractionCreate, interactionListener);
  client.on(Events.ClientReady, readyListener);
  client.on(Events.Error, () => safeLog('Discord connection'));

  return { client, shutdown() {
    shutdownPromise ||= (async () => {
      stopping = true;
      client.off(Events.MessageCreate, messageListener);
      client.off(Events.MessageReactionAdd, reactionListener);
      client.off(Events.InteractionCreate, interactionListener);
      client.off(Events.ClientReady, readyListener);
      for (const confirmation of confirmations.values()) clearTimeout(confirmation.timer);
      while (pending.size) await Promise.allSettled([...pending]);
      for (const confirmation of confirmations.values()) {
        forget(confirmation);
        await confirmation.message.edit({ content: 'The bot stopped. React with 🗑️ after it restarts to request deletion.', components: [buttons(confirmation.nonce, true)], allowedMentions: { parse: [], repliedUser: false } }).catch(() => safeLog('Shutdown notice'));
      }
      await client.destroy();
    })();
    return shutdownPromise;
  } };
}
