/// <reference types="@woofx3/module-sdk/function-ctx" />

// Runs on every chat message, so it does the least it can: one
// compare-and-set, retried only when another message raced it.
var CHAT_LINES_KEY = "chatLines";
var MAX_ATTEMPTS = 5;

/** @param {import("@woofx3/module-sdk/function-ctx").Ctx} ctx */
function count_chat_line(ctx) {
    var current = ctx.storage.get(CHAT_LINES_KEY);
    for (var attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        // An absent key is expected as null, which is how compareAndSet
        // spells "only if nothing is stored yet".
        var expected = typeof current === "number" ? current : null;
        var next = (expected || 0) + 1;
        var outcome = ctx.storage.compareAndSet(CHAT_LINES_KEY, expected, next);
        if (outcome.swapped) {
            return { chatLines: next };
        }
        current = outcome.current;
    }
    // Losing five races in a row means chat is very busy; one uncounted line
    // doesn't change whether the next timer is due.
    return { chatLines: typeof current === "number" ? current : 0, skipped: true };
}
