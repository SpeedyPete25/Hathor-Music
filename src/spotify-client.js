// Matches both open.spotify.com URLs (with an optional locale segment like
// /intl-en/) and spotify:track:<id> URI form.
function parseSpotifyLink(input) {
  const trimmed = input.trim();

  const uriMatch = trimmed.match(/^spotify:(track|playlist|album):([a-zA-Z0-9]+)$/);
  if (uriMatch) {
    return { type: uriMatch[1], id: uriMatch[2] };
  }

  if (!/^https?:\/\//i.test(trimmed)) {
    return null;
  }

  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }

  const host = parsed.hostname.replace(/^www\./, "").toLowerCase();
  if (host !== "open.spotify.com") {
    return null;
  }

  const pathMatch = parsed.pathname.match(
    /\/(?:intl-[a-z]{2}\/)?(track|playlist|album)\/([a-zA-Z0-9]+)/i
  );
  if (!pathMatch) {
    return null;
  }

  return { type: pathMatch[1].toLowerCase(), id: pathMatch[2] };
}

function pickArtistNames(artists) {
  return Array.isArray(artists) ? artists.map((artist) => artist?.name).filter(Boolean) : [];
}

function trackToInfo(track) {
  const artists = pickArtistNames(track.artists);
  return {
    title: track.name,
    artists,
    searchQuery: artists.length ? `${artists.join(", ")} - ${track.name}` : track.name,
    spotifyUrl: track.external_urls?.spotify || null,
  };
}

class SpotifyClient {
  constructor({ clientId, clientSecret }) {
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.accessToken = null;
    this.expiresAt = 0;
  }

  isConfigured() {
    return Boolean(this.clientId && this.clientSecret);
  }

  async getAccessToken() {
    if (!this.isConfigured()) {
      throw new Error(
        "Spotify integration is not configured. Set SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET."
      );
    }

    const now = Date.now();
    if (this.accessToken && now < this.expiresAt) {
      return this.accessToken;
    }

    const basicAuth = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString("base64");

    const response = await fetch("https://accounts.spotify.com/api/token", {
      method: "POST",
      headers: {
        Authorization: `Basic ${basicAuth}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "grant_type=client_credentials",
    });

    if (!response.ok) {
      throw new Error(`Spotify token request failed (${response.status}).`);
    }

    const data = await response.json();

    // Refresh a little before actual expiry so a token already in flight
    // never lapses mid-request.
    this.accessToken = data.access_token;
    this.expiresAt = now + (data.expires_in - 60) * 1000;

    return this.accessToken;
  }

  async apiRequest(path) {
    const token = await this.getAccessToken();
    const response = await fetch(`https://api.spotify.com/v1${path}`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!response.ok) {
      throw new Error(`Spotify API request failed (${response.status}): ${path}`);
    }

    return response.json();
  }

  async getTrackInfo(id) {
    const track = await this.apiRequest(`/tracks/${id}`);
    return { ...trackToInfo(track), sourceNote: null };
  }

  async getPlaylistFirstTrackInfo(id) {
    // Only the first track is queued, matching how /play already handles a
    // YouTube playlist link (resolvePlayableInput requests playlistItems=1).
    // Full playlist expansion is a separate feature, not this one.
    const playlist = await this.apiRequest(
      `/playlists/${id}?fields=name,tracks.items(track(name,artists,external_urls,type))`
    );

    const firstItem = (playlist.tracks?.items || []).find(
      (item) => item?.track && item.track.type === "track"
    );

    if (!firstItem) {
      throw new Error("No playable track found in that Spotify playlist.");
    }

    return {
      ...trackToInfo(firstItem.track),
      sourceNote: `From Spotify playlist: ${playlist.name}`,
    };
  }

  async getAlbumFirstTrackInfo(id) {
    const album = await this.apiRequest(
      `/albums/${id}?fields=name,tracks.items(name,artists,external_urls,type)`
    );

    const firstTrack = (album.tracks?.items || []).find((track) => track?.type === "track");

    if (!firstTrack) {
      throw new Error("No playable track found in that Spotify album.");
    }

    return {
      ...trackToInfo(firstTrack),
      sourceNote: `From Spotify album: ${album.name}`,
    };
  }

  // Parses a Spotify track/playlist/album link and resolves it down to a
  // single playable track's metadata. Returns null for non-Spotify input so
  // callers can fall through to their existing handling unchanged.
  async resolveLink(input) {
    const parsed = parseSpotifyLink(input);
    if (!parsed) {
      return null;
    }

    if (parsed.type === "track") {
      return this.getTrackInfo(parsed.id);
    }

    if (parsed.type === "playlist") {
      return this.getPlaylistFirstTrackInfo(parsed.id);
    }

    return this.getAlbumFirstTrackInfo(parsed.id);
  }
}

module.exports = { SpotifyClient, parseSpotifyLink };
