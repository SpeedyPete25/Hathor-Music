require("dotenv").config();

const { Readable } = require("node:stream");
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
  demuxProbe,
  entersState,
  joinVoiceChannel,
} = require("@discordjs/voice");
const ytdlExec = require("youtube-dl-exec");

const token = process.env.DISCORD_TOKEN;

if (!token) {
  console.error("Missing DISCORD_TOKEN. Set it in your environment or .env file.");
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
  if (!state || state.cleaning) return;

  state.cleaning = true;

  try {
    state.player.stop(true);
  } catch (error) {
    console.error("Failed to stop audio player during cleanup:", error);
  }

  try {
    state.connection.destroy();
  } catch (error) {
    console.error("Failed to destroy voice connection during cleanup:", error);
  }

  guildAudioState.delete(guildId);
}

function createGuildAudioState(guildId, guild, channelId) {
  const connection = joinVoiceChannel({
    channelId,
    guildId,
    adapterCreator: guild.voiceAdapterCreator,
    selfDeaf: true,
  });

  const player = createAudioPlayer({
    behaviors: {
      noSubscriber: NoSubscriberBehavior.Pause,
    },
  });

  connection.subscribe(player);

  const state = {
    connection,
    player,
    cleaning: false,
    queue: [],
    current: null,
  };

  connection.on("error", (error) => {
    console.error("Voice connection error:", error);
    cleanupGuildAudio(guildId);
  });

  connection.on(VoiceConnectionStatus.Disconnected, async () => {
    try {
      await Promise.race([
        entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
        entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
      ]);
    } catch {
      cleanupGuildAudio(guildId);
    }
  });

  player.on("error", async (error) => {
    console.error("Audio player error:", error);
    state.current = null;
    await playNextTrack(guildId);
  });

  player.on(AudioPlayerStatus.Idle, async () => {
    if (!state.cleaning) {
      state.current = null;
      await playNextTrack(guildId);
    }
  });

  guildAudioState.set(guildId, state);
  return state;
}

async function safeInteractionReply(interaction, payload) {
  if (interaction.deferred) {
    await interaction.editReply(payload);
    return;
  }

  if (interaction.replied) {
    await interaction.followUp(payload);
    return;
  }

  await interaction.reply(payload);
}

function normalizePlayInput(rawInput) {
  const trimmed = rawInput.trim();

  // Accept markdown-style links such as [text](https://...)
  const markdownMatch = trimmed.match(/^\[[^\]]+\]\((https?:\/\/[^\s)]+)\)$/i);
  const normalized = markdownMatch ? markdownMatch[1].trim() : trimmed;

  if (!(normalized.startsWith("http://") || normalized.startsWith("https://"))) {
    return normalized;
  }

  const parsed = new URL(normalized);
  const host = parsed.hostname.replace(/^www\./, "").toLowerCase();

  if (host === "youtube.com" || host === "m.youtube.com") {
    // If a direct video id is present, force a stable watch URL and drop mix/radio params.
    const videoId = parsed.searchParams.get("v");
    if (videoId) {
      return `https://www.youtube.com/watch?v=${videoId}`;
    }

    // If this is a playlist-only URL, keep just the playlist id.
    const playlistId = parsed.searchParams.get("list");
    if (playlistId) {
      return `https://www.youtube.com/playlist?list=${playlistId}`;
    }
  }

  return normalized;
}

