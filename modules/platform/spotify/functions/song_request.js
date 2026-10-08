/// <reference types="@woofx3/module-sdk/function-ctx" />

/** @param {import("@woofx3/module-sdk/function-ctx").Ctx} ctx */
function song_request(ctx) {
    // ChatCommandEventData (shared/common/typescript/cloudevents/Chat/commands.ts):
    //   { command, args, rawMessage, text, variables, chatter, platform }
    // `text` is rawMessage with the command token already stripped; `variables`
    // holds named argument_pattern captures (this command's pattern is
    // "{songTitle}", so variables.songTitle is the query when configured).
    // ctx.event.parameters is reserved for workflow-step-authored config
    // (e.g. deviceId below) and is never used for command-derived data.
    // Every exit point below uses ctx.response(success, message) instead of
    // ctx.chat.sendMessage — one mechanism instead of two, and it works
    // whether or not the chat extension happens to be bound.
    var data = (ctx.event && ctx.event.data) ? ctx.event.data : {};

    var variables = data.variables || {};
    var query = (variables.songTitle || data.text || "").trim();
    if (!query) {
        return ctx.response(false, "Usage: !sr <song name or Spotify URL>");
    }

    if (!ctx.oauth) {
        return ctx.response(false, "Failed to Authenticate to Spotify");
    }

    // The engine attaches the streamer's token and refreshes it, and throws
    // when it cannot (not connected yet, a refresh Spotify refused, a module
    // update that needs a reconnect). Its reason goes to the module's log for
    // the streamer, not to chat; a null response then stands for it, so every
    // call site replies the same way.
    function spotifyRequest(url, method, opts) {
        opts = opts || {};
        try {
            return ctx.oauth.request({
                integration: "spotify",
                url: url,
                method: method,
                query: opts.query
            });
        } catch (e) {
            ctx.log.warn({ label: "spotify request failed", value: String(e && e.message ? e.message : e) });
            return null;
        }
    }

    // Determine if query is a Spotify track URL or a search term.
    var urlMatch = query.match(/(?:https?:\/\/)?open\.spotify\.com\/track\/([a-zA-Z0-9]+)/);
    var song = null;

    if (urlMatch) {
        var trackId = urlMatch[1];
        var trackResp = spotifyRequest("https://api.spotify.com/v1/tracks/" + trackId, "GET", {});
        if (!trackResp || trackResp.status === 401) {
            return ctx.response(false, "Failed to Authenticate to Spotify");
        }
        if (!trackResp || trackResp.status !== 200 || !trackResp.body) {
            return ctx.response(false, "Could not find that track on Spotify.");
        }
        song = {
            name: trackResp.body.name,
            artist: trackResp.body.artists[0].name,
            uri: trackResp.body.uri
        };
    } else {
        var searchResp = spotifyRequest(
            "https://api.spotify.com/v1/search",
            "GET",
            { query: { q: query, type: "track", limit: "1" } }
        );
        if (!searchResp || searchResp.status === 401) {
            return ctx.response(false, "Failed to Authenticate to Spotify");
        }
        var tracks = searchResp && searchResp.body && searchResp.body.tracks && searchResp.body.tracks.items;
        if (!tracks || tracks.length === 0) {
            return ctx.response(false, "No results found for: " + query);
        }
        var track = tracks[0];
        song = {
            name: track.name,
            artist: track.artists[0].name,
            uri: track.uri
        };
    }

    // Add to Spotify playback queue.
    var params = (ctx.event && ctx.event.parameters) || {};
    var deviceId = (params.deviceId != null && params.deviceId !== "")
        ? params.deviceId
        : ctx.env.get("SPOTIFY_DEVICE_ID");
    var queueUrl = "https://api.spotify.com/v1/me/player/queue?uri=" + encodeURIComponent(song.uri);
    if (deviceId) { queueUrl += "&device_id=" + encodeURIComponent(deviceId); }

    var queueResp = spotifyRequest(queueUrl, "POST", {});
    if (!queueResp || queueResp.status === 401) {
        return ctx.response(false, "Failed to Authenticate to Spotify");
    }

    // 200 or 204 both indicate success.
    if (!queueResp || (queueResp.status !== 200 && queueResp.status !== 204)) {
        return ctx.response(false, "Failed to queue " + song.name + ".");
    }

    // The returned object is the workflow step's output, so the song and artist
    // ride along on the reply for later steps to read as ${stepId.song} and
    // ${stepId.artist}. Must match the action's `returns` in manifest.json.
    var reply = ctx.response(true, "Added to queue: " + song.name + " by " + song.artist);
    reply.song = song.name;
    reply.artist = song.artist;
    return reply;
}
