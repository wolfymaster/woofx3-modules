/// <reference types="@woofx3/module-sdk/function-ctx" />

function setBrightness(ctx) {
  var target = readDevice(ctx);
  var n = Number(target.params.brightness);
  if (!isFinite(n) || target.params.brightness === "" || target.params.brightness == null) {
    throw new Error("Brightness must be a number from 1 to 100.");
  }
  var level = Math.max(1, Math.min(100, Math.round(n)));
  return control(ctx, target, "devices.capabilities.range", "brightness", level,
    "Set the light to " + level + "% brightness.");
}

// ---- Shared with the module's other functions; keep the copies identical. ----

var GOVEE_API = "https://openapi.api.govee.com/router/api/v1";

function goveeRequest(ctx, path, method, body) {
  var key = String((ctx.module && ctx.module.settings && ctx.module.settings.apiKey) || "").trim();
  if (!key) {
    throw new Error("No Govee API key is set. Add one in the Govee module settings.");
  }
  var opts = { headers: { "Govee-API-Key": key } };
  if (body) {
    opts.body = body;
  }
  var resp = ctx.http.request(GOVEE_API + path, method, opts);
  if (!resp) {
    throw new Error("Govee did not answer.");
  }
  if (resp.status === 401 || resp.status === 403) {
    throw new Error("Govee rejected the API key. Check it in the Govee module settings.");
  }
  if (resp.status === 429) {
    throw new Error("Govee is limiting requests right now. Try again in a minute.");
  }
  var b = resp.body;
  // Govee also reports failures inside a 200, through the body's code.
  if (resp.status < 200 || resp.status >= 300 || (b && typeof b === "object" && b.code !== undefined && Number(b.code) !== 200)) {
    var detail = b && (b.msg || b.message);
    throw new Error("Govee returned " + ((b && b.code) || resp.status) + (detail ? ": " + detail : "."));
  }
  return b;
}

// The picker's value packs the model (sku) and device id, since every control
// call needs both: "H605C|64:09:C5:32:37:36:2D:13". Device ids hold colons,
// never pipes.
function readDevice(ctx) {
  var params = (ctx.event && ctx.event.parameters) || {};
  var raw = String(params.device == null ? "" : params.device);
  var bar = raw.indexOf("|");
  if (bar <= 0 || bar === raw.length - 1) {
    throw new Error("Pick a Govee light.");
  }
  return { sku: raw.slice(0, bar), device: raw.slice(bar + 1), params: params };
}

function control(ctx, target, type, instance, value, message) {
  goveeRequest(ctx, "/device/control", "POST", {
    requestId: "woofx3-" + Date.now() + "-" + Math.floor(Math.random() * 1e9),
    payload: {
      sku: target.sku,
      device: target.device,
      capability: { type: type, instance: instance, value: value },
    },
  });
  var reply = ctx.response(true, message);
  reply.ok = true;
  return reply;
}
