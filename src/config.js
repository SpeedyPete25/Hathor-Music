require("dotenv").config();

const RESOLVE_TIMEOUT_MS = 20_000;
const CONNECT_TIMEOUT_MS = 15_000;
const START_TIMEOUT_MS = 30_000;
const PLAY_COOLDOWN_MS = Number(process.env.PLAY_COOLDOWN_MS || 8_000);
const MAX_QUEUE_LENGTH = Number(process.env.MAX_QUEUE_LENGTH || 25);
const MAX_TRACK_DURATION_SECONDS = Number(process.env.MAX_TRACK_DURATION_SECONDS || 900);

const token = process.env.DISCORD_TOKEN;

if (!token) {
  console.error("Missing DISCORD_TOKEN. Set it in your environment or .env file.");
  process.exit(1);
}

// Optional: Spotify link support degrades gracefully when unset rather than
// blocking startup, since it's not required for the bot to run.
const SPOTIFY_CLIENT_ID = process.env.SPOTIFY_CLIENT_ID;
const SPOTIFY_CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET;

module.exports = {
  CONNECT_TIMEOUT_MS,
  MAX_QUEUE_LENGTH,
  MAX_TRACK_DURATION_SECONDS,
  PLAY_COOLDOWN_MS,
  RESOLVE_TIMEOUT_MS,
  SPOTIFY_CLIENT_ID,
  SPOTIFY_CLIENT_SECRET,
  START_TIMEOUT_MS,
  token,
};
