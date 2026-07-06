const { SlashCommandBuilder } = require("discord.js");

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

      const message = musicManager.skip(interaction.guildId);
      if (!message) {
        await interaction.reply({
          content: "Nothing is currently playing.",
          ephemeral: true,
        });
        return;
      }

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

      const clearedCount = musicManager.clear(interaction.guildId);
      if (clearedCount === 0) {
        await interaction.reply({
          content: "There are no upcoming tracks to clear.",
          ephemeral: true,
        });
        return;
      }

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
        input: interaction.options.getString("input", true),
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
