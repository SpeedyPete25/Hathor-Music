const { Readable } = require("node:stream");
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

class MusicManager {
  constructor({ connectTimeoutMs, resolveTimeoutMs, startTimeoutMs, announcer }) {
    this.connectTimeoutMs = connectTimeoutMs;
    this.resolveTimeoutMs = resolveTimeoutMs;
    this.startTimeoutMs = startTimeoutMs;
    this.announcer = announcer;
    this.guildAudioState = new Map();
  }

  getErrorMessage(error) {
    if (error && typeof error.message === "string" && error.message.length < 180) {
      return error.message;
    }

    return "Unknown playback error.";
  }

  async announce(guildId, message) {
    if (!this.announcer) return;

    try {
      await this.announcer({ guildId, message });
    } catch (error) {
      console.error("Failed to announce playback message:", error);
    }
  }

  getState(guildId) {
    return this.guildAudioState.get(guildId);
  }

  cleanupGuildAudio(guildId) {
    const state = this.guildAudioState.get(guildId);
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

    this.guildAudioState.delete(guildId);
  }

  createGuildAudioState(guildId, guild, channelId) {
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
      textChannelId: null,
    };

    connection.on("error", (error) => {
      console.error("Voice connection error:", error);
      this.cleanupGuildAudio(guildId);
    });

    connection.on(VoiceConnectionStatus.Disconnected, async () => {
      try {
        await Promise.race([
          entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
          entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
        ]);
      } catch {
        this.cleanupGuildAudio(guildId);
      }
    });

    player.on("error", async (error) => {
      console.error("Audio player error:", error);
      const failedTrack = state.current;
      state.current = null;

      if (failedTrack) {
        await this.announce(
          guildId,
          `Playback failed for ${failedTrack.title}: ${this.getErrorMessage(error)}`
        );
      }

      await this.playNextTrack(guildId);
    });

    player.on(AudioPlayerStatus.Idle, async () => {
      if (!state.cleaning) {
        state.current = null;
        await this.playNextTrack(guildId);
      }
    });

