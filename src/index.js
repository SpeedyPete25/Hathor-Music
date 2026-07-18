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

const nowPlayingMessageIds = new Map();

const musicManager = new MusicManager({
  connectTimeoutMs: CONNECT_TIMEOUT_MS,
  resolveTimeoutMs: RESOLVE_TIMEOUT_MS,
  startTimeoutMs: START_TIMEOUT_MS,
  announcer: async ({ guildId, message, embed, nowPlaying }) => {
    const state = musicManager.getState(guildId);
    const channelId = state?.textChannelId;
    if (!channelId) return;

    const channel = await client.channels.fetch(channelId);
    if (!channel || typeof channel.send !== "function") return;

    if (nowPlaying && embed) {
      const existingMessageId = nowPlayingMessageIds.get(guildId);

      if (existingMessageId) {
        try {
          const existing = await channel.messages.fetch(existingMessageId);
          await existing.edit({
            content: message || null,
            embeds: [embed],
          });
          return;
        } catch (error) {
          console.warn("Failed to edit now-playing message, sending a new one:", error);
        }
      }

      const sent = await channel.send({
        content: message || undefined,
        embeds: [embed],
      });
      nowPlayingMessageIds.set(guildId, sent.id);
      return;
    }

    if (embed && message) {
      await channel.send({ content: message, embeds: [embed] });
      return;
    }

    if (embed) {
      await channel.send({ embeds: [embed] });
      return;
    }

    if (message) {
      await channel.send(message);
    }
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
