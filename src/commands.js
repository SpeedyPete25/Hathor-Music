const { PermissionFlagsBits, SlashCommandBuilder } = require("discord.js");

function buildCommands() {
  return [
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
    new SlashCommandBuilder()
      .setName("playnext")
      .setDescription("Add a track to the front of the queue.")
      .addStringOption((option) =>
        option
          .setName("input")
          .setDescription("YouTube URL or search text")
          .setRequired(true)
      ),
    new SlashCommandBuilder()
      .setName("move")
      .setDescription("Move a queued track to a different position.")
      .addIntegerOption((option) =>
        option
          .setName("from")
          .setDescription("Current queue position")
          .setRequired(true)
          .setMinValue(1)
      )
      .addIntegerOption((option) =>
        option
          .setName("to")
          .setDescription("New queue position")
          .setRequired(true)
          .setMinValue(1)
      ),
    new SlashCommandBuilder()
      .setName("swap")
      .setDescription("Swap two queued tracks.")
      .addIntegerOption((option) =>
        option
          .setName("first")
          .setDescription("First queue position")
          .setRequired(true)
          .setMinValue(1)
      )
      .addIntegerOption((option) =>
        option
          .setName("second")
          .setDescription("Second queue position")
          .setRequired(true)
          .setMinValue(1)
      ),
    new SlashCommandBuilder()
      .setName("shuffle")
      .setDescription("Shuffle upcoming tracks in the queue."),
    new SlashCommandBuilder()
      .setName("loop")
      .setDescription("Set loop mode for playback.")
      .addStringOption((option) =>
        option
          .setName("mode")
          .setDescription("Loop mode")
          .setRequired(true)
          .addChoices(
            { name: "Off", value: "off" },
            { name: "Track", value: "track" },
            { name: "Queue", value: "queue" }
          )
      ),
    new SlashCommandBuilder()
      .setName("repeat")
      .setDescription("Set repeat mode (alias for /loop).")
      .addStringOption((option) =>
        option
          .setName("mode")
          .setDescription("Repeat mode")
          .setRequired(true)
          .addChoices(
            { name: "Off", value: "off" },
            { name: "Track", value: "track" },
            { name: "Queue", value: "queue" }
          )
      ),
  ].map((command) => command.toJSON());
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

async function canUseDestructiveCommand(interaction, state) {
  if (!interaction.guild) return false;

  const member = await interaction.guild.members.fetch(interaction.user.id);

  if (member.permissions.has(PermissionFlagsBits.ManageGuild)) {
    return true;
  }

  const botChannelId = state?.connection?.joinConfig?.channelId;
  if (botChannelId && member.voice?.channelId === botChannelId) {
    return true;
  }

  if (state?.current?.requesterId && state.current.requesterId === interaction.user.id) {
    return true;
  }

  return false;
}

async function handleInteraction(interaction, musicManager) {
  if (!interaction.isChatInputCommand()) return;

  let playShouldCleanupOnError = false;

  try {
    if (interaction.commandName === "ping") {
      await interaction.reply("Pong from Hathor.");
      return;
    }

    if (interaction.commandName === "hathor") {
      await interaction.reply("Hathor is listening.");
      return;
    }

    if (interaction.commandName === "leave") {
      if (!interaction.guildId) {
        await interaction.reply({
          content: "This command can only be used in a server.",
          ephemeral: true,
        });
        return;
      }

      musicManager.cleanupGuildAudio(interaction.guildId);
      await interaction.reply("Left the voice channel.");
      return;
    }

    if (interaction.commandName === "queue") {
      if (!interaction.guildId) {
        await interaction.reply({
          content: "This command can only be used in a server.",
          ephemeral: true,
        });
        return;
      }

      const queueView = musicManager.getQueueView(interaction.guildId);
      if (!queueView) {
        await interaction.reply({
          content: "The queue is empty.",
          ephemeral: true,
        });
        return;
      }

      await interaction.reply(queueView);
      return;
    }

    if (interaction.commandName === "skip") {
      if (!interaction.guildId) {
        await interaction.reply({
          content: "This command can only be used in a server.",
          ephemeral: true,
        });
        return;
      }

      const state = musicManager.getState(interaction.guildId);
      if (!state || !state.current) {
        await interaction.reply({
          content: "Nothing is currently playing.",
          ephemeral: true,
        });
        return;
      }

      const allowed = await canUseDestructiveCommand(interaction, state);
      if (!allowed) {
        await interaction.reply({
          content:
            "You can only use this command if you requested the current track, are in Hathor's voice channel, or have Manage Server.",
          ephemeral: true,
        });
        return;
      }

      const message = musicManager.skip(interaction.guildId);

      await interaction.reply(message);
      return;
    }

    if (interaction.commandName === "clear") {
      if (!interaction.guildId) {
        await interaction.reply({
          content: "This command can only be used in a server.",
          ephemeral: true,
        });
        return;
      }

      const state = musicManager.getState(interaction.guildId);
      if (!state || state.queue.length === 0) {
        await interaction.reply({
          content: "There are no upcoming tracks to clear.",
          ephemeral: true,
        });
        return;
      }

      const allowed = await canUseDestructiveCommand(interaction, state);
      if (!allowed) {
        await interaction.reply({
          content:
            "You can only use this command if you requested the current track, are in Hathor's voice channel, or have Manage Server.",
          ephemeral: true,
        });
        return;
      }

      const clearedCount = musicManager.clear(interaction.guildId);

      await interaction.reply(`Cleared ${clearedCount} queued track(s).`);
      return;
    }

    if (interaction.commandName === "remove") {
      if (!interaction.guildId) {
        await interaction.reply({
          content: "This command can only be used in a server.",
          ephemeral: true,
        });
        return;
      }

      const state = musicManager.getState(interaction.guildId);
      if (!state || state.queue.length === 0) {
        await interaction.reply({
          content: "There are no queued tracks to remove.",
          ephemeral: true,
        });
        return;
      }

      const allowed = await canUseDestructiveCommand(interaction, state);
      if (!allowed) {
        await interaction.reply({
          content:
            "You can only use this command if you requested the current track, are in Hathor's voice channel, or have Manage Server.",
          ephemeral: true,
        });
        return;
      }

      const index = interaction.options.getInteger("index", true);
      const result = musicManager.remove(interaction.guildId, index);

      if (result.error) {
        await interaction.reply({
          content: result.error,
          ephemeral: true,
        });
        return;
      }

      await interaction.reply(`Removed #${index}: ${result.removedTrack.title}`);
      return;
    }

    if (interaction.commandName === "move") {
      if (!interaction.guildId) {
        await interaction.reply({
          content: "This command can only be used in a server.",
          ephemeral: true,
        });
        return;
      }

      const state = musicManager.getState(interaction.guildId);
      if (!state || state.queue.length === 0) {
        await interaction.reply({
          content: "There are no queued tracks to move.",
          ephemeral: true,
        });
        return;
      }

      const allowed = await canUseDestructiveCommand(interaction, state);
      if (!allowed) {
        await interaction.reply({
          content:
            "You can only use this command if you requested the current track, are in Hathor's voice channel, or have Manage Server.",
          ephemeral: true,
        });
        return;
      }

      const fromIndex = interaction.options.getInteger("from", true);
      const toIndex = interaction.options.getInteger("to", true);
      const result = musicManager.move(interaction.guildId, fromIndex, toIndex);

      if (result.error) {
        await interaction.reply({
          content: result.error,
          ephemeral: true,
        });
        return;
      }

      await interaction.reply(`Moved #${fromIndex} -> #${toIndex}: ${result.track.title}`);
      return;
    }

    if (interaction.commandName === "swap") {
      if (!interaction.guildId) {
        await interaction.reply({
          content: "This command can only be used in a server.",
          ephemeral: true,
        });
        return;
      }

      const state = musicManager.getState(interaction.guildId);
      if (!state || state.queue.length < 2) {
        await interaction.reply({
          content: "Need at least two queued tracks to swap.",
          ephemeral: true,
        });
        return;
      }

      const allowed = await canUseDestructiveCommand(interaction, state);
      if (!allowed) {
        await interaction.reply({
          content:
            "You can only use this command if you requested the current track, are in Hathor's voice channel, or have Manage Server.",
          ephemeral: true,
        });
        return;
      }

      const firstIndex = interaction.options.getInteger("first", true);
      const secondIndex = interaction.options.getInteger("second", true);
      const result = musicManager.swap(interaction.guildId, firstIndex, secondIndex);

      if (result.error) {
        await interaction.reply({
          content: result.error,
          ephemeral: true,
        });
        return;
      }

      await interaction.reply(
        `Swapped #${firstIndex} (${result.firstTrack.title}) with #${secondIndex} (${result.secondTrack.title}).`
      );
      return;
    }

    if (interaction.commandName === "shuffle") {
      if (!interaction.guildId) {
        await interaction.reply({
          content: "This command can only be used in a server.",
          ephemeral: true,
        });
        return;
      }

      const state = musicManager.getState(interaction.guildId);
      if (!state || state.queue.length < 2) {
        await interaction.reply({
          content: "Need at least two queued tracks to shuffle.",
          ephemeral: true,
        });
        return;
      }

      const allowed = await canUseDestructiveCommand(interaction, state);
      if (!allowed) {
        await interaction.reply({
          content:
            "You can only use this command if you requested the current track, are in Hathor's voice channel, or have Manage Server.",
          ephemeral: true,
        });
        return;
      }

      const result = musicManager.shuffle(interaction.guildId);

      if (result.error) {
        await interaction.reply({
          content: result.error,
          ephemeral: true,
        });
        return;
      }

      await interaction.reply(`Shuffled ${result.count} queued track(s).`);
      return;
    }

    if (interaction.commandName === "loop" || interaction.commandName === "repeat") {
      if (!interaction.guildId) {
        await interaction.reply({
          content: "This command can only be used in a server.",
          ephemeral: true,
        });
        return;
      }

      const state = musicManager.getState(interaction.guildId);
      if (!state) {
        await interaction.reply({
          content: "Nothing is currently active.",
          ephemeral: true,
        });
        return;
      }

      const allowed = await canUseDestructiveCommand(interaction, state);
      if (!allowed) {
        await interaction.reply({
          content:
            "You can only use this command if you requested the current track, are in Hathor's voice channel, or have Manage Server.",
          ephemeral: true,
        });
        return;
      }

      const mode = interaction.options.getString("mode", true);
      const result = musicManager.setLoopMode(interaction.guildId, mode);

      if (result.error) {
        await interaction.reply({
          content: result.error,
          ephemeral: true,
        });
        return;
      }

      await interaction.reply(`Loop mode set to: ${result.mode}`);
      return;
    }

    if (interaction.commandName === "play" || interaction.commandName === "playnext") {
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

      const commandName = interaction.commandName;

      if (commandName === "playnext") {
        const state = musicManager.getState(interaction.guildId);
        if (state) {
          const allowed = await canUseDestructiveCommand(interaction, state);
          if (!allowed) {
            await interaction.editReply(
              "You can only use this command if you requested the current track, are in Hathor's voice channel, or have Manage Server."
            );
            return;
          }
        }
      }

      const input = interaction.options.getString("input", true);

      if (commandName === "playnext") {
        const state = musicManager.getState(interaction.guildId);
        if (state) {
          const resolved = await musicManager.withTimeout(
            musicManager.resolvePlayableInput(input),
            musicManager.resolveTimeoutMs,
            "I couldn't resolve that track in time. Try another link or search."
          );

          resolved.requesterId = interaction.user.id;
          const result = musicManager.playNext(interaction.guildId, resolved);

          if (result.error) {
            await interaction.editReply(result.error);
            return;
          }

          if (!state.current) {
            await musicManager.playNextTrack(interaction.guildId);
          }

          const sourceLine = resolved.sourceNote ? `\n${resolved.sourceNote}` : "";
          await interaction.editReply(
            `Added to play next: ${resolved.title}\n${resolved.webpageUrl}${sourceLine}`
          );
          return;
        }
      }

      const playResult = await musicManager.playInput({
        guildId: interaction.guildId,
        guild: interaction.guild,
        channelId: memberChannel.id,
        textChannelId: interaction.channelId,
        input,
        requesterId: interaction.user.id,
      });

      playShouldCleanupOnError = false;
      await interaction.editReply(playResult.message);
      return;
    }
  } catch (error) {
    console.error("Interaction handling error:", error);

    if (interaction.commandName === "play" && interaction.guildId && playShouldCleanupOnError) {
      musicManager.cleanupGuildAudio(interaction.guildId);
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
}

module.exports = {
  buildCommands,
  handleInteraction,
};
