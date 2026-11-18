# Discord gallery uploads

This Node bot watches one Discord channel. Supported image attachments are downloaded from Discord's CDN, stored in the private `mmb-media` R2 bucket, and published to the website gallery with a thumbnail and BlurHash. The gallery year comes from the message date; the message text becomes the caption. The website picks up new media without a rebuild.

After a successful upload the bot adds ✅ and 🗑️ reactions. The original author or a server member with the **Administrator** permission can react with 🗑️ to request deletion. The bot replies with confirmation buttons. Confirmation rechecks authorization and expires after one minute. Deleting removes the uploaded photos from the gallery and R2; it keeps the original Discord message. R2 records allow the bot to manage earlier uploads after a restart.

Images can be JPEG, PNG, WebP, or GIF, up to 25 MB each. Text-only messages, other channels, bot messages, and video attachments are ignored. Downloads accept only Discord's HTTPS CDN hosts. Gallery edits use conditional R2 writes so dashboard changes are preserved.

## Configuration

Add these names to the ignored **repository-root `.env`** (never put tokens in a browser environment):

```dotenv
DISCORD_BOT_TOKEN=
DISCORD_UPLOAD_CHANNEL=
ACCESS_KEY_ID=
ACCESS_KEY_SECRET=
R2_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com
```

`DISCORD_UPLOAD_CHANNEL_ID` is also accepted. The existing R2 keys need read/write access to `mmb-media` objects. The gallery catalog and bot upload indexes remain private.

In the Discord Developer Portal, enable **Message Content Intent** for the bot. Invite it to the server and grant the monitored channel's **View Channel**, **Read Message History**, **Send Messages**, and **Add Reactions** permissions. A monitored thread also needs **Send Messages in Threads**. Administrators do not need to share the bot token.

## Run and verify

From the repository root:

```sh
pnpm bot:check-config  # Validates configuration without opening Discord/R2 connections
pnpm dev:bot          # Runs this bot locally with automatic restart
pnpm dev              # Runs all apps through Turbo, including the bot when configured
pnpm check
pnpm test
pnpm build
```

After building, `pnpm --filter @mmb/discord-bot start` runs the compiled process. Run one bot process at a time. It needs a continuously running Node host; publishing the static website to Pages does not keep a Discord Gateway connection running. Missing Discord configuration leaves the shared development command in standby instead of stopping the website/dashboard.

Tests use fake Discord events and R2 clients. They do not send messages, publish real photos, or delete production data. Starting the configured bot connects to the real channel and uploads new images to the live gallery. It does not backfill historical messages automatically.
