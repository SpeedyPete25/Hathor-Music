const { Client, Events, GatewayIntentBits } = require("discord.js");
const {
  CONNECT_TIMEOUT_MS,
  RESOLVE_TIMEOUT_MS,
  START_TIMEOUT_MS,
  token,
} = require("./config");
const { buildCommands, handleInteraction } = require("./commands");
const { MusicManager } = require("./music-manager");

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildVoiceStates,
  ],
});

const musicManager = new MusicManager({
  connectTimeoutMs: CONNECT_TIMEOUT_MS,
  resolveTimeoutMs: RESOLVE_TIMEOUT_MS,
  startTimeoutMs: START_TIMEOUT_MS,
  announcer: async ({ guildId, message }) => {
    const state = musicManager.getState(guildId);
    const channelId = state?.textChannelId;
    if (!channelId) return;

    const channel = await client.channels.fetch(channelId);
    if (!channel || typeof channel.send !== "function") return;

    await channel.send(message);
  },
});

client.once(Events.ClientReady, (readyClient) => {
  console.log(`Hathor is online as ${readyClient.user.tag}`);
  readyClient.user.setActivity("Hymns of the Nile", { type: 0 });

  readyClient.application.commands
    .set(buildCommands())
    .then(() => console.log("Slash commands registered."))
    .catch((error) => console.error("Failed to register commands:", error));
});

client.on(Events.InteractionCreate, async (interaction) => {
  await handleInteraction(interaction, musicManager);
});

client.on("error", (error) => {
  console.error("Discord client error:", error);
});

client.on("warn", (warning) => {
  console.warn("Discord client warning:", warning);
});

process.on("unhandledRejection", (reason) => {
  console.error("Unhandled promise rejection:", reason);
});

process.on("uncaughtException", (error) => {
  console.error("Uncaught exception:", error);
});

function shutdown(signal) {
  console.log(`Received ${signal}. Shutting down Hathor.`);

  for (const guildId of musicManager.guildAudioState.keys()) {
    musicManager.cleanupGuildAudio(guildId);
  }

  client.destroy();
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

client.login(token);
