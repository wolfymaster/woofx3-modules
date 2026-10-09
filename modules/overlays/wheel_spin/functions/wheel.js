/// <reference types="@woofx3/module-sdk/function-ctx" />

// Wheel Spin: a wheel of entries that anything can add to, take from and
// spin. The winner is picked here, when the spin starts, so every widget on
// every scene lands on the same slice; the widget only animates to it. Chat
// hears the result, and the `wheel_spin.landed` trigger fires, when the
// `land` deadline comes due at the moment the wheel stops on screen.
//
// The entries are the module's `items` list setting, so the streamer can add
// and remove them in the module's settings as well as through the actions
// here. Each row is {"label"}; a row with an empty label is no entry. The
// widget reads the same setting, at `setting:items`.
//
// Every change to the entries goes through ctx.module.compareAndSetSetting,
// so an action and the streamer, or two actions, changing the wheel at the
// same moment can't lose each other's change. `ctx.module.settings` is read
// once per run and never refreshed, so a retry works from the `current` the
// failed write answered with, not from the settings again.
//
// The spin lives in storage, as a JSON *string* this file serialises itself,
// because storage's compareAndSet compares the stored bytes:
//
//   spin  {"id","phase":"spinning"|"landed","labels":[string],
//          "winnerIndex","landAt","turns","durationMs",
//          "startedAt","endsAt","item","removed"}
//
// `labels` is the wheel as it was when the spin started: the widget draws the
// spin from it, so a winner taken off the wheel stays on screen until it has
// been shown, and entries added mid-spin don't reshuffle the slices under the
// pointer. `landAt` is where in the winning slice the pointer stops (0..1), so
// it doesn't always land dead centre.
//
// A spin is claimed in storage before its winner comes off the wheel: two
// spins at once can't both start, and the one that loses has taken nothing.
//
// There's no cap on how many entries the wheel holds; only each entry's
// length is limited, so a pasted paragraph can't become one slice.

var CAS_ATTEMPTS = 12;
var MAX_LABEL_LENGTH = 100;
var DEFAULT_SPIN_SECONDS = 8;
var MIN_SPIN_SECONDS = 1;
var MAX_SPIN_SECONDS = 60;
var ITEMS_SETTING = "items";
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
        return { added: 0, count: entries(readRows(ctx)).length };
    }
    var rows = updateRows(ctx, function (current) {
        return current.concat(labels.map(function (label) { return { label: label }; }));
    });
    return { added: labels.length, count: entries(rows).length };
}

/** Removes one copy of an entry, or every copy, matching without case. */
function remove_item(ctx) {
    var params = eventParams(ctx);
    var target = cleanLabel(params.item).toLowerCase();
    var all = params.all === true || params.all === "true";
    var removed = 0;
    var rows = updateRows(ctx, function (current) {
        removed = 0;
        if (target === "") {
            return null;
        }
        var next = current.filter(function (row) {
            if ((all || removed === 0) && labelOf(row).toLowerCase() === target) {
                removed++;
                return false;
            }
            return true;
        });
        return removed > 0 ? next : null;
    });
    return { removed: removed, count: entries(rows).length };
}

