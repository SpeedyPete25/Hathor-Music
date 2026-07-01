require("dotenv").config();

const fs = require("node:fs");
const path = require("node:path");
const {
  Client,
  Events,
  GatewayIntentBits,
  SlashCommandBuilder,
} = require("discord.js");
const {
  AudioPlayerStatus,
  NoSubscriberBehavior,
  VoiceConnectionStatus,
  createAudioPlayer,
  createAudioResource,
  entersState,
  joinVoiceChannel,
} = require("@discordjs/voice");
const play = require("play-dl");

const tokenPath = path.join(__dirname, "..", "token.txt");
const fileToken = fs.existsSync(tokenPath)
  ? fs.readFileSync(tokenPath, "utf8").trim()
  : "";
const token = process.env.DISCORD_TOKEN || fileToken;

if (!token) {
  console.error("Missing DISCORD_TOKEN. Add it to .env or token.txt.");
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildVoiceStates,
  ],
});

const guildAudioState = new Map();

function cleanupGuildAudio(guildId) {
  const state = guildAudioState.get(guildId);
  if (!state) return;

  state.player.stop(true);
  state.connection.destroy();
  guildAudioState.delete(guildId);
}

async function resolvePlayableInput(input) {
  const trimmed = input.trim();
  const youtubeValidation = play.yt_validate(trimmed);

  if (youtubeValidation === "video") {
    return {
      url: trimmed,
      title: trimmed,
    };
  }

  // Accept search text and resolve it to a public YouTube result.
  const results = await play.search(trimmed, {
    limit: 1,
    source: { youtube: "video" },
  });

  if (!results.length || !results[0].url) {
    throw new Error("No playable YouTube result found.");
  }

  return {
    url: results[0].url,
    title: results[0].title || results[0].url,
  };
}

client.once(Events.ClientReady, (readyClient) => {
  console.log(`Hathor is online as ${readyClient.user.tag}`);
  readyClient.user.setActivity("the stars", { type: 3 });

  const commands = [
    new SlashCommandBuilder()
      .setName("ping")
      .setDescription("Check if Hathor is awake."),
    new SlashCommandBuilder()
      .setName("hathor")
      .setDescription("Hear from Hathor."),
    new SlashCommandBuilder()
      .setName("play")
      .setDescription("Play audio in your current voice channel.")
      .addStringOption((option) =>
        option
          .setName("input")
          .setDescription("YouTube URL or search text")
          .setRequired(true)
      ),
    new SlashCommandBuilder()
      .setName("leave")
      .setDescription("Disconnect Hathor from voice."),
  ].map((command) => command.toJSON());

  readyClient.application.commands
    .set(commands)
    .then(() => console.log("Slash commands registered."))
    .catch((error) => console.error("Failed to register commands:", error));
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === "ping") {
    await interaction.reply("Pong from Hathor.");
  }

  if (interaction.commandName === "hathor") {
    await interaction.reply("Hathor is listening.");
  }

  if (interaction.commandName === "leave") {
    if (!interaction.guildId) {
      await interaction.reply({
        content: "This command can only be used in a server.",
        ephemeral: true,
      });
      return;
    }

    cleanupGuildAudio(interaction.guildId);
    await interaction.reply("Left the voice channel.");
  }

  if (interaction.commandName === "play") {
    if (!interaction.guildId || !interaction.guild) {
      await interaction.reply({
        content: "This command can only be used in a server.",
        ephemeral: true,
      });
      return;
    }

    const member = await interaction.guild.members.fetch(interaction.user.id);
    const memberChannel = member.voice.channel;

    if (!memberChannel) {
      await interaction.reply({
        content: "Join a voice channel first, then use /play.",
        ephemeral: true,
      });
      return;
    }

    const input = interaction.options.getString("input", true);
    const botMember = await interaction.guild.members.fetchMe();
    const permissions = memberChannel.permissionsFor(botMember);

    if (!permissions?.has(["Connect", "Speak"])) {
      await interaction.reply({
        content: "I need Connect and Speak permissions in that voice channel.",
        ephemeral: true,
      });
      return;
    }

    try {
      await interaction.deferReply();

      const existing = guildAudioState.get(interaction.guildId);
      if (existing && existing.connection.joinConfig.channelId !== memberChannel.id) {
        cleanupGuildAudio(interaction.guildId);
      }

      const resolved = await resolvePlayableInput(input);
      const stream = await play.stream(resolved.url, {
        discordPlayerCompatibility: true,
      });

      let state = guildAudioState.get(interaction.guildId);
      if (!state) {
        const connection = joinVoiceChannel({
          channelId: memberChannel.id,
          guildId: interaction.guildId,
          adapterCreator: interaction.guild.voiceAdapterCreator,
          selfDeaf: true,
        });

        await entersState(connection, VoiceConnectionStatus.Ready, 15_000);

        const player = createAudioPlayer({
          behaviors: {
            noSubscriber: NoSubscriberBehavior.Pause,
          },
        });

        connection.subscribe(player);

        player.on("error", (error) => {
          console.error("Audio player error:", error);
          cleanupGuildAudio(interaction.guildId);
        });

        player.on(AudioPlayerStatus.Idle, () => {
          cleanupGuildAudio(interaction.guildId);
        });

        state = { connection, player };
        guildAudioState.set(interaction.guildId, state);
      }

      const resource = createAudioResource(stream.stream, {
        inputType: stream.type,
        silencePaddingFrames: 5,
      });

      state.player.play(resource);
      await interaction.editReply(`Now playing: ${resolved.title}`);
    } catch (error) {
      console.error("Failed to play audio:", error);
      cleanupGuildAudio(interaction.guildId);

      const safeReason =
        error && typeof error.message === "string" && error.message.length < 140
          ? error.message
          : "Playback failed due to an unsupported source or permissions issue.";

      if (interaction.deferred) {
        await interaction.editReply(
          `I couldn't play that input. ${safeReason}`
        );
      } else {
        await interaction.reply({
          content: `I couldn't play that input. ${safeReason}`,
          ephemeral: true,
        });
      }
    }
  }
});

client.login(token);