async function resolvePlayableInput(input) {
  const trimmed = normalizePlayInput(input);
  let videoUrl = null;
  let sourceNote = null;

  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
    const parsed = new URL(trimmed);

    if (parsed.hostname === "youtu.be") {
      const id = parsed.pathname.replace("/", "");
      if (!id) {
        throw new Error("Invalid YouTube short link.");
      }

      videoUrl = `https://www.youtube.com/watch?v=${id}`;
    } else {
      videoUrl = trimmed;

      // Playlist links without an explicit video should resolve to the first track.
      if (parsed.searchParams.has("list") && !parsed.searchParams.has("v")) {
        const playlistUrl = `https://www.youtube.com/playlist?list=${parsed.searchParams.get("list")}`;
        const playlistInfo = await ytdlExec(playlistUrl, {
          dumpSingleJson: true,
          noWarnings: true,
          skipDownload: true,
          flatPlaylist: true,
          playlistItems: "1",
        });

        const firstEntry =
          Array.isArray(playlistInfo?.entries) && playlistInfo.entries.length > 0
            ? playlistInfo.entries[0]
            : null;

        if (!firstEntry?.id) {
          throw new Error("Could not find a playable track in that playlist.");
        }

        videoUrl = `https://www.youtube.com/watch?v=${firstEntry.id}`;
        sourceNote = playlistInfo?.title
          ? `From playlist: ${playlistInfo.title}`
          : "From playlist input";
      }
    }
  } else {
    const searchResult = await ytdlExec(`ytsearch1:${trimmed}`, {
      dumpSingleJson: true,
      noWarnings: true,
      skipDownload: true,
    });

    const firstResult =
      Array.isArray(searchResult?.entries) && searchResult.entries.length > 0
        ? searchResult.entries[0]
        : null;

    if (!firstResult?.id) {
      throw new Error("No YouTube results found.");
    }

    videoUrl = `https://www.youtube.com/watch?v=${firstResult.id}`;
  }

  const info = await ytdlExec(videoUrl, {
    dumpSingleJson: true,
    noWarnings: true,
    skipDownload: true,
    format: "bestaudio[acodec=opus][ext=webm]/bestaudio[ext=webm]/bestaudio",
  });

  if (!info?.url) {
    throw new Error("Could not extract a playable audio stream.");
  }

  return {
    title: info.title || videoUrl,
    webpageUrl: info.webpage_url || videoUrl,
    videoUrl,
    sourceNote,
  };
}

async function createTrackResource(track) {
  const info = await ytdlExec(track.videoUrl, {
    dumpSingleJson: true,
    noWarnings: true,
    skipDownload: true,
    format: "bestaudio[acodec=opus][ext=webm]/bestaudio[ext=webm]/bestaudio",
  });

  if (!info?.url) {
    throw new Error("Could not extract a playable audio stream.");
  }

  const response = await fetch(info.url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    },
  });

  if (!response.ok || !response.body) {
    throw new Error(`Audio source request failed (${response.status}).`);
  }

  const upstreamStream = Readable.fromWeb(response.body);
  const probed = await demuxProbe(upstreamStream);

  return createAudioResource(probed.stream, {
    inputType: probed.type,
    silencePaddingFrames: 5,
  });
}

async function startTrack(guildId, track) {
  const state = guildAudioState.get(guildId);
  if (!state) return;

  state.current = track;

  try {
    const resource = await createTrackResource(track);
    state.player.play(resource);
  } catch (error) {
    console.error("Failed to start track:", error);
    state.current = null;
    await playNextTrack(guildId);
  }
}

async function playNextTrack(guildId) {
  const state = guildAudioState.get(guildId);
  if (!state || state.cleaning) return;

  const nextTrack = state.queue.shift();
  if (!nextTrack) {
    cleanupGuildAudio(guildId);
    return;
  }

  await startTrack(guildId, nextTrack);
}

