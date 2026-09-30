/// <reference types="@woofx3/module-sdk/function-ctx" />

// Buy Me a Coffee signs each delivery with x-signature-sha256: the hex
// HMAC-SHA256 of the raw body, keyed with the webhook's signing secret. Payload
// shapes follow BMC's published OpenAPI spec:
// https://cdn.buymeacoffee.com/assets/integrations/bmc-webhooks-openapi.json

/** @param {import("@woofx3/module-sdk/function-ctx").Ctx} ctx */
function handle_bmc_webhook(ctx) {
    /** @type {import("@woofx3/module-sdk/function-ctx").WebhookRequest} */
    var req = ctx.event.data;

    if (req.method !== "POST") {
        return { status: 405 };
    }
    if (!isSignedByBmc(ctx, req)) {
        return { status: 401 };
    }

    var envelope = req.body;
    if (!envelope || typeof envelope !== "object" || !envelope.data || typeof envelope.data !== "object") {
        return { status: 400, body: { error: "expected a Buy Me a Coffee event envelope" } };
    }

    var event = toEvent(envelope);
    // Acknowledge event types this module doesn't surface (refunds, shop
    // extras, wishlist payments), so BMC doesn't keep retrying them.
    if (!event) {
        return { status: 200 };
    }

    /** @type {import("@woofx3/module-sdk/function-ctx").WebhookHandlerResult} */
    var result = { status: 200, events: [event] };
    return result;
}

// An unset secret refuses everything rather than trusting unsigned requests.
function isSignedByBmc(ctx, req) {
    var secret = String(ctx.module.settings.signingSecret || "");
    var signature = String(req.headers["x-signature-sha256"] || "").toLowerCase();
    if (secret === "" || !/^[0-9a-f]{64}$/.test(signature)) {
        return false;
    }
    var expected = ctx.crypto.hmac("sha256", secret, req.rawBody, "hex");
    return ctx.crypto.timingSafeEqual(expected, signature);
}

function toEvent(envelope) {
    var data = envelope.data;
    var common = {
        eventId: String(envelope.event_id == null ? "" : envelope.event_id),
        supporterName: String(data.supporter_name || ""),
        isTest: envelope.live_mode === false,
    };

    switch (envelope.type) {
        case "donation.created": {
            return {
                type: "buymeacoffee.donation",
                data: Object.assign(common, money(data), {
                    message: note(data),
                    coffeeCount: Number(data.coffee_count) || 0,
                }),
            };
        }
        case "membership.started": {
            return {
                type: "buymeacoffee.membership.started",
                data: Object.assign(common, money(data), {
                    message: note(data),
                    levelName: String(data.membership_level_name || ""),
                    interval: String(data.duration_type || ""),
                }),
            };
        }
        case "membership.cancelled": {
            return {
                type: "buymeacoffee.membership.cancelled",
                data: Object.assign(common, {
                    levelName: String(data.membership_level_name || ""),
                }),
            };
        }
        default: {
            return null;
        }
    }
}

function money(data) {
    var amount = Number(data.amount) || 0;
    return {
        amount: amount,
        amountDisplay: amount.toFixed(2),
        currency: String(data.currency || ""),
    };
}

// The supporter can hide their note from the public. BMC sends note_hidden
// as the string "true" on payments and as a boolean on memberships.
function note(data) {
    if (data.note_hidden === true || data.note_hidden === "true") {
        return "";
    }
    return String(data.support_note || "");
}
