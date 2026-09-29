/// <reference types="@woofx3/module-sdk/function-ctx" />

// Workflow action: asks the AI and hands back the reply for later steps as
// ${stepId.reply}. It posts nothing itself, so the streamer decides where the
// text goes.
function ask(ctx) {
  var params = (ctx.event && ctx.event.parameters) || {};
  var prompt = String(params.prompt == null ? "" : params.prompt).trim();
  if (!prompt) {
    throw new Error("Tell the AI what to write: the prompt is empty.");
  }
  var cfg = readConfig(ctx);
  var reply = askModel(ctx, cfg, prompt, cfg.maxChars);

  var result = ctx.response(true, reply);
  result.reply = reply;
  return result;
}

// ---- Shared with the module's other functions; keep the copies identical. ----

var DEFAULT_MODELS = { anthropic: "claude-sonnet-5-5", openai: "gpt-4.1-mini" };

// ctx.http has no timeout, so a long generation holds the invocation for as
// long as the provider takes. A chat reply never needs more than this.
var MAX_OUTPUT_TOKENS = 200;

// Twitch rejects chat messages over 500 characters.
var CHAT_LIMIT = 500;

function readConfig(ctx) {
  var s = (ctx.module && ctx.module.settings) || {};
  var provider = String(s.provider || "anthropic").trim().toLowerCase();
  if (provider !== "anthropic" && provider !== "openai") {
    throw new Error("AI service must be \"anthropic\" or \"openai\", not \"" + provider + "\".");
  }
  var apiKey = String(s.apiKey || "").trim();
  if (!apiKey) {
    throw new Error("No API key is set. Add one in the AI Chat module settings.");
  }
  var maxChars = Math.floor(Number(s.maxReplyChars) || 400);
  return {
    provider: provider,
    apiKey: apiKey,
    model: String(s.model || "").trim() || DEFAULT_MODELS[provider],
    personality: String(s.personality || "").trim(),
    maxChars: Math.max(50, Math.min(CHAT_LIMIT, maxChars)),
    cooldownSeconds: Math.max(0, Number(s.cooldownSeconds) || 0),
    answerMentions: s.answerMentions === true || s.answerMentions === "true",
    botName: String(s.botName || "").trim().replace(/^@/, ""),
  };
}

// Asks the model and returns its reply as one tidy line of at most maxChars.
// Throws with the provider's reason on any failure.
function askModel(ctx, cfg, prompt, maxChars) {
  var system = (cfg.personality ? cfg.personality + "\n\n" : "") +
    "Your reply is posted in live stream chat. Answer in plain text on one line, " +
    "with no markdown, in at most " + maxChars + " characters.";
  var text = cfg.provider === "anthropic"
    ? askAnthropic(ctx, cfg, system, prompt)
    : askOpenAI(ctx, cfg, system, prompt);
  var tidy = tidyReply(text, maxChars);
  if (!tidy) {
    throw new Error("The AI sent back an empty reply.");
  }
  return tidy;
}

function askAnthropic(ctx, cfg, system, prompt) {
  var resp = ctx.http.request("https://api.anthropic.com/v1/messages", "POST", {
    headers: {
      "x-api-key": cfg.apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: {
      model: cfg.model,
      max_tokens: MAX_OUTPUT_TOKENS,
      system: system,
      messages: [{ role: "user", content: prompt }],
    },
  });
  var body = checkResponse(resp, "Anthropic");
  var parts = (body && body.content) || [];
  var out = "";
  for (var i = 0; i < parts.length; i++) {
    if (parts[i] && parts[i].type === "text") {
      out += parts[i].text;
    }
  }
  return out;
}

function askOpenAI(ctx, cfg, system, prompt) {
  var resp = ctx.http.request("https://api.openai.com/v1/chat/completions", "POST", {
    headers: {
      "Authorization": "Bearer " + cfg.apiKey,
      "content-type": "application/json",
    },
    body: {
      model: cfg.model,
      max_completion_tokens: MAX_OUTPUT_TOKENS,
      messages: [
        { role: "system", content: system },
        { role: "user", content: prompt },
      ],
    },
  });
  var body = checkResponse(resp, "OpenAI");
  var choice = body && body.choices && body.choices[0];
  return (choice && choice.message && choice.message.content) || "";
}

function checkResponse(resp, service) {
  if (!resp) {
    throw new Error(service + " did not answer.");
  }
  if (resp.status < 200 || resp.status >= 300) {
    var detail = resp.body && resp.body.error && resp.body.error.message;
    if (resp.status === 401) {
      throw new Error(service + " rejected the API key.");
    }
    throw new Error(service + " returned " + resp.status + (detail ? ": " + detail : "."));
  }
  if (!resp.body || typeof resp.body !== "object") {
    throw new Error(service + " sent a reply that isn't JSON.");
  }
  return resp.body;
}

// Chat shows one line, so newlines and markdown emphasis go. An over-long
// reply is cut at the last sentence or word that fits, never mid-word.
function tidyReply(text, maxChars) {
  var s = String(text || "").replace(/[*_`#]+/g, "").replace(/\s+/g, " ").trim();
  if (s.length <= maxChars) {
    return s;
  }
  var cut = s.slice(0, maxChars - 1);
  var sentence = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "));
  if (sentence >= maxChars / 2) {
    return cut.slice(0, sentence + 1);
  }
  var space = cut.lastIndexOf(" ");
  return (space > 0 ? cut.slice(0, space) : cut) + "…";
}

// True, and starts the viewer's cooldown, when they may ask now. Keyed by
// lower-cased name because chat commands carry only the chatter's name.
function takeCooldown(ctx, cfg, chatter) {
  if (cfg.cooldownSeconds <= 0 || !chatter) {
    return true;
  }
  var key = "cooldown:" + chatter.toLowerCase();
  var now = Date.now();
  var last = Number(ctx.storage.get(key)) || 0;
  if (now - last < cfg.cooldownSeconds * 1000) {
    return false;
  }
  ctx.storage.set(key, String(now));
  return true;
}

// Posts the answer tagged to the viewer, fitted inside chat's limit.
function answerInChat(ctx, cfg, chatter, question) {
  var tag = chatter ? "@" + chatter + " " : "";
  var reply = askModel(ctx, cfg, question, Math.min(cfg.maxChars, CHAT_LIMIT - tag.length));
  ctx.chat.sendMessage(tag + reply);
  return reply;
}
