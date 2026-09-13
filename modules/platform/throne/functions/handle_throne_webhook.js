/// <reference types="@woofx3/module-sdk/function-ctx" />

// TODO(throne): the signature header, the signing scheme and the payload
// shape below are placeholders, not Throne's documented contract. Replace
// SIGNATURE_HEADER, the hmac call and the field reads with what Throne sends.
var SIGNATURE_HEADER = "x-throne-signature";

/** @param {import("@woofx3/module-sdk/function-ctx").Ctx} ctx */
function handle_throne_webhook(ctx) {
    /** @type {import("@woofx3/module-sdk/function-ctx").WebhookRequest} */
    var req = ctx.event.data;

    // Fail closed: without a secret, anyone who learns the URL could fire
    // the trigger. 503 tells Throne to retry once the streamer sets it.
    var secret = ctx.module.settings.webhookSecret;
    if (!secret) {
        return { status: 503, body: { error: "webhook secret is not configured" } };
    }

    // Sign rawBody, never a re-serialized body: key order and whitespace
    // would change the digest.
    var expected = ctx.crypto.hmac("sha256", secret, req.rawBody, "hex");
    var received = req.headers[SIGNATURE_HEADER] || "";
    if (!ctx.crypto.timingSafeEqual(expected, received)) {
        return { status: 401 };
    }

    var payload = req.body;
    if (!payload || typeof payload !== "object") {
        return { status: 400, body: { error: "expected a JSON body" } };
    }

    // Acknowledge event kinds this module doesn't handle, so Throne doesn't
    // keep retrying them.
    if (payload.type !== "item.purchased") {
        return { status: 200 };
    }

    var item = payload.item || {};
    var gifter = payload.gifter || {};
    var isAnonymous = !gifter.username;

    /** @type {import("@woofx3/module-sdk/function-ctx").WebhookHandlerResult} */
    var result = {
        status: 200,
        events: [
            {
                type: "throne.item.purchased",
                data: {
                    itemName: String(item.name || ""),
                    itemPrice: Number(item.price) || 0,
                    currency: String(item.currency || ""),
                    gifterName: isAnonymous ? "" : String(gifter.username),
                    isAnonymous: isAnonymous,
                    message: String(payload.message || ""),
                },
            },
        ],
    };
    return result;
}
