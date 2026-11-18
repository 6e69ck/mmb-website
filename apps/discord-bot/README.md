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

## Deploy to the PM2 server

The deploy command targets `dev@192.18.151.14`, checks out the full `origin` repository into `/home/dev/MMB`, and builds and starts **only the bot**. The server pulls Git over SSH using its own deploy key; your local machine needs SSH access to the server.

One-time server setup:

1. Install Git, Node.js 22.12+, PM2, and pnpm 10.26.2 or Corepack for the `dev` user. The script loads NVM when present.
2. Verify the server's Git SSH access and the server host fingerprint through your normal SSH setup.
3. Create `/home/dev/MMB/.env` with the five Discord/R2 variables listed above. It may be provisioned before the initial checkout. The deploy script preserves it and sets its permissions to `600`.
4. Stop the local copy of this bot before activating the server copy; run only one bot instance.

From this repository:

```sh
git push origin main
pnpm deploy:bot --dry-run
pnpm deploy:bot
```

Options: `--repo git@github.com:6e69ck/mmb-website.git`, `--branch main`, `--host dev@192.18.151.14`, and `--dir /home/dev/MMB`. The repository defaults to your local `origin`. No `.env` or credentials are copied from your machine.

Deployments take a server-side lock, refuse a dirty or mismatched checkout, and pull with fast-forward-only semantics. A failed install, type check, build, or configuration check leaves the current PM2 process running. PM2 uses one forked process named `mmb-discord-bot`; restarting stops the old copy before starting its replacement. The process has two minutes to finish active work, and the script saves the PM2 process list afterward.

For automatic restoration after a reboot, run `pm2 startup systemd -u dev --hp /home/dev` on the server once, execute the privileged command PM2 prints, then run `pm2 save`. This system-service setup is separate from routine deployments.

```sh
ssh dev@192.18.151.14 'pm2 logs mmb-discord-bot --lines 50'
ssh dev@192.18.151.14 'pm2 status mmb-discord-bot'
```

The script validates configuration and requests the PM2 restart; it does not claim a successful Discord login. Check the logs for `Ready. Monitoring the configured image-upload channel.` after deployment.

`pnpm test:deploy-bot` tests bootstrap, updates, secret preservation, and failure handling against a temporary local Git repository with fake pnpm/PM2 commands; it never connects to the server.
