/// <reference types="@woofx3/module-sdk/function-ctx" />

// Wheel Spin: a wheel of entries that anything can add to, take from and
// spin. The winner is picked here, when the spin starts, so every widget on
// every scene lands on the same slice; the widget only animates to it. Chat
// hears the result, and the `wheel_spin.landed` trigger fires, when the
// `land` deadline comes due at the moment the wheel stops on screen.
//
// Storage layout. One key, a JSON *string* this file serialises itself,
// because compareAndSet compares the stored bytes: handing back the exact
// string that was read is what makes the comparison reliable.
//
//   wheel  {"items":[string],
//           "spin": {"id","phase":"spinning"|"landed","labels":[string],
//                    "winnerIndex","landAt","turns","durationMs",
//                    "startedAt","endsAt","item","removed"} | null}
//
// `spin.labels` is the wheel as it was when the spin started: the widget
// draws the spin from it, so a winner taken off the wheel stays on screen
// until it has been shown, and entries added mid-spin don't reshuffle the
// slices under the pointer. `landAt` is where in the winning slice the
// pointer stops (0..1), so it doesn't always land dead centre.
//
// Items and the current spin share a key so that picking a winner, taking
// it off the wheel and starting the spin are one compare-and-set: two spins
// at once can't both start, nor both take the same entry.
//
// There's no cap on how many entries the wheel holds; only each entry's
// length is limited, so a pasted paragraph can't become one slice.
//
// The wheel is kept across streams, so nothing here is clearOnSessionEnd.

var CAS_ATTEMPTS = 12;
var MAX_LABEL_LENGTH = 100;
var DEFAULT_SPIN_SECONDS = 8;
var MIN_SPIN_SECONDS = 1;
var MAX_SPIN_SECONDS = 60;
var EVENT_LANDED = "wheel_spin.landed";

// ---------------------------------------------------------------------------
// Action entry points (for workflows, buttons and stream decks)
// ---------------------------------------------------------------------------

/** Adds one entry, or one per line. Duplicates are allowed: more chances. */
function add_item(ctx) {
    var labels = str(eventParams(ctx).item)
        .split(/\r?\n/)
        .map(cleanLabel)
        .filter(function (l) { return l !== ""; });
    if (labels.length === 0) {
        return { added: 0, count: readWheel(ctx).wheel.items.length };
    }
    var wheel = updateWheel(ctx, function (w) {
        w.items = w.items.concat(labels);
        return w;
    });
    return { added: labels.length, count: wheel.items.length };
}

/** Removes one copy of an entry, or every copy, matching without case. */
function remove_item(ctx) {
    var params = eventParams(ctx);
    var target = cleanLabel(params.item).toLowerCase();
    var all = params.all === true || params.all === "true";
    var removed = 0;
    var wheel = updateWheel(ctx, function (w) {
        removed = 0;
        if (target === "") {
            return null;
        }
        w.items = w.items.filter(function (label) {
            if ((all || removed === 0) && label.toLowerCase() === target) {
                removed++;
                return false;
            }
            return true;
        });
        return removed > 0 ? w : null;
    });
    return { removed: removed, count: wheel.items.length };
}

function clear_wheel(ctx) {
    var removed = 0;
    updateWheel(ctx, function (w) {
        removed = w.items.length;
        if (removed === 0) {
            return null;
        }
        w.items = [];
        return w;
    });
    return { removed: removed };
}

/**
 * Picks a winner and starts the spin. A wheel still spinning is left alone
 * rather than restarted, so a double-pressed button doesn't change the
 * winner mid-spin.
 */
function spin_wheel(ctx) {
    var durationMs = spinSeconds(ctx) * 1000;
    var removeWinner = toggle(ctx, "removeWhenPicked", false);
    var refusal = "";
    var spin = null;

    var wheel = updateWheel(ctx, function (w) {
        refusal = "";
        spin = null;
        if (w.spin && w.spin.phase === "spinning" && Date.now() < Number(w.spin.endsAt)) {
            refusal = "busy";
            return null;
        }
        if (w.items.length === 0) {
            refusal = "empty";
            return null;
        }
        var now = Date.now();
        var index = Math.floor(Math.random() * w.items.length);
        spin = {
            id: String(now) + Math.floor(Math.random() * 1e6),
            phase: "spinning",
            labels: w.items.slice(),
            winnerIndex: index,
            landAt: 0.15 + Math.random() * 0.7,
            // Roughly one turn a second, so a long spin doesn't crawl.
            turns: Math.max(3, Math.round(durationMs / 1000)) + Math.floor(Math.random() * 3),
            durationMs: durationMs,
            startedAt: now,
            endsAt: now + durationMs,
            item: w.items[index],
            removed: removeWinner
        };
        if (removeWinner) {
            w.items.splice(index, 1);
        }
        w.spin = spin;
        return w;
    });

    if (refusal) {
        return { spun: false, item: "", seconds: 0, count: wheel.items.length, skipped: refusal };
    }
    ctx.schedule.at("land", "spin", spin.endsAt, { spinId: spin.id });
    return { spun: true, item: spin.item, seconds: durationMs / 1000, count: wheel.items.length };
}