    this.guildAudioState.set(guildId, state);
    return state;
  }

  withTimeout(promise, timeoutMs, message) {
    let timeoutId;

    const timeoutPromise = new Promise((_, reject) => {
      timeoutId = setTimeout(() => reject(new Error(message)), timeoutMs);
    });

    return Promise.race([
      promise.finally(() => clearTimeout(timeoutId)),
      timeoutPromise,
    ]);
  }

  normalizePlayInput(rawInput) {
    const trimmed = rawInput.trim();

    const markdownMatch = trimmed.match(/^\[[^\]]+\]\((https?:\/\/[^\s)]+)\)$/i);
    const normalized = markdownMatch ? markdownMatch[1].trim() : trimmed;

    if (!(normalized.startsWith("http://") || normalized.startsWith("https://"))) {
      return normalized;
    }

    const parsed = new URL(normalized);
    const host = parsed.hostname.replace(/^www\./, "").toLowerCase();

    if (host === "youtube.com" || host === "m.youtube.com") {
      const videoId = parsed.searchParams.get("v");
      if (videoId) {
        return `https://www.youtube.com/watch?v=${videoId}`;
      }

      const playlistId = parsed.searchParams.get("list");
      if (playlistId) {
        return `https://www.youtube.com/playlist?list=${playlistId}`;
      }
    }

    return normalized;
  }

  async resolvePlayableInput(input) {
    const trimmed = this.normalizePlayInput(input);
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

  async createTrackResource(track) {
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

  async startTrack(guildId, track) {
    const state = this.guildAudioState.get(guildId);
    if (!state) {
      return {
        ok: false,
        error: new Error("Audio state was not found for this server."),
      };
    }

    state.current = track;

    try {
      const resource = await this.createTrackResource(track);
      state.player.play(resource);
      return { ok: true };
    } catch (error) {
      console.error("Failed to start track:", error);
      state.current = null;
      return { ok: false, error };
    }
  }

  async playNextTrack(guildId) {
    const state = this.guildAudioState.get(guildId);
    if (!state || state.cleaning) return;

    while (state.queue.length > 0) {
      const nextTrack = state.queue.shift();
      const startResult = await this.startTrack(guildId, nextTrack);

      if (startResult.ok) {
        return;
      }

      console.error("Skipping unplayable queued track:", startResult.error);
      await this.announce(
        guildId,
        `Skipped queued track ${nextTrack.title}: ${this.getErrorMessage(startResult.error)}`
      );
    }

    this.cleanupGuildAudio(guildId);
  }

  async ensureVoiceConnection(guildId, guild, channelId) {
    let state = this.guildAudioState.get(guildId);
    let created = false;

    if (!state) {
      state = this.createGuildAudioState(guildId, guild, channelId);
      created = true;
      await this.withTimeout(
        entersState(state.connection, VoiceConnectionStatus.Ready, this.connectTimeoutMs),
        this.connectTimeoutMs,
        "Voice connection timed out. Check channel permissions and try again."
      );
    }

    return { state, created };
  }

  async playInput({ guildId, guild, channelId, textChannelId, input }) {
    const existing = this.guildAudioState.get(guildId);

    if (existing && existing.connection.joinConfig.channelId !== channelId) {
      this.cleanupGuildAudio(guildId);
    }

    let created = false;

    try {
      const resolved = await this.withTimeout(
        this.resolvePlayableInput(input),
        this.resolveTimeoutMs,
        "I couldn't resolve that track in time. Try another link or search."
      );

      const ensureResult = await this.ensureVoiceConnection(guildId, guild, channelId);
      const state = ensureResult.state;
      created = ensureResult.created;
      state.textChannelId = textChannelId;
      const sourceLine = resolved.sourceNote ? `\n${resolved.sourceNote}` : "";

      if (state.current) {
        state.queue.push(resolved);
        return {
          mode: "queued",
          message: `Queued #${state.queue.length}: ${resolved.title}\n${resolved.webpageUrl}${sourceLine}`,
        };
      }

      const startResult = await this.withTimeout(
        this.startTrack(guildId, resolved),
        this.startTimeoutMs,
        "Playback start timed out. The source may be blocked or unavailable."
      );

      if (!startResult.ok) {
        const details =
          startResult.error && typeof startResult.error.message === "string"
            ? startResult.error.message
            : "Unknown playback error.";
        throw new Error(`Failed to start playback: ${details}`);
      }

      return {
        mode: "playing",
        message: `Now playing: ${resolved.title}\n${resolved.webpageUrl}${sourceLine}`,
      };
    } catch (error) {
      if (created) {
        this.cleanupGuildAudio(guildId);
      }

      throw error;
    }
  }

  getQueueView(guildId) {
    const state = this.guildAudioState.get(guildId);
    if (!state || !state.current) {
      return null;
    }

    const upcoming = state.queue.length
      ? state.queue
          .slice(0, 10)
          .map((track, index) => `${index + 1}. ${track.title}`)
          .join("\n")
      : "No upcoming tracks.";

    const extraCount = state.queue.length > 10 ? `\n...and ${state.queue.length - 10} more.` : "";

    return `Now playing: ${state.current.title}\n\nUp next:\n${upcoming}${extraCount}`;
  }

  skip(guildId) {
    const state = this.guildAudioState.get(guildId);
    if (!state || !state.current) {
      return null;
    }

    const skippedTitle = state.current.title;
    state.current = null;
    state.player.stop(true);

    const nextTitle = state.queue[0]?.title;
    if (nextTitle) {
      return `Skipped: ${skippedTitle}\nUp next: ${nextTitle}`;
    }

    return `Skipped: ${skippedTitle}\nQueue is now empty.`;
  }

  clear(guildId) {
    const state = this.guildAudioState.get(guildId);
    if (!state || state.queue.length === 0) {
      return 0;
    }

    const clearedCount = state.queue.length;
    state.queue = [];
    return clearedCount;
  }

  remove(guildId, index) {
    const state = this.guildAudioState.get(guildId);
    if (!state || state.queue.length === 0) {
      return { error: "There are no queued tracks to remove." };
    }

    if (index > state.queue.length) {
      return {
        error: `Invalid index. Choose a value between 1 and ${state.queue.length}.`,
      };
    }

    const [removedTrack] = state.queue.splice(index - 1, 1);
    return { removedTrack };
  }
}

module.exports = {
  MusicManager,
};
