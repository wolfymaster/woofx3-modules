/// <reference types="@woofx3/module-sdk/function-ctx" />

// Wheel Spin: wheels of entries that anything can add to, take from and spin.
// Each wheel is a `wheel` resource instance, so a streamer can keep several
// (a giveaway wheel, a game picker) and point each widget and workflow at the
// one it means. The winner is picked here, when the spin starts, so every
// widget showing that wheel lands on the same slice; the widget only animates
// to it. Chat hears the result, and the `wheel_spin.landed` trigger fires,
// when the `land` deadline comes due at the moment the wheel stops on screen.
//
// Where a wheel lives. Its entries are the wheel's own `items` setting, a
// `list` of `{label}` rows, so the streamer types them in when making or
// editing the wheel on the dashboard, and the actions here edit the same
// list with `ctx.resources.compareAndSetSetting`. What is happening to the
// wheel is its value, at `state:<canonicalId>`, the key every resource kind
// keeps an instance's value under:
//
//   {"spin": {"id","phase":"spinning"|"landed","labels":[string],
//             "winnerIndex","landAt","turns","durationMs",
//             "startedAt","endsAt","item","removed"} | null}
//
// `spin.labels` is the wheel as it was when the spin started: the widget
// draws the spin from it, so a winner taken off the wheel stays on screen
// until it has been shown, and entries added mid-spin don't reshuffle the
// slices under the pointer. `landAt` is where in the winning slice the
// pointer stops (0..1), so it doesn't always land dead centre.
//
// Starting a spin is one compare-and-set on the value, so two spins at once
// can't both start. Taking the winner off is a second compare-and-set, on
// the entries, made before the spin is reported; the next spin can't start
// until this one has landed, so it always sees the winner gone.
//
// Wheels from 0.3 kept their entries in the value as `items`. The first
// action on such a wheel moves them onto its entries list (see `adoptItems`).
//
// Whether a winner comes off, how long a spin lasts and whether chat hears
// the result are the wheel's settings too, read through `ctx.resources.get`.
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
var ITEMS_SETTING = "items";
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
    var items = updateItems(ctx, wheel, function (current) {
        return labels.length === 0 ? null : current.concat(labels);
    });
    return { target: wheel.target, added: labels.length, count: items.length };
}

/** Removes one copy of an entry, or every copy, matching without case. */
function remove_item(ctx) {
    var wheel = loadWheel(ctx);
    var params = eventParams(ctx);
    var entry = cleanLabel(params.item).toLowerCase();
    var all = params.all === true || params.all === "true";
    var removed = 0;
    var items = updateItems(ctx, wheel, function (current) {
        removed = 0;
        if (entry === "") {
            return null;
        }
        var next = current.filter(function (label) {
            if ((all || removed === 0) && label.toLowerCase() === entry) {
                removed++;
                return false;
            }
            return true;
        });
        return removed > 0 ? next : null;
    });
    return { target: wheel.target, removed: removed, count: items.length };
}

