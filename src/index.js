require("dotenv").config();

const fs = require("node:fs");
const path = require("node:path");
const {
  Client,
  Events,
  GatewayIntentBits,
  SlashCommandBuilder,
} = require("discord.js");

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
  ],
});

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
});

client.login(token);