client.once(Events.ClientReady, (readyClient) => {
  console.log(`Hathor is online as ${readyClient.user.tag}`);
  readyClient.user.setActivity("Hymns of the Nile", { type: 0 });

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
    new SlashCommandBuilder()
      .setName("queue")
      .setDescription("Show the current queue."),
    new SlashCommandBuilder()
      .setName("skip")
      .setDescription("Skip the current track."),
    new SlashCommandBuilder()
      .setName("clear")
      .setDescription("Clear upcoming tracks from the queue."),
    new SlashCommandBuilder()
      .setName("remove")
      .setDescription("Remove a queued track by its queue position.")
      .addIntegerOption((option) =>
        option
          .setName("index")
          .setDescription("Queue position from /queue (1 = first upcoming track)")
          .setRequired(true)
          .setMinValue(1)
      ),
  ].map((command) => command.toJSON());

  readyClient.application.commands
    .set(commands)
    .then(() => console.log("Slash commands registered."))
    .catch((error) => console.error("Failed to register commands:", error));
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  try {
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

    if (interaction.commandName === "queue") {
      if (!interaction.guildId) {
        await interaction.reply({
          content: "This command can only be used in a server.",
          ephemeral: true,
        });
        return;
      }

      const state = guildAudioState.get(interaction.guildId);
      if (!state || !state.current) {
        await interaction.reply({
          content: "The queue is empty.",
          ephemeral: true,
        });
        return;
      }

      const upcoming = state.queue.length
        ? state.queue
            .slice(0, 10)
            .map((track, index) => `${index + 1}. ${track.title}`)
            .join("\n")
        : "No upcoming tracks.";

      const extraCount = state.queue.length > 10 ? `\n...and ${state.queue.length - 10} more.` : "";

      await interaction.reply(
        `Now playing: ${state.current.title}\n\nUp next:\n${upcoming}${extraCount}`
      );
    }

    if (interaction.commandName === "skip") {
      if (!interaction.guildId) {
        await interaction.reply({
          content: "This command can only be used in a server.",
          ephemeral: true,
        });
        return;
      }

      const state = guildAudioState.get(interaction.guildId);
      if (!state || !state.current) {
        await interaction.reply({
          content: "Nothing is currently playing.",
          ephemeral: true,
        });
        return;
      }

      const skippedTitle = state.current.title;
      state.current = null;
      state.player.stop(true);

      const nextTitle = state.queue[0]?.title;
      if (nextTitle) {
        await interaction.reply(`Skipped: ${skippedTitle}\nUp next: ${nextTitle}`);
      } else {
        await interaction.reply(`Skipped: ${skippedTitle}\nQueue is now empty.`);
      }
    }

    if (interaction.commandName === "clear") {
      if (!interaction.guildId) {
        await interaction.reply({
          content: "This command can only be used in a server.",
          ephemeral: true,
        });
        return;
      }

      const state = guildAudioState.get(interaction.guildId);
      if (!state || state.queue.length === 0) {
        await interaction.reply({
          content: "There are no upcoming tracks to clear.",
          ephemeral: true,
        });
        return;
      }

      const clearedCount = state.queue.length;
      state.queue = [];
      await interaction.reply(`Cleared ${clearedCount} queued track(s).`);
    }

    if (interaction.commandName === "remove") {
      if (!interaction.guildId) {
        await interaction.reply({
          content: "This command can only be used in a server.",
          ephemeral: true,
        });
        return;
      }

      const state = guildAudioState.get(interaction.guildId);
      if (!state || state.queue.length === 0) {
        await interaction.reply({
          content: "There are no queued tracks to remove.",
          ephemeral: true,
        });
        return;
      }

      const index = interaction.options.getInteger("index", true);
      if (index > state.queue.length) {
        await interaction.reply({
          content: `Invalid index. Choose a value between 1 and ${state.queue.length}.`,
          ephemeral: true,
        });
        return;
      }

      const [removedTrack] = state.queue.splice(index - 1, 1);
      await interaction.reply(`Removed #${index}: ${removedTrack.title}`);
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

      await interaction.deferReply();

      const existing = guildAudioState.get(interaction.guildId);
      if (existing && existing.connection.joinConfig.channelId !== memberChannel.id) {
        cleanupGuildAudio(interaction.guildId);
      }

      const resolved = await resolvePlayableInput(input);
      let state = guildAudioState.get(interaction.guildId);
      if (!state) {
        state = createGuildAudioState(
          interaction.guildId,
          interaction.guild,
          memberChannel.id
        );
        await entersState(state.connection, VoiceConnectionStatus.Ready, 15_000);
      }

      const sourceLine = resolved.sourceNote ? `\n${resolved.sourceNote}` : "";

      if (state.current) {
        state.queue.push(resolved);
        await interaction.editReply(
          `Queued #${state.queue.length}: ${resolved.title}\n${resolved.webpageUrl}${sourceLine}`
        );
        return;
      }

      await startTrack(interaction.guildId, resolved);
      await interaction.editReply(
        `Now playing: ${resolved.title}\n${resolved.webpageUrl}${sourceLine}`
      );
    }
  } catch (error) {
    console.error("Interaction handling error:", error);

    if (interaction.commandName === "play" && interaction.guildId) {
      cleanupGuildAudio(interaction.guildId);
    }

    const safeReason =
      error && typeof error.message === "string" && error.message.length < 140
        ? error.message
        : "Something went wrong while handling that command.";

    await safeInteractionReply(interaction, {
      content: `Error: ${safeReason}`,
      ephemeral: true,
    });
  }
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

  for (const guildId of guildAudioState.keys()) {
    cleanupGuildAudio(guildId);
  }

  client.destroy();
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

client.login(token);