function clear_wheel(ctx) {
    var wheel = loadWheel(ctx);
    var removed = 0;
    updateItems(ctx, wheel, function (current) {
        removed = current.length;
        return removed === 0 ? null : [];
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

    updateValue(ctx, wheel, function (v) {
        refusal = "";
        spin = null;
        if (v.spin && v.spin.phase === "spinning" && Date.now() < Number(v.spin.endsAt)) {
            refusal = "busy";
            return null;
        }
        if (wheel.items.length === 0) {
            refusal = "empty";
            return null;
        }
        var now = Date.now();
        var index = Math.floor(Math.random() * wheel.items.length);
        spin = {
            id: String(now) + Math.floor(Math.random() * 1e6),
            phase: "spinning",
            labels: wheel.items.slice(),
            winnerIndex: index,
            landAt: 0.15 + Math.random() * 0.7,
            // Roughly one turn a second, so a long spin doesn't crawl.
            turns: Math.max(3, Math.round(durationMs / 1000)) + Math.floor(Math.random() * 3),
            durationMs: durationMs,
            startedAt: now,
            endsAt: now + durationMs,
            item: wheel.items[index],
            removed: removeWinner
        };
        v.spin = spin;
        return v;
    });

    if (refusal) {
        return { target: wheel.target, spun: false, item: "", seconds: 0, count: wheel.items.length, skipped: refusal };
    }
    // Keyed by the wheel, so deleting the wheel cancels a landing still to come.
    ctx.schedule.at(DEADLINE_LAND, wheel.target, spin.endsAt, { target: wheel.target, spinId: spin.id });

    var count = wheel.items.length;
    if (removeWinner) {
        // One copy of the winner, wherever it sits now: the streamer may have
        // edited the list since it was read. Already gone is fine.
        var winner = spin.item;
        count = updateItems(ctx, wheel, function (current) {
            var at = current.indexOf(winner);
            if (at < 0) {
                return null;
            }
            var next = current.slice();
            next.splice(at, 1);
            return next;
        }).length;
    }
    return { target: wheel.target, spun: true, item: spin.item, seconds: durationMs / 1000, count: count };
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
    updateValue(ctx, wheel, function (v) {
        landed = null;
        if (!v.spin || v.spin.id !== spinId || v.spin.phase !== "spinning") {
            return null;
        }
        v.spin.phase = "landed";
        landed = v.spin;
        return v;
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
        data: { target: target, item: landed.item, removed: landed.removed === true, count: wheel.items.length }
    }]);
}

// ---------------------------------------------------------------------------
// The wheel
// ---------------------------------------------------------------------------

// The chosen wheel, its settings and entries. Refuses a target that is not a
// wheel, since writing a wheel over another kind's value would corrupt it
// silently.
function loadWheel(ctx) {
    var target = str(eventParams(ctx).target);
    if (target === "") {
        throw new Error("wheel spin: no wheel chosen");
    }
    var instance = ctx.resources.get(target);
    if (!instance) {
        throw new Error("wheel spin: " + target + " does not exist; it may have been deleted");
    }
    var wheel = wheelFromInstance(target, instance);
    adoptItems(ctx, wheel);
    return wheel;
}

// `items` is the entries as labels, and `rawItems` the setting exactly as
// read, which is what compareAndSetSetting expects to still find.
function wheelFromInstance(target, instance) {
    if (instance.kind !== "wheel") {
        throw new Error("wheel spin: " + target + " is a " + instance.kind + ", not a wheel");
    }
    var settings = instance.settings || {};
    var raw = settings[ITEMS_SETTING];
    return {
        target: target,
        key: "state:" + target,
        settings: settings,
        rawItems: raw === undefined ? null : raw,
        items: labelsFrom(raw)
    };
}

// Moves entries a 0.3 wheel kept in its value onto its entries list. The
// run whose write drops them from the value is the one that appends them,
// so several runs touching the wheel at once can't each add a copy.
function adoptItems(ctx, wheel) {
    var claimed = [];
    updateValue(ctx, wheel, function (v, stored) {
        claimed = [];
        if (!stored || !Array.isArray(stored.items)) {
            return null;
        }
        claimed = stored.items.map(cleanLabel).filter(function (l) { return l !== ""; });
        return v;
    });
    if (claimed.length > 0) {
        updateItems(ctx, wheel, function (current) {
            return current.concat(claimed);
        });
    }
}

// Read-modify-write the entries. `change(labels)` returns the new labels, or
// null to leave them. Returns the labels as they stand afterwards, and keeps
// `wheel` up to date with them. `change` may run more than once, so it
// resets anything it reports out before deciding.
function updateItems(ctx, wheel, change) {
    if (typeof ctx.resources.compareAndSetSetting !== "function") {
        throw new Error("wheel spin: this engine can't change a wheel's entries; update WoofX3 to use this version of Wheel Spin");
    }
    for (var attempt = 0; attempt < CAS_ATTEMPTS; attempt++) {
        var next = change(wheel.items.slice());
        if (!next) {
            return wheel.items;
        }
        var rows = next.map(function (label) { return { label: label }; });
        var written = ctx.resources.compareAndSetSetting(wheel.target, ITEMS_SETTING, wheel.rawItems, rows);
        if (written.swapped) {
            wheel.rawItems = rows;
            wheel.items = next;
            return next;
        }
        wheel.rawItems = written.current === undefined ? null : written.current;
        wheel.items = labelsFrom(wheel.rawItems);
    }
    throw new Error("wheel spin: " + wheel.target + " kept changing underneath this update; try again.");
}

// The entries as labels, from `{label}` rows. Text is read as JSON first, in
// case an engine hands the list over as it is stored.
function labelsFrom(raw) {
    var rows = raw;
    if (typeof rows === "string") {
        try {
            rows = JSON.parse(rows);
        } catch (_) {
            return [];
        }
    }
    if (!Array.isArray(rows)) {
        return [];
    }
    return rows
        .map(function (row) {
            return cleanLabel(row && typeof row === "object" ? row.label : row);
        })
        .filter(function (label) { return label !== ""; });
}

function readValue(ctx, wheel) {
    var stored = ctx.storage.get(wheel.key);
    return { stored: stored === undefined ? null : stored, value: normalise(stored) };
}

// A copy, never the stored value itself: changes edit what this returns in
// place, and the stored value is what compareAndSet expects to still find.
// Only `spin` is kept, so a write also drops a 0.3 wheel's `items`.
function normalise(stored) {
    var value = stored && typeof stored === "object" ? JSON.parse(JSON.stringify(stored)) : {};
    return { spin: value.spin && typeof value.spin === "object" ? value.spin : null };
}

// Read-modify-write the value. `change(value, stored)` returns the new value,
// or null to leave it; `stored` is what was read, not to be changed. Returns the value as it stands afterwards. `change` may run
// more than once, so it resets anything it reports out before deciding.
function updateValue(ctx, wheel, change) {
    var read = readValue(ctx, wheel);
    for (var attempt = 0; attempt < CAS_ATTEMPTS; attempt++) {
        var next = change(read.value, read.stored);
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
