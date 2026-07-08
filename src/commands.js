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

      const playResult = await musicManager.playInput({
        guildId: interaction.guildId,
        guild: interaction.guild,
        channelId: memberChannel.id,
        textChannelId: interaction.channelId,
        input: interaction.options.getString("input", true),
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
