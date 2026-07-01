# Hathor Discord Bot

Hathor is a Discord music bot built with Node.js and discord.js.

It supports slash commands, joins the caller's active voice channel, and plays audio from YouTube links or search input.

## Features

- Slash command-based bot commands.
- Voice channel playback with `/play`.
- YouTube URL support, including short links.
- Search text support in `/play input`.
- Crash-resilience improvements:
   - guarded cleanup for voice resources
   - safer interaction reply handling
   - connection error/disconnect handling
   - global rejection and exception logging

## Commands

- `/ping` - Replies with Pong.
- `/hathor` - Confirms the bot is listening.
- `/play input:<youtube-link-or-search>` - Joins your current voice channel and plays audio.
- `/leave` - Disconnects Hathor from voice.

## Required Bot Permissions

- View Channels
- Send Messages
- Read Message History
- Connect
- Speak

## Prerequisites

- Node.js 20+
- A Discord application and bot token

## Setup

1. Install dependencies:

```powershell
npm install
```

2. Create a `.env` file in the project root:

```env
DISCORD_TOKEN=your_bot_token_here
```

3. Start the bot:

```powershell
npm start
```

4. For development with auto-reload:

```powershell
npm run dev
```

## Invite The Bot To Your Server

1. Open the Discord Developer Portal and select your app.
2. Go to OAuth2 -> URL Generator.
3. Enable scopes:
    - `bot`
    - `applications.commands`
4. Select the permissions listed above.
5. Open the generated URL and add Hathor to your server.

Direct invite link:
https://discord.com/oauth2/authorize?client_id=1521839909202165760&permissions=3214336&integration_type=0&scope=bot+applications.commands

If you see "invalid scopes provided for user installation", use Guild Install instead of User Install in the Developer Portal Installation settings.

## Usage

1. Join a voice channel.
2. Run one of the following:

```text
/play input:https://youtu.be/uxUATkpMQ8A?si=i8Ygv3rTAyM80zYF
/play input:daft punk harder better faster stronger
```

3. Use `/leave` to disconnect the bot.

## Troubleshooting

- Bot works only for you:
   - confirm Guild Install was used
   - check server/channel command permissions for other users
- `/play` fails:
   - verify the channel grants Connect and Speak to the bot
   - verify the video is public and playable
- Bot appears offline for others:
   - keep the process running
   - avoid sleep/hibernation on the host machine
   - use an always-on host for production

## Deployment Recommendation

For reliable uptime outside your local machine, deploy Hathor to an always-on host (for example Railway, Render, Fly.io, or a VPS) and set `DISCORD_TOKEN` as an environment variable.
