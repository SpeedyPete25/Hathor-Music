# Hathor Discord Bot

A simple Discord bot named Hathor built with discord.js.

## Commands

- /ping replies with Pong.
- /hathor confirms the bot is listening.

## Setup

1. Install dependencies:
   npm install
2. Put your bot token in `token.txt` (already present in this workspace).
3. Build `.env` from `token.txt`:
   powershell -Command "$token = (Get-Content token.txt -Raw).Trim(); Set-Content .env \"DISCORD_TOKEN=$token\""
4. Start the bot:
   npm start

## Development

- Run with auto-reload:
  npm run dev
