/// <reference types="@woofx3/module-sdk/function-ctx" />

/** @param {import("@woofx3/module-sdk/function-ctx").Ctx} ctx */
function poll_current_track(ctx) {
    if (!ctx.oauth) {
        return { error: "this engine cannot connect Spotify" };
    }

    var playerResp;
    try {
        // The engine attaches the streamer's token and refreshes it; it throws
        // until Spotify is connected from the module's settings.
        playerResp = ctx.oauth.request({
            integration: "spotify",
            url: "https://api.spotify.com/v1/me/player/currently-playing"
        });
    } catch (e) {
        return { error: "Failed to Authenticate to Spotify" };
    }
    if (playerResp && playerResp.status === 401) {
        return { error: "Failed to Authenticate to Spotify" };
    }

    if (!playerResp) {
        return { error: "no response from player API" };
    }

    // 204 means nothing is currently playing.
    if (playerResp.status === 204) {
        ctx.storage.set("current_track", null);
        return null;
    }

    if (playerResp.status !== 200 || !playerResp.body) {
        return { error: "player API error", status: playerResp.status };
    }

    var item = playerResp.body.item;
    if (!item) {
        ctx.storage.set("current_track", null);
        return null;
    }

    var artist = (item.artists && item.artists.length > 0) ? item.artists[0].name : null;
    var albumArt = (item.album && item.album.images && item.album.images.length > 0)
        ? item.album.images[0].url
        : null;

    var track = {
        title: item.name || null,
        artist: artist,
        albumArt: albumArt,
        progressMs: (playerResp.body.progress_ms !== null && playerResp.body.progress_ms !== undefined)
            ? playerResp.body.progress_ms
            : null,
        durationMs: item.duration_ms || 0,
        isPlaying: playerResp.body.is_playing || false
    };

    ctx.storage.set("current_track", JSON.stringify(track));

    return track;
}
