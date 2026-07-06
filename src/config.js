require("dotenv").config();

const RESOLVE_TIMEOUT_MS = 20_000;
const CONNECT_TIMEOUT_MS = 15_000;
const START_TIMEOUT_MS = 30_000;

const token = process.env.DISCORD_TOKEN;

if (!token) {
  console.error("Missing DISCORD_TOKEN. Set it in your environment or .env file.");
  process.exit(1);
}

module.exports = {
  CONNECT_TIMEOUT_MS,
  RESOLVE_TIMEOUT_MS,
  START_TIMEOUT_MS,
  token,
};