// ---------------------------------------------------------------------------
// Deadline (the wheel has stopped on screen)
// ---------------------------------------------------------------------------

/**
 * Marks the spin landed, tells chat and fires the trigger. A deadline can
 * fire late or twice, so it only acts on the spin it was armed for, once.
 */
function land_wheel(ctx) {
    var spinId = str(eventParams(ctx).spinId);
    var landed = null;
    var wheel = updateWheel(ctx, function (w) {
        landed = null;
        if (!w.spin || w.spin.id !== spinId || w.spin.phase !== "spinning") {
            return null;
        }
        w.spin.phase = "landed";
        landed = w.spin;
        return w;
    });
    if (!landed) {
        return { landed: false };
    }

    // A chat that can't be reached mustn't stop the trigger firing: that's
    // what the streamer's own workflows wait on.
    if (toggle(ctx, "announce", true)) {
        try {
            say(ctx, "The wheel landed on " + landed.item + "!");
        } catch (err) {
            ctx.log.warn("wheel spin: couldn't announce the winner in chat: " + str(err && err.message ? err.message : err));
        }
    }
    return ctx.result({ landed: true, item: landed.item }, [{
        type: EVENT_LANDED,
        data: { item: landed.item, removed: landed.removed === true, count: wheel.items.length }
    }]);
}

// ---------------------------------------------------------------------------
// The wheel
// ---------------------------------------------------------------------------

function readWheel(ctx) {
    var raw = ctx.storage.get("wheel");
    var wheel = parseJson(raw);
    if (!wheel || typeof wheel !== "object") {
        wheel = {};
    }
    wheel.items = Array.isArray(wheel.items) ? wheel.items.map(str) : [];
    wheel.spin = wheel.spin && typeof wheel.spin === "object" ? wheel.spin : null;
    return { raw: raw === undefined ? null : raw, wheel: wheel };
}

// Read-modify-write the wheel. `change(wheel)` returns the new wheel, or null
// to leave it. Returns the wheel as it stands afterwards. `change` may run
// more than once, so it resets anything it reports out before deciding.
function updateWheel(ctx, change) {
    for (var attempt = 0; attempt < CAS_ATTEMPTS; attempt++) {
        var read = readWheel(ctx);
        var next = change(read.wheel);
        if (!next) {
            return read.wheel;
        }
        if (ctx.storage.compareAndSet("wheel", read.raw, JSON.stringify(next)).swapped) {
            return next;
        }
    }
    throw new Error("the wheel kept changing underneath this update; try again.");
}

function cleanLabel(value) {
    return str(value).replace(/\s+/g, " ").trim().slice(0, MAX_LABEL_LENGTH).trim();
}

// ---------------------------------------------------------------------------
// Plumbing
// ---------------------------------------------------------------------------

// The spin's `seconds` parameter, else the module setting, within bounds.
function spinSeconds(ctx) {
    var n = Number(eventParams(ctx).seconds);
    if (!Number.isFinite(n) || n <= 0) {
        n = Number(moduleSettings(ctx).spinSeconds);
    }
    if (!Number.isFinite(n) || n <= 0) {
        n = DEFAULT_SPIN_SECONDS;
    }
    return Math.min(MAX_SPIN_SECONDS, Math.max(MIN_SPIN_SECONDS, n));
}

function eventParams(ctx) {
    return (ctx.event && ctx.event.parameters) || {};
}

function moduleSettings(ctx) {
    return (ctx.module && ctx.module.settings) || {};
}

function toggle(ctx, id, fallback) {
    var v = moduleSettings(ctx)[id];
    if (v === undefined || v === null || v === "") {
        return fallback;
    }
    return v === true || v === "true";
}

function say(ctx, text) {
    if (!ctx.chat || typeof ctx.chat.sendMessage !== "function") {
        throw new Error("ctx.chat.sendMessage is not available on this engine.");
    }
    ctx.chat.sendMessage(text);
}

function parseJson(raw) {
    if (raw === undefined || raw === null) {
        return null;
    }
    if (typeof raw !== "string") {
        return raw;
    }
    try {
        return JSON.parse(raw);
    } catch (_) {
        return null;
    }
}

function str(value) {
    return value === undefined || value === null ? "" : String(value);
}
