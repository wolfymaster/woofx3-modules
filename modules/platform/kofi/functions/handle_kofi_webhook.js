/// <reference types="@woofx3/module-sdk/function-ctx" />

// Ko-fi posts application/x-www-form-urlencoded with a single `data` field
// holding the event as a JSON string, so the relay hands us no parsed body and
// the event has to be dug out of rawBody. Ko-fi signs nothing: authenticity is
// the `verification_token` inside that JSON, which the streamer copies from
// Ko-fi's webhook settings into this module's settings.
// https://ko-fi.com/manage/webhooks

/** @param {import("@woofx3/module-sdk/function-ctx").Ctx} ctx */
function handle_kofi_webhook(ctx) {
    /** @type {import("@woofx3/module-sdk/function-ctx").WebhookRequest} */
    var req = ctx.event.data;

    if (req.method !== "POST") {
        return { status: 405 };
    }

    var payload = readPayload(req);
    if (!payload) {
        return { status: 400, body: { error: "expected a form field `data` holding Ko-fi's JSON" } };
    }
    if (!isFromKofi(ctx, payload)) {
        return { status: 401 };
    }

    var event = toEvent(payload);
    // Acknowledge types newer than this module, so Ko-fi doesn't keep
    // retrying them.
    if (!event) {
        return { status: 200 };
    }

    /** @type {import("@woofx3/module-sdk/function-ctx").WebhookHandlerResult} */
    var result = { status: 200, events: [event] };
    return result;
}

function readPayload(req) {
    // Should the relay ever parse the form itself, take what it parsed.
    if (req.body && typeof req.body === "object" && typeof req.body.data === "string") {
        return parseJson(req.body.data);
    }
    var raw = formField(req.rawBody || "", "data");
    return raw === null ? null : parseJson(raw);
}

function formField(form, name) {
    var pairs = form.split("&");
    for (var i = 0; i < pairs.length; i++) {
        var eq = pairs[i].indexOf("=");
        var key = eq < 0 ? pairs[i] : pairs[i].slice(0, eq);
        if (decodeForm(key) === name) {
            return eq < 0 ? "" : decodeForm(pairs[i].slice(eq + 1));
        }
    }
    return null;
}

function decodeForm(s) {
    try {
        return decodeURIComponent(s.replace(/\+/g, " "));
    } catch (_) {
        return "";
    }
}

function parseJson(s) {
    try {
        var v = JSON.parse(s);
        return v && typeof v === "object" ? v : null;
    } catch (_) {
        return null;
    }
}

// An unset token refuses everything: accepting unauthenticated requests
// until the streamer gets round to pasting it would let anyone fake a tip.
function isFromKofi(ctx, payload) {
    var expected = String(ctx.module.settings.verificationToken || "");
    var given = String(payload.verification_token || "");
    if (expected === "" || given === "") {
        return false;
    }
    return ctx.crypto.timingSafeEqual(expected, given);
}

function toEvent(p) {
    // A private supporter asked not to be named or quoted on stream.
    var isPublic = p.is_public !== false;
    var common = {
        messageId: String(p.message_id || ""),
        transactionId: String(p.kofi_transaction_id || ""),
        timestamp: String(p.timestamp || ""),
        isPublic: isPublic,
        fromName: isPublic ? String(p.from_name || "") : "Anonymous",
        message: isPublic ? String(p.message || "") : "",
        amount: toNumber(p.amount),
        amountDisplay: toNumber(p.amount).toFixed(2),
        currency: String(p.currency || ""),
        url: String(p.url || ""),
    };

    switch (p.type) {
        case "Donation": {
            return { type: "kofi.donation", data: common };
        }
        case "Subscription": {
            return {
                type: "kofi.subscription",
                data: Object.assign(common, {
                    tierName: String(p.tier_name || ""),
                    isFirstPayment: p.is_first_subscription_payment === true,
                }),
            };
        }
        case "Shop Order": {
            var items = Array.isArray(p.shop_items) ? p.shop_items : [];
            var count = 0;
            for (var i = 0; i < items.length; i++) {
                count += Number(items[i] && items[i].quantity) || 1;
            }
            return {
                type: "kofi.shop_order",
                data: Object.assign(common, { itemCount: count }),
            };
        }
        case "Commission": {
            return { type: "kofi.commission", data: common };
        }
        default: {
            return null;
        }
    }
}

// Ko-fi sends amounts as decimal strings, such as "3.00".
function toNumber(v) {
    var n = parseFloat(v);
    return isFinite(n) ? n : 0;
}
