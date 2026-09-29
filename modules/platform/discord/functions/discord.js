/// <reference types="@woofx3/module-sdk/function-ctx" />

// Posts to a Discord channel through an incoming webhook the streamer creates
// in their server's settings. The webhook URL is the only credential: it
// carries its own token, so it is kept as a secret setting.

// Discord's own limits; a message over any of them is refused outright, so
// long workflow-substituted text is trimmed rather than failing the step.
var MAX_CONTENT = 2000;
var MAX_EMBED_TITLE = 256;
var MAX_EMBED_DESCRIPTION = 4096;

var TWITCH_PURPLE = 0x9146ff;
var OFFLINE_GREY = 0x4a5160;

var DEFAULT_GO_LIVE_MESSAGE = "{channel} is live on Twitch! Come hang out: {link}";
var DEFAULT_OFFLINE_MESSAGE = "{channel} just wrapped up the stream. Thanks to everyone who came by!";

/** @param {import("@woofx3/module-sdk/function-ctx").Ctx} ctx */
function postMessage(ctx) {
  var params = readParams(ctx);
  var embed = null;
  var title = str(params.embedTitle);
  var description = str(params.embedDescription);
  if (title || description) {
    embed = {
      title: title,
      description: description,
      url: str(params.embedUrl),
      color: parseColor(params.embedColor),
    };
  }
  return send(ctx, str(params.message), embed, str(params.ping));
}

// Runs from the bundled go-live workflow. Workflow parameters are fixed when
// the module is installed, so the wording comes from settings, which the
// streamer can change afterwards; the step only passes the channel name.
/** @param {import("@woofx3/module-sdk/function-ctx").Ctx} ctx */
function announceGoLive(ctx) {
  var settings = ctx.module.settings || {};
  if (!isOn(settings.announceGoLive)) {
    return skipped(ctx, "Go-live announcements are turned off.");
  }
  var vars = streamVars(ctx, settings);
  var text = fill(str(settings.goLiveMessage) || DEFAULT_GO_LIVE_MESSAGE, vars);
  var embed = {
    title: vars.channel + " is live!",
    description: "Click to join the stream.",
    url: vars.link,
    color: TWITCH_PURPLE,
  };
  return send(ctx, text, embed, isOn(settings.pingEveryoneOnGoLive) ? "everyone" : "");
}

/** @param {import("@woofx3/module-sdk/function-ctx").Ctx} ctx */
function announceOffline(ctx) {
  var settings = ctx.module.settings || {};
  if (!isOn(settings.announceOffline)) {
    return skipped(ctx, "End-of-stream posts are turned off.");
  }
  var vars = streamVars(ctx, settings);
  var text = fill(str(settings.offlineMessage) || DEFAULT_OFFLINE_MESSAGE, vars);
  var embed = {
    title: vars.channel + " is offline",
    description: "Catch the next one!",
    url: vars.link,
    color: OFFLINE_GREY,
  };
  return send(ctx, text, embed, "");
}

function send(ctx, content, embed, ping) {
  var url = webhookUrl(ctx);

  var prefix = "";
  if (ping === "everyone") {
    prefix = "@everyone ";
  } else if (ping === "here") {
    prefix = "@here ";
  }
  content = truncate(prefix + content, MAX_CONTENT);

  var payload = {
    content: content,
    // Mentions are opt-in: `parse: []` stops text that came from chat or a
    // stream title from pinging anyone, and "everyone" (which also covers
    // @here) is granted only when this step asked for a ping.
    allowed_mentions: { parse: ping === "everyone" || ping === "here" ? ["everyone"] : [] },
  };
  if (embed) {
    payload.embeds = [cleanEmbed(embed)];
  }
  if (!payload.content && !payload.embeds) {
    throw new Error("Nothing to post: give the message some text or an embed.");
  }

  var resp = ctx.http.request(url + "?wait=true", "POST", { body: payload });
  if (!resp) {
    throw new Error("Discord did not answer.");
  }
  if (resp.status === 429) {
    var retry = resp.body && resp.body.retry_after;
    throw new Error("Discord is rate limiting this webhook" +
      (retry ? "; try again in " + retry + " seconds." : "."));
  }
  if (resp.status === 401 || resp.status === 404) {
    throw new Error("Discord does not recognise this webhook. It may have been deleted; paste a new webhook URL into the module settings.");
  }
  if (resp.status < 200 || resp.status >= 300) {
    throw new Error("Discord refused the message (HTTP " + resp.status + ")" + discordReason(resp.body) + ".");
  }

  var reply = ctx.response(true, "Posted to Discord.");
  reply.ok = true;
  reply.messageId = resp.body && resp.body.id ? String(resp.body.id) : "";
  return reply;
}

function webhookUrl(ctx) {
  var raw = str((ctx.module.settings || {}).webhookUrl);
  if (!raw) {
    throw new Error("No Discord webhook URL set. Add one in the module settings.");
  }
  // A pasted URL sometimes carries ?wait or ?thread_id; only the bare
  // endpoint is accepted, so the one query this module adds can't clash.
  var m = raw.match(/^https:\/\/(?:(?:ptb|canary)\.)?discord(?:app)?\.com\/api\/(?:v\d+\/)?webhooks\/\d+\/[A-Za-z0-9_-]+\/?$/);
  if (!m) {
    throw new Error("The Discord webhook URL doesn't look right. It should start with https://discord.com/api/webhooks/.");
  }
  return raw.replace(/\/$/, "");
}

function cleanEmbed(embed) {
  var out = {};
  if (embed.title) { out.title = truncate(embed.title, MAX_EMBED_TITLE); }
  if (embed.description) { out.description = truncate(embed.description, MAX_EMBED_DESCRIPTION); }
  // Discord rejects the whole message over a malformed embed URL.
  if (embed.url && /^https?:\/\//.test(embed.url)) { out.url = embed.url; }
  if (typeof embed.color === "number") { out.color = embed.color; }
  return out;
}

// stream.online and stream.offline carry the broadcaster's display name.
// Twitch channel URLs are case-insensitive, but a display name in a
// non-Latin script differs from the login, so channelUrl can override.
function streamVars(ctx, settings) {
  var params = readParams(ctx);
  var data = (ctx.event && ctx.event.data) || {};
  var channel = str(params.channel) || str(data.broadcasterUserName) || "The stream";
  var link = str(settings.channelUrl);
  if (!link && channel !== "The stream") {
    link = "https://twitch.tv/" + channel.toLowerCase();
  }
  return { channel: channel, link: link };
}

function fill(template, vars) {
  return template.replace(/\{(channel|link)\}/g, function (_, key) {
    return vars[key] || "";
  });
}

function parseColor(value) {
  var m = str(value).match(/^#?([0-9a-fA-F]{6})$/);
  return m ? parseInt(m[1], 16) : undefined;
}

function discordReason(body) {
  if (body && typeof body === "object" && body.message) {
    return ": " + body.message;
  }
  return "";
}

function skipped(ctx, message) {
  var reply = ctx.response(true, message);
  reply.ok = true;
  reply.skipped = true;
  return reply;
}

function readParams(ctx) {
  return (ctx.event && ctx.event.parameters) || {};
}

function isOn(value) {
  return value === true || value === "true";
}

function str(value) {
  return value == null ? "" : String(value).trim();
}

function truncate(text, max) {
  return text.length > max ? text.slice(0, max - 1) + "…" : text;
}