function clear_wheel(ctx) {
    var removed = 0;
    updateRows(ctx, function (current) {
        removed = entries(current).length;
        return current.length > 0 ? [] : null;
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
    var labels = entries(readRows(ctx));
    var spin = null;

    for (var attempt = 0; attempt < CAS_ATTEMPTS && !spin; attempt++) {
        var read = readSpin(ctx);
        if (read.spin && read.spin.phase === "spinning" && Date.now() < Number(read.spin.endsAt)) {
            return { spun: false, item: "", seconds: 0, count: labels.length, skipped: "busy" };
        }
        if (labels.length === 0) {
            return { spun: false, item: "", seconds: 0, count: 0, skipped: "empty" };
        }
        var next = newSpin(labels, durationMs, removeWinner);
        if (ctx.storage.compareAndSet("spin", read.raw, JSON.stringify(next)).swapped) {
            spin = next;
        }
    }
    if (!spin) {
        throw new Error("the wheel kept changing underneath this spin; try again.");
    }

    var count = labels.length;
    if (removeWinner) {
        count = entries(takeOff(ctx, spin.item, spin.winnerIndex)).length;
    }
    ctx.schedule.at("land", "spin", spin.endsAt, { spinId: spin.id });
    return { spun: true, item: spin.item, seconds: durationMs / 1000, count: count };
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
    for (var attempt = 0; attempt < CAS_ATTEMPTS && !landed; attempt++) {
        var read = readSpin(ctx);
        if (!read.spin || read.spin.id !== spinId || read.spin.phase !== "spinning") {
            return { landed: false };
        }
        read.spin.phase = "landed";
        if (ctx.storage.compareAndSet("spin", read.raw, JSON.stringify(read.spin)).swapped) {
            landed = read.spin;
        }
    }
    if (!landed) {
        throw new Error("the spin kept changing underneath this update; try again.");
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
        data: { item: landed.item, removed: landed.removed === true, count: entries(readRows(ctx)).length }
    }]);
}

// ---------------------------------------------------------------------------
// The entries (the `items` list setting)
// ---------------------------------------------------------------------------

function readRows(ctx) {
    return asRows(moduleSettings(ctx)[ITEMS_SETTING]);
}

// Read-modify-write the entries. `change(rows)` returns the new rows, or null
// to leave them, and may run more than once, so it resets anything it reports
// out before deciding. Returns the rows as they stand afterwards.
function updateRows(ctx, change) {
    var current = readRows(ctx);
    for (var attempt = 0; attempt < CAS_ATTEMPTS; attempt++) {
        var next = change(current.slice());
        if (!next) {
            return current;
        }
        var outcome = ctx.module.compareAndSetSetting(ITEMS_SETTING, current, next);
        if (outcome.swapped) {
            return next;
        }
        current = asRows(outcome.current);
    }
    throw new Error("the wheel kept changing underneath this update; try again.");
}

// Takes one copy of the winner off the wheel: the row it was picked from when
// the wheel hasn't changed since, else the first row with its label. Gone
// already (the streamer removed it mid-spin) is fine.
function takeOff(ctx, label, index) {
    return updateRows(ctx, function (current) {
        var at = -1;
        var seen = -1;
        for (var i = 0; i < current.length; i++) {
            if (labelOf(current[i]) === "") {
                continue;
            }
            seen++;
            if (labelOf(current[i]) === label && (at === -1 || seen === index)) {
                at = i;
            }
        }
        if (at === -1) {
            return null;
        }
        current.splice(at, 1);
        return current;
    });
}

// The labels on the wheel, in order: rows with an empty label are skipped.
function entries(rows) {
    return rows.map(labelOf).filter(function (l) { return l !== ""; });
}

function asRows(value) {
    return Array.isArray(value)
        ? value.filter(function (row) { return row && typeof row === "object" && !Array.isArray(row); })
        : [];
}

function labelOf(row) {
    return cleanLabel(row && row.label);
}

function cleanLabel(value) {
    return str(value).replace(/\s+/g, " ").trim().slice(0, MAX_LABEL_LENGTH).trim();
}

// ---------------------------------------------------------------------------
// The spin
// ---------------------------------------------------------------------------

function readSpin(ctx) {
    var raw = ctx.storage.get("spin");
    var spin = parseJson(raw);
    return {
        raw: raw === undefined ? null : raw,
        spin: spin && typeof spin === "object" ? spin : null
    };
}

function newSpin(labels, durationMs, removeWinner) {
    var now = Date.now();
    var index = Math.floor(Math.random() * labels.length);
    return {
        id: String(now) + Math.floor(Math.random() * 1e6),
        phase: "spinning",
        labels: labels,
        winnerIndex: index,
        landAt: 0.15 + Math.random() * 0.7,
        // Roughly one turn a second, so a long spin doesn't crawl.
        turns: Math.max(3, Math.round(durationMs / 1000)) + Math.floor(Math.random() * 3),
        durationMs: durationMs,
        startedAt: now,
        endsAt: now + durationMs,
        item: labels[index],
        removed: removeWinner
    };
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
