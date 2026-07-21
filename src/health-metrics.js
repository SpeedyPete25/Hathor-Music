class HealthMetrics {
  constructor() {
    this.startedAt = Date.now();
    this.commandStats = {
      total: 0,
      failed: 0,
      byName: new Map(),
      recentDurations: [],
    };
    this.playbackFailureCount = 0;
    this.lastPlaybackFailure = null;
    this.reconnectStats = {
      attempts: 0,
      recovered: 0,
      failed: 0,
    };
    this.runtimeErrors = {
      unhandledRejections: 0,
      uncaughtExceptions: 0,
    };
    this.queueByGuild = new Map();
  }

  pushDuration(list, value, limit = 200) {
    list.push(value);
    if (list.length > limit) {
      list.splice(0, list.length - limit);
    }
  }

  observeCommand(name, durationMs, ok) {
    this.commandStats.total += 1;
    if (!ok) {
      this.commandStats.failed += 1;
    }

    const commandName = name || "unknown";
    if (!this.commandStats.byName.has(commandName)) {
      this.commandStats.byName.set(commandName, {
        count: 0,
        failed: 0,
        totalMs: 0,
        maxMs: 0,
        recentDurations: [],
      });
    }

    const entry = this.commandStats.byName.get(commandName);
    entry.count += 1;
    if (!ok) {
      entry.failed += 1;
    }
    entry.totalMs += durationMs;
    entry.maxMs = Math.max(entry.maxMs, durationMs);
    this.pushDuration(entry.recentDurations, durationMs);
    this.pushDuration(this.commandStats.recentDurations, durationMs);
  }

  observePlaybackFailure(error, context) {
    this.playbackFailureCount += 1;
    this.lastPlaybackFailure = {
      message: error && typeof error.message === "string" ? error.message : "Unknown playback error",
      context: context || "playback",
      at: new Date().toISOString(),
    };
  }

  observeReconnectAttempt() {
    this.reconnectStats.attempts += 1;
  }

  observeReconnectRecovered() {
    this.reconnectStats.recovered += 1;
  }

  observeReconnectFailure() {
    this.reconnectStats.failed += 1;
  }

  observeUnhandledRejection() {
    this.runtimeErrors.unhandledRejections += 1;
  }

  observeUncaughtException() {
    this.runtimeErrors.uncaughtExceptions += 1;
  }

  observeQueueDuration(guildId, queueInfo) {
    if (!guildId) {
      return;
    }

    const previous = this.queueByGuild.get(guildId) || {
      currentSeconds: 0,
      maxSeconds: 0,
      trackCount: 0,
      unknownDurationCount: 0,
      updatedAt: null,
    };

    const currentSeconds = Math.max(0, queueInfo?.seconds || 0);
    this.queueByGuild.set(guildId, {
      currentSeconds,
      maxSeconds: Math.max(previous.maxSeconds, currentSeconds),
      trackCount: Math.max(0, queueInfo?.trackCount || 0),
      unknownDurationCount: Math.max(0, queueInfo?.unknownDurationCount || 0),
      updatedAt: new Date().toISOString(),
    });
  }

  summarizeDurations(values) {
    if (!Array.isArray(values) || values.length === 0) {
      return { avgMs: 0, p95Ms: 0, maxMs: 0 };
    }

    const sorted = [...values].sort((a, b) => a - b);
    const sum = sorted.reduce((acc, current) => acc + current, 0);
    const p95Index = Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95));

    return {
      avgMs: Math.round(sum / sorted.length),
      p95Ms: Math.round(sorted[p95Index]),
      maxMs: Math.round(sorted[sorted.length - 1]),
    };
  }

  formatSeconds(totalSeconds) {
    const seconds = Math.max(0, Math.floor(totalSeconds));
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const leftoverSeconds = seconds % 60;

    if (hours > 0) {
      return `${hours}:${String(minutes).padStart(2, "0")}:${String(leftoverSeconds).padStart(2, "0")}`;
    }

    return `${minutes}:${String(leftoverSeconds).padStart(2, "0")}`;
  }

  getSnapshot({ guildId } = {}) {
    const uptimeSeconds = Math.max(0, Math.floor((Date.now() - this.startedAt) / 1000));
    const globalLatency = this.summarizeDurations(this.commandStats.recentDurations);

    const commandBreakdown = Array.from(this.commandStats.byName.entries())
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, 6)
      .map(([name, info]) => {
        const latency = this.summarizeDurations(info.recentDurations);
        return {
          name,
          count: info.count,
          failed: info.failed,
          avgMs: latency.avgMs,
          p95Ms: latency.p95Ms,
          maxMs: info.maxMs,
        };
      });

    const queueGuild = guildId ? this.queueByGuild.get(guildId) : null;

    return {
      uptimeSeconds,
      command: {
        total: this.commandStats.total,
        failed: this.commandStats.failed,
        avgMs: globalLatency.avgMs,
        p95Ms: globalLatency.p95Ms,
        maxMs: globalLatency.maxMs,
        topCommands: commandBreakdown,
      },
      playbackFailureCount: this.playbackFailureCount,
      lastPlaybackFailure: this.lastPlaybackFailure,
      reconnect: {
        attempts: this.reconnectStats.attempts,
        recovered: this.reconnectStats.recovered,
        failed: this.reconnectStats.failed,
      },
      runtimeErrors: {
        unhandledRejections: this.runtimeErrors.unhandledRejections,
        uncaughtExceptions: this.runtimeErrors.uncaughtExceptions,
      },
      queue: queueGuild
        ? {
            currentDuration: this.formatSeconds(queueGuild.currentSeconds),
            peakDuration: this.formatSeconds(queueGuild.maxSeconds),
            trackCount: queueGuild.trackCount,
            unknownDurationCount: queueGuild.unknownDurationCount,
            updatedAt: queueGuild.updatedAt,
          }
        : null,
    };
  }
}

module.exports = {
  HealthMetrics,
};
