/// <reference types="@woofx3/module-sdk/function-ctx" />

// Wheel Spin: wheels of entries that anything can add to, take from and spin.
// Each wheel is a `wheel` resource instance, so a streamer can keep several
// (a giveaway wheel, a game picker) and point each widget and workflow at the
// one it means. The winner is picked here, when the spin starts, so every
// widget showing that wheel lands on the same slice; the widget only animates
// to it. Chat hears the result, and the `wheel_spin.landed` trigger fires,
// when the `land` deadline comes due at the moment the wheel stops on screen.
//
// Storage layout. One key per wheel, `state:<canonicalId>`: the key every
// resource kind keeps an instance's value under, and the one the dashboard
// and widgets read.
//
//   {"items":[string],
//    "spin": {"id","phase":"spinning"|"landed","labels":[string],
//             "winnerIndex","landAt","turns","durationMs",
//             "startedAt","endsAt","item","removed"} | null}
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
// Whether a winner comes off, how long a spin lasts and whether chat hears
// the result are the wheel's own settings, read back through
// `ctx.resources.get`.
//
// There's no cap on how many entries a wheel holds; only each entry's
// length is limited, so a pasted paragraph can't become one slice.
//
// A wheel is kept across streams, so nothing here is clearOnSessionEnd.

var CAS_ATTEMPTS = 12;
var MAX_LABEL_LENGTH = 100;
var DEFAULT_SPIN_SECONDS = 8;
var MIN_SPIN_SECONDS = 1;
var MAX_SPIN_SECONDS = 60;
var EVENT_LANDED = "wheel_spin.landed";
var DEADLINE_LAND = "land";

// ---------------------------------------------------------------------------
// Action entry points (for workflows, buttons and stream decks)
// ---------------------------------------------------------------------------

/** Adds one entry, or one per line. Duplicates are allowed: more chances. */
function add_item(ctx) {
    var wheel = loadWheel(ctx);
    var labels = str(eventParams(ctx).item)
        .split(/\r?\n/)
        .map(cleanLabel)
        .filter(function (l) { return l !== ""; });
    if (labels.length === 0) {
        return { target: wheel.target, added: 0, count: readWheel(ctx, wheel).value.items.length };
    }
    var value = updateWheel(ctx, wheel, function (w) {
        w.items = w.items.concat(labels);
        return w;
    });
    return { target: wheel.target, added: labels.length, count: value.items.length };
}

/** Removes one copy of an entry, or every copy, matching without case. */
function remove_item(ctx) {
    var wheel = loadWheel(ctx);
    var params = eventParams(ctx);
    var entry = cleanLabel(params.item).toLowerCase();
    var all = params.all === true || params.all === "true";
    var removed = 0;
    var value = updateWheel(ctx, wheel, function (w) {
        removed = 0;
        if (entry === "") {
            return null;
        }
        w.items = w.items.filter(function (label) {
            if ((all || removed === 0) && label.toLowerCase() === entry) {
                removed++;
                return false;
            }
            return true;
        });
        return removed > 0 ? w : null;
    });
    return { target: wheel.target, removed: removed, count: value.items.length };
}

function clear_wheel(ctx) {
    var wheel = loadWheel(ctx);
    var removed = 0;
    updateWheel(ctx, wheel, function (w) {
        removed = w.items.length;
        if (removed === 0) {
            return null;
        }
        w.items = [];
        return w;
    });
    return { target: wheel.target, removed: removed };
}

/**
 * Picks a winner and starts the spin. A wheel still spinning is left alone
 * rather than restarted, so a double-pressed button doesn't change the
 * winner mid-spin.
 */
