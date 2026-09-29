/// <reference types="@woofx3/module-sdk/function-ctx" />

// Fourthwall signs each delivery with X-Fourthwall-Hmac-SHA256: the base64
// HMAC-SHA256 of the raw body, keyed with the shop's webhook secret.
// https://docs.fourthwall.com/webhooks/signature-verification/
// Payload shapes follow https://docs.fourthwall.com/openapi/platform.json.

/** @param {import("@woofx3/module-sdk/function-ctx").Ctx} ctx */
function handle_fourthwall_webhook(ctx) {
    /** @type {import("@woofx3/module-sdk/function-ctx").WebhookRequest} */
    var req = ctx.event.data;

    if (req.method !== "POST") {
        return { status: 405 };
    }
    if (!isSignedByFourthwall(ctx, req)) {
        return { status: 401 };
    }

    var envelope = req.body;
    if (!envelope || typeof envelope !== "object" || !envelope.data || typeof envelope.data !== "object") {
        return { status: 400, body: { error: "expected a Fourthwall event envelope" } };
    }

    var event = toEvent(envelope);
    // Acknowledge the many event types this module doesn't surface (product
    // edits, abandoned carts, promotions), so Fourthwall doesn't retry them.
    if (!event) {
        return { status: 200 };
    }

    /** @type {import("@woofx3/module-sdk/function-ctx").WebhookHandlerResult} */
    var result = { status: 200, events: [event] };
    return result;
}

// An unset secret refuses everything rather than trusting unsigned requests.
function isSignedByFourthwall(ctx, req) {
    var secret = String(ctx.module.settings.webhookSecret || "");
    var signature = String(req.headers["x-fourthwall-hmac-sha256"] || "");
    if (secret === "" || signature === "") {
        return false;
    }
    var expected = ctx.crypto.hmac("sha256", secret, req.rawBody, "base64");
    return ctx.crypto.timingSafeEqual(expected, signature);
}

function toEvent(envelope) {
    var data = envelope.data;
    var common = {
        eventId: String(envelope.id || ""),
        isTest: envelope.testMode === true,
    };

    switch (envelope.type) {
        case "DONATION": {
            return {
                type: "fourthwall.donation",
                data: Object.assign(common, buyer(data), money(data.amounts && data.amounts.total)),
            };
        }
        case "ORDER_PLACED": {
            var offers = Array.isArray(data.offers) ? data.offers : [];
            var count = 0;
            var names = [];
            for (var i = 0; i < offers.length; i++) {
                var offer = offers[i] || {};
                count += Number(offer.quantity) || 1;
                if (offer.name) {
                    names.push(String(offer.name));
                }
            }
            return {
                type: "fourthwall.order.placed",
                data: Object.assign(common, buyer(data), money(data.amounts && data.amounts.total), {
                    itemCount: count,
                    itemNames: names.join(", "),
                }),
            };
        }
        case "GIFT_PURCHASE": {
            return {
                type: "fourthwall.gift.purchased",
                data: Object.assign(common, buyer(data), money(data.amounts && data.amounts.total), {
                    quantity: Number(data.quantity) || 0,
                    itemName: String((data.offer && data.offer.name) || ""),
                }),
            };
        }
        case "SUBSCRIPTION_PURCHASED": {
            var variant = (data.subscription && data.subscription.variant) || {};
            return {
                type: "fourthwall.subscription.purchased",
                data: Object.assign(common, money(variant.amount), {
                    username: String(data.nickname || ""),
                    interval: String(variant.interval || ""),
                }),
            };
        }
        default: {
            return null;
        }
    }
}

// Never the buyer's email: events land on the bus and in overlays.
function buyer(data) {
    return {
        username: String(data.username || ""),
        message: String(data.message || ""),
    };
}

// Fourthwall money is { value, currency } in the currency's main unit.
function money(m) {
    var amount = Number(m && m.value) || 0;
    return {
        amount: amount,
        amountDisplay: amount.toFixed(2),
        currency: String((m && m.currency) || ""),
    };
}
