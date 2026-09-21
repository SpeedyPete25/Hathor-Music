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
}

module.exports = { SpotifyClient };
