/// <reference types="@woofx3/module-sdk/function-ctx" />

// Throne's signing key. Throne publishes it as an Ed25519 PEM (SPKI);
// ctx.crypto takes the raw 32-byte key, which is the PEM's last 32 bytes.
// https://help.throne.com/en/articles/15935990-how-do-i-set-up-webhook-integration
var THRONE_PUBLIC_KEY_HEX = "3d76d47f187b5cbe1261455c7e19983086f1bed47d13d2c377c80f2753f0483f";

// Throne sets no window. Five minutes absorbs clock skew while still
// bounding how long a captured request can be replayed.
var MAX_TIMESTAMP_SKEW_SECONDS = 300;

/** @param {import("@woofx3/module-sdk/function-ctx").Ctx} ctx */
function handle_throne_webhook(ctx) {
    /** @type {import("@woofx3/module-sdk/function-ctx").WebhookRequest} */
    var req = ctx.event.data;

    if (req.method !== "POST") {
        return { status: 405 };
    }
    if (!isSignedByThrone(ctx, req)) {
        return { status: 401 };
    }

    var envelope = req.body;
    if (!envelope || typeof envelope !== "object" || !envelope.data || typeof envelope.data !== "object") {
        return { status: 400, body: { error: "expected a Throne event envelope" } };
    }
    if (envelope.contract_version !== "1") {
        return { status: 400, body: { error: "unsupported contract_version" } };
    }

    var event = toEvent(envelope);
    // Acknowledge event types newer than this module, so Throne doesn't
    // keep retrying them.
    if (!event) {
        return { status: 200 };
    }

    /** @type {import("@woofx3/module-sdk/function-ctx").WebhookHandlerResult} */
    var result = { status: 200, events: [event] };
    return result;
}

// Throne signs `${timestamp}.${rawBody}`, so the timestamp is covered by the
// signature and checking its age is enough to refuse replays.
function isSignedByThrone(ctx, req) {
    var timestamp = req.headers["x-signature-timestamp"] || "";
    var signature = req.headers["x-signature-ed25519"] || "";
    if (!/^\d+$/.test(timestamp) || !/^[0-9a-fA-F]{128}$/.test(signature)) {
        return false;
    }
    if (Math.abs(Date.now() / 1000 - Number(timestamp)) > MAX_TIMESTAMP_SKEW_SECONDS) {
        return false;
    }
    return ctx.crypto.verifyEd25519(THRONE_PUBLIC_KEY_HEX, signature, timestamp + "." + req.rawBody, "hex");
}

function toEvent(envelope) {
    var data = envelope.data;
    var common = {
        eventId: String(envelope.event_id || ""),
        creatorUsername: String(data.creator_username || ""),
        itemName: String(data.item_name || ""),
        itemThumbnailUrl: String(data.item_thumbnail_url || ""),
        currency: String(data.currency || ""),
    };

    switch (envelope.event_type) {
        case "gift_purchased": {
            return {
                type: "throne.gift.purchased",
                data: Object.assign(common, {
                    gifterUsername: String(data.gifter_username || ""),
                    message: String(data.message || ""),
                    price: Number(data.price) || 0,
                    priceDisplay: displayAmount(data.price),
                    isSurpriseGift: data.is_surprise_gift === true,
                }),
            };
        }
        case "contribution_purchased": {
            return {
                type: "throne.contribution.purchased",
                data: Object.assign(common, {
                    gifterUsername: String(data.gifter_username || ""),
                    message: String(data.message || ""),
                    amount: Number(data.amount) || 0,
                    amountDisplay: displayAmount(data.amount),
                }),
            };
        }
        case "gift_crowdfunded": {
            return {
                type: "throne.gift.crowdfunded",
                data: Object.assign(common, {
                    price: Number(data.price) || 0,
                    priceDisplay: displayAmount(data.price),
                    isSurpriseGift: data.is_surprise_gift === true,
                }),
            };
        }
        default: {
            return null;
        }
    }
}

// Throne sends amounts in hundredths of the currency unit: 1099 is 10.99.
function displayAmount(hundredths) {
    return ((Number(hundredths) || 0) / 100).toFixed(2);
}
