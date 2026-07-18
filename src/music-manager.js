const { Readable } = require("node:stream");
const fs = require("node:fs");
const path = require("node:path");
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
    this.idleDisconnectMs = 60_000;
    this.guildAudioState = new Map();
    this.dataDir = path.join(__dirname, "..", "data");
    this.stateFilePath = path.join(this.dataDir, "music-state.json");
    this.persistedGuildState = this.loadPersistedState();
  }

  loadPersistedState() {
    try {
      if (!fs.existsSync(this.stateFilePath)) {
        return new Map();
      }

      const raw = fs.readFileSync(this.stateFilePath, "utf8");
      const parsed = JSON.parse(raw);
      return new Map(Object.entries(parsed || {}));
    } catch (error) {
      console.error("Failed to load persisted music state:", error);
      return new Map();
    }
  }

  writePersistedState() {
    try {
      if (!fs.existsSync(this.dataDir)) {
        fs.mkdirSync(this.dataDir, { recursive: true });
      }

      const data = Object.fromEntries(this.persistedGuildState.entries());
      fs.writeFileSync(this.stateFilePath, JSON.stringify(data, null, 2), "utf8");
    } catch (error) {
      console.error("Failed to persist music state:", error);
    }
  }

  sanitizeTrack(track) {
    if (!track || typeof track !== "object") return null;

    return {
      title: track.title || "Unknown title",
      webpageUrl: track.webpageUrl || null,
      videoUrl: track.videoUrl || null,
      sourceNote: track.sourceNote || null,
      requesterId: track.requesterId || null,
      durationSeconds:
        typeof track.durationSeconds === "number" && Number.isFinite(track.durationSeconds)
          ? track.durationSeconds
          : null,
      thumbnailUrl: track.thumbnailUrl || null,
    };
  }

  persistState(guildId) {
    const state = this.guildAudioState.get(guildId);

    if (!state) {
      this.persistedGuildState.delete(guildId);
      this.writePersistedState();
      return;
    }

    const current = this.sanitizeTrack(state.current);
    const queue = state.queue.map((track) => this.sanitizeTrack(track)).filter(Boolean);

    if (!current && queue.length === 0) {
      this.persistedGuildState.delete(guildId);
      this.writePersistedState();
      return;
    }

    this.persistedGuildState.set(guildId, {
      current,
      queue,
      loopMode: state.loopMode || "off",
      textChannelId: state.textChannelId || null,
      updatedAt: new Date().toISOString(),
    });

    this.writePersistedState();
  }

  restoreStateToQueue(state, guildId) {
    const persisted = this.persistedGuildState.get(guildId);
    if (!persisted) return;

    const recoveredTracks = [];
    const recoveredCurrent = this.sanitizeTrack(persisted.current);
    if (recoveredCurrent && recoveredCurrent.videoUrl) {
      recoveredTracks.push(recoveredCurrent);
    }

    for (const track of persisted.queue || []) {
      const clean = this.sanitizeTrack(track);
      if (clean && clean.videoUrl) {
        recoveredTracks.push(clean);
      }
    }

    if (recoveredTracks.length > 0) {
      state.queue.push(...recoveredTracks);
    }

    state.textChannelId = persisted.textChannelId || state.textChannelId;
    state.loopMode = ["off", "track", "queue"].includes(persisted.loopMode)
      ? persisted.loopMode
      : "off";
  }

  getErrorMessage(error) {
    if (!error || typeof error.message !== "string") {
      return "Playback failed for an unknown reason.";
    }

    const raw = error.message;
    const normalized = raw.toLowerCase();

    if (normalized.includes("timed out") || normalized.includes("timeout")) {
      return "request timed out while contacting the source.";
    }

    if (
      normalized.includes("video is not available") ||
      normalized.includes("unavailable") ||
      normalized.includes("not available")
    ) {
      return "that video is unavailable.";
    }

    if (normalized.includes("private video") || normalized.includes("private")) {
      return "that video is private.";
    }

    if (normalized.includes("sign in") || normalized.includes("age-restricted")) {
      return "that video is restricted and cannot be played by the bot.";
    }

    if (
      normalized.includes("forbidden") ||
      normalized.includes("403") ||
      normalized.includes("audio source request failed (403)")
    ) {
      return "the source blocked playback (403). Try a different track.";
    }

    if (normalized.includes("connect") && normalized.includes("speak")) {
      return "the bot is missing Connect/Speak permissions in that voice channel.";
    }

    if (raw.length < 140) {
      return raw;
    }

    return "playback failed due to an upstream source error.";
  }

  async announce(guildId, payload) {
    if (!this.announcer) return;

    try {
      if (typeof payload === "string") {
        await this.announcer({ guildId, message: payload });
        return;
      }

      await this.announcer({ guildId, ...payload });
    } catch (error) {
      console.error("Failed to announce playback message:", error);
    }
  }

  formatDuration(totalSeconds) {
    if (typeof totalSeconds !== "number" || !Number.isFinite(totalSeconds) || totalSeconds <= 0) {
      return "Unknown";
    }

    const rounded = Math.floor(totalSeconds);
    const hours = Math.floor(rounded / 3600);
    const minutes = Math.floor((rounded % 3600) / 60);
    const seconds = rounded % 60;

    if (hours > 0) {
      return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
    }

    return `${minutes}:${String(seconds).padStart(2, "0")}`;
  }

  buildProgressBar(elapsedSeconds, totalSeconds) {
    if (
      typeof elapsedSeconds !== "number" ||
      !Number.isFinite(elapsedSeconds) ||
      typeof totalSeconds !== "number" ||
      !Number.isFinite(totalSeconds) ||
      totalSeconds <= 0
    ) {
      return "Live stream";
    }

    const width = 16;
    const ratio = Math.min(1, Math.max(0, elapsedSeconds / totalSeconds));
    const marker = Math.min(width - 1, Math.floor(ratio * width));
    const chars = [];

    for (let i = 0; i < width; i += 1) {
      if (i === marker) {
        chars.push("o");
      } else if (i < marker) {
        chars.push("=");
      } else {
        chars.push("-");
      }
    }

    return `[${chars.join("")}]`;
  }

  buildSourceLabel(track) {
    if (!track?.webpageUrl) {
      return "Unknown source";
    }

    try {
      const parsed = new URL(track.webpageUrl);
      const host = parsed.hostname.replace(/^www\./i, "").toLowerCase();

      if (host.includes("youtube.com") || host.includes("youtu.be")) {
        return "YouTube";
      }

      return host;
    } catch {
      return "Unknown source";
    }
  }

  buildNowPlayingEmbed(track, state) {
    const elapsedSeconds = Math.max(0, (Date.now() - (track.startedAt || Date.now())) / 1000);
    const durationText = this.formatDuration(track.durationSeconds);
    const elapsedText = this.formatDuration(elapsedSeconds);
    const progressBar = this.buildProgressBar(elapsedSeconds, track.durationSeconds);
    const sourceLabel = this.buildSourceLabel(track);

    const embed = {
      color: 0xd4af37,
      title: "Now Playing",
      description: track.webpageUrl
        ? `[${track.title}](${track.webpageUrl})`
        : track.title,
      fields: [
        {
          name: "Progress",
          value:
            durationText === "Unknown"
              ? `${progressBar}\n${elapsedText} / Unknown`
              : `${progressBar}\n${elapsedText} / ${durationText}`,
        },
        {
          name: "Requester",
          value: track.requesterId ? `<@${track.requesterId}>` : "Unknown",
          inline: true,
        },
        {
          name: "Duration",
          value: durationText,
          inline: true,
        },
        {
          name: "Source",
          value: track.webpageUrl ? `[${sourceLabel}](${track.webpageUrl})` : sourceLabel,
          inline: true,
        },
      ],
      timestamp: new Date().toISOString(),
      footer: {
        text: `Loop mode: ${state?.loopMode || "off"}`,
      },
    };

    if (track.thumbnailUrl) {
      embed.thumbnail = { url: track.thumbnailUrl };
    }

    return embed;
  }

  getState(guildId) {
    return this.guildAudioState.get(guildId);
  }

  cleanupGuildAudio(guildId) {
    const state = this.guildAudioState.get(guildId);
    if (!state || state.cleaning) return;

    state.cleaning = true;

    if (state.leaveTimer) {
      clearTimeout(state.leaveTimer);
      state.leaveTimer = null;
    }

    this.stopNowPlayingTicker(guildId);

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
    this.persistState(guildId);
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
      leaveTimer: null,
      loopMode: "off",
      nowPlayingTicker: null,
    };

    this.restoreStateToQueue(state, guildId);

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
      this.stopNowPlayingTicker(guildId);
      state.current = null;
      this.persistState(guildId);

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
        this.stopNowPlayingTicker(guildId);
        state.current = null;
        this.persistState(guildId);
        await this.playNextTrack(guildId);
      }
    });

    this.guildAudioState.set(guildId, state);
    this.persistState(guildId);
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
      durationSeconds:
        typeof info.duration === "number" && Number.isFinite(info.duration) ? info.duration : null,
      thumbnailUrl:
        (Array.isArray(info.thumbnails) && info.thumbnails.length > 0
          ? info.thumbnails[info.thumbnails.length - 1]?.url
          : null) || info.thumbnail || null,
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

    if (state.leaveTimer) {
      clearTimeout(state.leaveTimer);
      state.leaveTimer = null;
    }

    track.startedAt = Date.now();
    state.current = track;
    this.persistState(guildId);

    try {
      const resource = await this.createTrackResource(track);
      state.player.play(resource);

      await this.announce(guildId, {
        embed: this.buildNowPlayingEmbed(track, state),
        nowPlaying: true,
      });
      this.startNowPlayingTicker(guildId);

      return { ok: true };
    } catch (error) {
      console.error("Failed to start track:", error);
      this.stopNowPlayingTicker(guildId);
      state.current = null;
      this.persistState(guildId);
      return { ok: false, error };
    }
  }

  startNowPlayingTicker(guildId) {
    const state = this.guildAudioState.get(guildId);
    if (!state) return;

    this.stopNowPlayingTicker(guildId);

    state.nowPlayingTicker = setInterval(async () => {
      const liveState = this.guildAudioState.get(guildId);
      if (!liveState || liveState.cleaning || !liveState.current) {
        this.stopNowPlayingTicker(guildId);
        return;
      }

      await this.announce(guildId, {
        embed: this.buildNowPlayingEmbed(liveState.current, liveState),
        nowPlaying: true,
      });
    }, 12_000);
  }

  stopNowPlayingTicker(guildId) {
    const state = this.guildAudioState.get(guildId);
    if (!state || !state.nowPlayingTicker) return;

    clearInterval(state.nowPlayingTicker);
    state.nowPlayingTicker = null;
  }

  async playNextTrack(guildId) {
    const state = this.guildAudioState.get(guildId);
    if (!state || state.cleaning) return;

    if (state.loopMode === "track" && state.current) {
      const replayTrack = { ...state.current };
      const startResult = await this.startTrack(guildId, replayTrack);

      if (startResult.ok) {
        return;
      }

      console.error("Failed to replay looped track:", startResult.error);
      await this.announce(
        guildId,
        `Looped track failed ${replayTrack.title}: ${this.getErrorMessage(startResult.error)}`
      );
    }

    if (state.loopMode === "queue" && state.current) {
      state.queue.push({ ...state.current });
      this.persistState(guildId);
    }

    while (state.queue.length > 0) {
      const nextTrack = state.queue.shift();
      this.persistState(guildId);
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

    this.scheduleCleanup(guildId);
  }

  scheduleCleanup(guildId) {
    const state = this.guildAudioState.get(guildId);
    if (!state || state.cleaning) return;

    if (state.leaveTimer) {
      clearTimeout(state.leaveTimer);
    }

    state.leaveTimer = setTimeout(() => {
      const liveState = this.guildAudioState.get(guildId);
      if (!liveState || liveState.cleaning) return;

      if (liveState.current || liveState.queue.length > 0) {
        return;
      }

      this.cleanupGuildAudio(guildId);
    }, this.idleDisconnectMs);
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

  async playInput({ guildId, guild, channelId, textChannelId, input, requesterId }) {
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
      resolved.requesterId = requesterId;
      this.persistState(guildId);
      const sourceLine = resolved.sourceNote ? `\n${resolved.sourceNote}` : "";

      if (state.current) {
        state.queue.push(resolved);
        this.persistState(guildId);
        return {
          mode: "queued",
          message: `Queued #${state.queue.length}: ${resolved.title}\n${resolved.webpageUrl}${sourceLine}`,
        };
      }

      if (state.queue.length > 0) {
        state.queue.push(resolved);
        this.persistState(guildId);

        await this.playNextTrack(guildId);

        const liveState = this.guildAudioState.get(guildId);
        if (!liveState || !liveState.current) {
          throw new Error("Failed to resume recovered queue.");
        }

        if (liveState.current.videoUrl === resolved.videoUrl) {
          return {
            mode: "playing",
            message: `Now playing: ${resolved.title}\n${resolved.webpageUrl}${sourceLine}`,
            embed: this.buildNowPlayingEmbed(liveState.current, liveState),
          };
        }

        return {
          mode: "queued",
          message:
            `Resumed recovered queue with: ${liveState.current.title}\n` +
            `Added to queue: ${resolved.title}\n${resolved.webpageUrl}${sourceLine}`,
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
        embed: this.buildNowPlayingEmbed(resolved, state),
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
      const persisted = this.persistedGuildState.get(guildId);
      if (!persisted) {
        return null;
      }

      const recoveredCurrent = this.sanitizeTrack(persisted.current);
      const recoveredQueue = (persisted.queue || [])
        .map((track) => this.sanitizeTrack(track))
        .filter(Boolean);

      if (!recoveredCurrent && recoveredQueue.length === 0) {
        return null;
      }

      const upcoming = recoveredQueue.length
        ? recoveredQueue
            .slice(0, 10)
            .map((track, index) => `${index + 1}. ${track.title}`)
            .join("\n")
        : "No upcoming tracks.";

      const nowLine = recoveredCurrent
        ? `Recovered current track: ${recoveredCurrent.title}`
        : "No recovered current track.";

      return `${nowLine}\n\nRecovered queue:\n${upcoming}\n\nUse /play in a voice channel to resume playback.`;
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
    this.persistState(guildId);
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
    this.persistState(guildId);
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
    this.persistState(guildId);
    return { removedTrack };
  }

  playNext(guildId, track) {
    const state = this.guildAudioState.get(guildId);
    if (!state) {
      return { error: "Nothing is currently active. Start playback first." };
    }

    state.queue.unshift(track);
    this.persistState(guildId);
    return { position: 1, track };
  }

  move(guildId, fromIndex, toIndex) {
    const state = this.guildAudioState.get(guildId);
    if (!state || state.queue.length === 0) {
      return { error: "There are no queued tracks to move." };
    }

    if (fromIndex < 1 || fromIndex > state.queue.length) {
      return {
        error: `Invalid from index. Choose a value between 1 and ${state.queue.length}.`,
      };
    }

    if (toIndex < 1 || toIndex > state.queue.length) {
      return {
        error: `Invalid to index. Choose a value between 1 and ${state.queue.length}.`,
      };
    }

    const [track] = state.queue.splice(fromIndex - 1, 1);
    state.queue.splice(toIndex - 1, 0, track);
    this.persistState(guildId);

    return { track, fromIndex, toIndex };
  }

  swap(guildId, firstIndex, secondIndex) {
    const state = this.guildAudioState.get(guildId);
    if (!state || state.queue.length < 2) {
      return { error: "Need at least two queued tracks to swap." };
    }

    if (firstIndex < 1 || firstIndex > state.queue.length) {
      return {
        error: `Invalid first index. Choose a value between 1 and ${state.queue.length}.`,
      };
    }

    if (secondIndex < 1 || secondIndex > state.queue.length) {
      return {
        error: `Invalid second index. Choose a value between 1 and ${state.queue.length}.`,
      };
    }

    if (firstIndex === secondIndex) {
      return { error: "Choose two different indices to swap." };
    }

    const firstZero = firstIndex - 1;
    const secondZero = secondIndex - 1;
    const firstTrack = state.queue[firstZero];
    const secondTrack = state.queue[secondZero];

    state.queue[firstZero] = secondTrack;
    state.queue[secondZero] = firstTrack;
    this.persistState(guildId);

    return { firstTrack, secondTrack, firstIndex, secondIndex };
  }

  shuffle(guildId) {
    const state = this.guildAudioState.get(guildId);
    if (!state || state.queue.length < 2) {
      return { error: "Need at least two queued tracks to shuffle." };
    }

    for (let i = state.queue.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [state.queue[i], state.queue[j]] = [state.queue[j], state.queue[i]];
    }

    this.persistState(guildId);
    return { count: state.queue.length };
  }

  setLoopMode(guildId, mode) {
    const state = this.guildAudioState.get(guildId);
    if (!state) {
      return { error: "Nothing is currently active. Start playback first." };
    }

    const allowedModes = new Set(["off", "track", "queue"]);
    if (!allowedModes.has(mode)) {
      return { error: "Invalid loop mode. Use off, track, or queue." };
    }

    state.loopMode = mode;
    this.persistState(guildId);
    return { mode };
  }

  getLoopMode(guildId) {
    const state = this.guildAudioState.get(guildId);
    return state?.loopMode || "off";
  }
}

module.exports = {
  MusicManager,
};
