# Hathor Discord Bot

Hathor is a Discord music bot built with Node.js and discord.js.

It supports slash commands, joins the caller's active voice channel, and plays audio from YouTube links or search input.

## Features

- Slash command-based bot commands.
- Voice channel playback with `/play`.
- YouTube URL support, including short links.
- Search text support in `/play input`.
- Rich now-playing embeds with progress bar, requester, duration, source, and thumbnail.
- Live now-playing progress updates (same message edited every ~12 seconds while active).
- Optional per-guild autoplay mode to keep music going with related tracks.
- Health and metrics snapshot for command latency, playback failures, reconnects, and queue duration.
- Queue persistence across bot restarts (resumes when `/play` is used again).
- Stays in voice channel for 1 minute after music stops, then disconnects.
- Abuse protection on track requests:
   - per-user add-track cooldown
   - max total queue size per server
   - max track duration cap
- Crash-resilience improvements:
   - guarded cleanup for voice resources
   - safer interaction reply handling
   - connection error/disconnect handling
   - global rejection and exception logging

## Commands

- `/ping` - Replies with Pong.
- `/hathor` - Confirms the bot is listening.
- `/play input:<youtube-link-or-search>` - Joins your current voice channel and plays audio (for playlist links, plays the first track). Also accepts pasted markdown links and auto-cleans noisy YouTube mix/radio query params.
- `/queue` - Shows the current playing track and queued tracks.
- `/skip` - Skips the current track and moves to the next queued track.
- `/clear` - Clears all upcoming tracks from the queue.
- `/remove index:<number>` - Removes one upcoming track by queue position.
- `/playnext input:<youtube-link-or-search>` - Adds a track to the front of the queue.
- `/move from:<number> to:<number>` - Moves a queued track to a new queue position.
- `/swap first:<number> second:<number>` - Swaps two queued tracks.
- `/shuffle` - Randomizes upcoming queue order.
- `/loop mode:<off|track|queue>` - Sets loop mode.
- `/repeat mode:<off|track|queue>` - Alias for `/loop`.
- `/autoplay [mode:<on|off>]` - Shows autoplay status or updates it (Manage Server required to change).
- `/health` - Shows runtime health metrics and recent performance stats.
- `/leave` - Disconnects Hathor from voice.

## Required Bot Permissions

- View Channels
- Send Messages
- Read Message History
- Connect
- Speak

## Prerequisites

- Docker and Docker Compose
- A Discord application and bot token
- `data/cookies.txt` — a Netscape-format cookies file exported from a YouTube-logged-in browser session (see [YouTube Playback](#youtube-playback) below). Not committed to git.

## Setup

1. Copy `.env.example` to `.env` and set your token:

```env
DISCORD_TOKEN=your_bot_token_here
```

2. Export `data/cookies.txt` (see [YouTube Playback](#youtube-playback)).

3. Build and start everything (the bot plus its PO-token provider):

```powershell
docker compose up -d --build
```

4. Follow logs:

```powershell
docker compose logs -f bot
```

### Running without Docker (local dev)

Node.js 20+ alone is not enough — YouTube playback additionally requires a
system Python 3 install with `yt-dlp` and `bgutil-ytdlp-pot-provider` pip
packages, the Deno runtime on PATH, and the `bgutil-ytdlp-pot-provider`
container reachable at `http://127.0.0.1:4416` (run it standalone with
`docker run -d -p 4416:4416 --restart unless-stopped brainicism/bgutil-ytdlp-pot-provider:latest`).
See [YouTube Playback](#youtube-playback) for why. Then:

```powershell
npm install
npm start
```

For development with auto-reload:

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

Queue controls:

```text
/queue
/skip
/clear
/remove index:2
/playnext input:lofi hip hop radio
/move from:5 to:1
/swap first:1 second:3
/shuffle
/loop mode:queue
/autoplay mode:on
/health
```

Destructive command policy (`/skip`, `/clear`, `/remove`, `/playnext`, `/move`, `/swap`, `/shuffle`, `/loop`, `/repeat`):

- Allowed for the requester of the current track
- Allowed for users in Hathor's current voice channel
- Allowed for users with Manage Server permission

Track request limits:

- Default cooldown: 8 seconds between track-add requests per user
- Default queue cap: 25 total tracks per server (current + queued)
- Default duration cap: 15 minutes per track
- Optional env overrides: `PLAY_COOLDOWN_MS`, `MAX_QUEUE_LENGTH`, `MAX_TRACK_DURATION_SECONDS`

## YouTube Playback

YouTube now blocks anonymous, unauthenticated stream requests, so playback
depends on three pieces working together:

- **A YouTube session** — `data/cookies.txt`, a Netscape-format cookies file.
  Export it once from a browser logged into YouTube (e.g. with the "Get
  cookies.txt" browser extension, or `yt-dlp --cookies-from-browser firefox
  --cookies data/cookies.txt --skip-download <any-youtube-url>` if you have
  yt-dlp installed locally). It isn't committed to git — copy it into `data/`
  on whatever host runs the bot. It will eventually expire (typically weeks to
  months) and need re-exporting if `/play` starts failing again.
- **A solved JS challenge** — handled by the Deno runtime baked into the
  Docker image.
- **A PO (proof-of-origin) token** — generated by the `bgutil-provider`
  service in `docker-compose.yml`. Its plugin version (pinned in the
  `Dockerfile`) must match the provider image's version or token generation
  silently fails; if you bump one, bump the other to match.

## Troubleshooting

- Bot works only for you:
   - confirm Guild Install was used
   - check server/channel command permissions for other users
- `/play` fails:
   - verify the channel grants Connect and Speak to the bot
   - verify the video is public and playable
   - check `docker compose logs bot` and `docker compose logs bgutil-provider` — a 403 usually means `data/cookies.txt` expired (re-export it) or the PO-token plugin/provider versions drifted apart (see [YouTube Playback](#youtube-playback))
- Bot appears offline for others:
   - keep the process running
   - avoid sleep/hibernation on the host machine
   - use an always-on host for production

## Deployment Recommendation

For reliable uptime outside your local machine, deploy Hathor to an always-on host (for example a VPS with Docker installed) and run `docker compose up -d --build`. Make sure `data/cookies.txt` and `.env` exist on that host, and that Docker's own restart policy (already `unless-stopped` in `docker-compose.yml`) is enough — or that Docker itself is set to start on boot.
