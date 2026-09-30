/// <reference types="@woofx3/module-sdk/function-ctx" />

function setState(ctx) {
  var params = readParams(ctx);
  var body = {};

  if (params.power === "on" || params.power === "off") {
    body.power = params.power;
  }
  var color = String(params.color == null ? "" : params.color).trim();
  if (color) {
    // LIFX accepts "#rrggbb", the colour field's own format.
    body.color = color;
  }
  var brightness = optionalNumber(params.brightness);
  if (brightness !== null) {
    body.brightness = Math.max(0, Math.min(100, brightness)) / 100;
  }
  if (!("power" in body) && !("color" in body) && !("brightness" in body)) {
    throw new Error("Nothing to change: pick a power, colour or brightness.");
  }
  var duration = optionalNumber(params.durationSeconds);
  if (duration !== null && duration > 0) {
    body.duration = duration;
  }

  var result = lifxRequest(ctx, selectorPath(params) + "/state", "PUT", body);
  return summarise(ctx, result, "Changed");
}

// ---- Shared with the module's other functions; keep the copies identical. ----

var LIFX_API = "https://api.lifx.com/v1";

function lifxRequest(ctx, path, method, body) {
  var token = String((ctx.module && ctx.module.settings && ctx.module.settings.apiToken) || "").trim();
  if (!token) {
    throw new Error("No LIFX token is set. Add one in the LIFX module settings.");
  }
  var opts = { headers: { "Authorization": "Bearer " + token } };
  if (body) {
    opts.body = body;
  }
  var resp = ctx.http.request(LIFX_API + path, method, opts);
  if (!resp) {
    throw new Error("LIFX did not answer.");
  }
  if (resp.status === 401) {
    throw new Error("LIFX rejected the token. Check it in the LIFX module settings.");
  }
  if (resp.status === 404) {
    throw new Error("LIFX found no lights matching that choice.");
  }
  if (resp.status === 429) {
    throw new Error("LIFX is limiting requests right now. Try again in a minute.");
  }
  if (resp.status < 200 || resp.status >= 300) {
    var detail = resp.body && (resp.body.error || (resp.body.errors && resp.body.errors[0] && resp.body.errors[0].message));
    throw new Error("LIFX returned " + resp.status + (detail ? ": " + detail : "."));
  }
  return resp.body;
}

function readParams(ctx) {
  return (ctx.event && ctx.event.parameters) || {};
}

// A blank selector means every light, which is also the field's default.
function selectorPath(params) {
  var selector = String(params.selector == null ? "" : params.selector).trim() || "all";
  return "/lights/" + encodeURIComponent(selector);
}

// A blank optional number arrives as "" or null, not 0; only a real number counts.
function optionalNumber(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  var n = Number(value);
  return isFinite(n) ? n : null;
}

// State changes and effects answer 207 with one result per light. Lights that
// are offline come back as failures there, not as an HTTP error.
function summarise(ctx, body, verb) {
  var results = (body && body.results) || [];
  var okCount = 0;
  for (var i = 0; i < results.length; i++) {
    if (results[i] && results[i].status === "ok") {
      okCount++;
    }
  }
  if (results.length > 0 && okCount === 0) {
    throw new Error("None of the lights answered. They may be offline or unplugged.");
  }
  var reply = ctx.response(true, verb + " " + okCount + " light" + (okCount === 1 ? "" : "s") + ".");
  reply.ok = true;
  reply.lightsChanged = okCount;
  return reply;
}