function spin_wheel(ctx) {
    var wheel = loadWheel(ctx);
    var durationMs = spinSeconds(ctx, wheel) * 1000;
    var removeWinner = toggle(wheel.settings.removeWhenPicked, false);
    var refusal = "";
    var spin = null;

    var value = updateWheel(ctx, wheel, function (w) {
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
        return { target: wheel.target, spun: false, item: "", seconds: 0, count: value.items.length, skipped: refusal };
    }
    // Keyed by the wheel, so deleting the wheel cancels a landing still to come.
    ctx.schedule.at(DEADLINE_LAND, wheel.target, spin.endsAt, { target: wheel.target, spinId: spin.id });
    return { target: wheel.target, spun: true, item: spin.item, seconds: durationMs / 1000, count: value.items.length };
}

// ---------------------------------------------------------------------------
// Deadline (the wheel has stopped on screen)
// ---------------------------------------------------------------------------

/**
 * Marks the spin landed, tells chat and fires the trigger. A deadline can
 * fire late or twice, so it only acts on the spin it was armed for, once.
 */
function land_wheel(ctx) {
    var params = eventParams(ctx);
    var target = str(params.target);
    var spinId = str(params.spinId);
    var instance = target === "" ? null : ctx.resources.get(target);
    if (!instance) {
        return { landed: false };
    }
    var wheel = wheelFromInstance(target, instance);
    var landed = null;
    var value = updateWheel(ctx, wheel, function (w) {
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
    if (toggle(wheel.settings.announce, true)) {
        try {
            say(ctx, "The wheel landed on " + landed.item + "!");
        } catch (err) {
            ctx.log.warn("wheel spin: couldn't announce the winner of " + target + " in chat: " + str(err && err.message ? err.message : err));
        }
    }
    return ctx.result({ target: target, landed: true, item: landed.item }, [{
        type: EVENT_LANDED,
        data: { target: target, item: landed.item, removed: landed.removed === true, count: value.items.length }
    }]);
}

// ---------------------------------------------------------------------------
// The wheel
// ---------------------------------------------------------------------------

// The chosen wheel and its settings. Refuses a target that is not a wheel,
// since writing a wheel over another kind's value would corrupt it silently.
function loadWheel(ctx) {
    var target = str(eventParams(ctx).target);
    if (target === "") {
        throw new Error("wheel spin: no wheel chosen");
    }
    var instance = ctx.resources.get(target);
    if (!instance) {
        throw new Error("wheel spin: " + target + " does not exist; it may have been deleted");
    }
    return wheelFromInstance(target, instance);
}

function wheelFromInstance(target, instance) {
    if (instance.kind !== "wheel") {
        throw new Error("wheel spin: " + target + " is a " + instance.kind + ", not a wheel");
    }
    return { target: target, key: "state:" + target, settings: instance.settings || {} };
}

function readWheel(ctx, wheel) {
    var stored = ctx.storage.get(wheel.key);
    return { stored: stored === undefined ? null : stored, value: normalise(stored) };
}

// A copy, never the stored value itself: changes edit what this returns in
// place, and the stored value is what compareAndSet expects to still find.
function normalise(stored) {
    var value = stored && typeof stored === "object" ? JSON.parse(JSON.stringify(stored)) : {};
    return {
        items: Array.isArray(value.items) ? value.items.map(str) : [],
        spin: value.spin && typeof value.spin === "object" ? value.spin : null
    };
}

// Read-modify-write the wheel. `change(value)` returns the new value, or null
// to leave it. Returns the value as it stands afterwards. `change` may run
// more than once, so it resets anything it reports out before deciding.
function updateWheel(ctx, wheel, change) {
    var read = readWheel(ctx, wheel);
    for (var attempt = 0; attempt < CAS_ATTEMPTS; attempt++) {
        var next = change(read.value);
        if (!next) {
            return read.value;
        }
        var written = ctx.storage.compareAndSet(wheel.key, read.stored, next);
        if (written.swapped) {
            return next;
        }
        var current = written.current === undefined ? null : written.current;
        read = { stored: current, value: normalise(current) };
    }
    throw new Error("wheel spin: " + wheel.target + " kept changing underneath this update; try again.");
}

function cleanLabel(value) {
    return str(value).replace(/\s+/g, " ").trim().slice(0, MAX_LABEL_LENGTH).trim();
}

// ---------------------------------------------------------------------------
// Plumbing
// ---------------------------------------------------------------------------

// The spin's `seconds` parameter, else the wheel's setting, within bounds.
function spinSeconds(ctx, wheel) {
    var n = Number(eventParams(ctx).seconds);
    if (!Number.isFinite(n) || n <= 0) {
        n = Number(wheel.settings.spinSeconds);
    }
    if (!Number.isFinite(n) || n <= 0) {
        n = DEFAULT_SPIN_SECONDS;
    }
    return Math.min(MAX_SPIN_SECONDS, Math.max(MIN_SPIN_SECONDS, n));
}

function eventParams(ctx) {
    return (ctx.event && ctx.event.parameters) || {};
}

function toggle(value, fallback) {
    if (value === undefined || value === null || value === "") {
        return fallback;
    }
    return value === true || value === "true";
}

function say(ctx, text) {
    if (!ctx.chat || typeof ctx.chat.sendMessage !== "function") {
        throw new Error("ctx.chat.sendMessage is not available on this engine.");
    }
    ctx.chat.sendMessage(text);
}

function str(value) {
    return value === undefined || value === null ? "" : String(value);
}
