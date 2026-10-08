/// <reference types="@woofx3/module-sdk/function-ctx" />

/** @param {import("@woofx3/module-sdk/function-ctx").Ctx} ctx */
function get_devices(ctx) {
    // This feeds a dropdown, so any failure (not connected yet, Spotify
    // unreachable) falls back to the single "Current Device" option; the
    // engine's reason goes to the module's log.
    var fallback = [{ value: "", label: "Current Device" }];
    if (!ctx.oauth) {
        return fallback;
    }

    var devicesResp;
    try {
        devicesResp = ctx.oauth.request({
            integration: "spotify",
            url: "https://api.spotify.com/v1/me/player/devices"
        });
    } catch (e) {
        ctx.log.warn({ label: "spotify request failed", value: String(e && e.message ? e.message : e) });
        return fallback;
    }

    if (!devicesResp || devicesResp.status !== 200 || !devicesResp.body) {
        return fallback;
    }

    var devices = devicesResp.body.devices;
    if (!devices || devices.length === 0) {
        return fallback;
    }

    var options = [{ value: "", label: "Current Device" }];
    for (var i = 0; i < devices.length; i++) {
        var d = devices[i];
        if (!d.id) { continue; }
        options.push({ value: d.id, label: d.name });
    }

    return options;
}
