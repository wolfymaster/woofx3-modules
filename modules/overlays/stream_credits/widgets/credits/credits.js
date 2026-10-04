// Stream Credits widget.
//
// Reads three keys from this module's storage, each written by the module's
// functions (functions/credits.js) as a JSON array string:
//
//   supporters  [{"name","bits","gifts"}]
//   raiders     [{"name","viewers"}]
//   chatters    [{"name"}]
//
// Shows one list at a time on a loop: fade in, scroll if it's taller than the
// widget, hold, fade out, next. Empty lists are skipped. A list is built from
// the latest data each time it comes round, so new names join on the next pass
// rather than jolting the list on screen.

/// <reference types="@woofx3/module-sdk" />

(function () {
  "use strict";

  /** @type {import("@woofx3/module-sdk").WidgetHost} */
  var host = window.widgetHost;
  if (!host) {
    document.body.textContent = "no widgetHost — open this widget through the SDK preview harness or streamware";
    return;
  }

  var FADE_MS = 900;
  // Time to read the top of a long list before it starts to move, and the end
  // of it before it fades.
  var SCROLL_PAUSE_MS = 1500;
  // The names' fade-ins are staggered across at most this long, however many
  // there are, so a long chatter list doesn't take a minute to appear.
  var STAGGER_TOTAL_MS = 1600;
  var STAGGER_STEP_MS = 90;
  // How often to look again when every list is empty.
  var IDLE_RETRY_MS = 3000;

  var SECTIONS = [
    { id: "supports", key: "supporters", show: "showSupports", title: "supportsTitle", defaultTitle: "Supports" },
    { id: "raids", key: "raiders", show: "showRaids", title: "raidsTitle", defaultTitle: "Raids" },
    { id: "chatters", key: "chatters", show: "showChatters", title: "chattersTitle", defaultTitle: "Chatters" }
  ];

  var settings = host.settings || {};
  var data = { supporters: [], raiders: [], chatters: [] };
  var slidesEl = document.getElementById("slides");
  var current = -1;
  var timer = null;

  applySettings();

  SECTIONS.forEach(function (s) {
    host.storage.subscribe(s.key, function (raw) {
      var list = parse(raw);
      data[s.key] = Array.isArray(list) ? list : [];
      // Nothing on screen means the loop is idling for data: wake it now.
      if (!slidesEl.firstChild) {
        schedule(0);
      }
    });
  });

  schedule(0);

  // -------------------------------------------------------------------------
  // Setup
  // -------------------------------------------------------------------------

  function applySettings() {
    var root = document.documentElement.style;
    root.setProperty("--fade-ms", FADE_MS + "ms");
    if (text(settings.accent)) {
      root.setProperty("--accent", text(settings.accent));
    }
    if (text(settings.textColor)) {
      root.setProperty("--text", text(settings.textColor));
    }
    document.body.classList.toggle("panel", toggle(settings.showPanel, true));

    var headline = document.getElementById("headline");
    headline.textContent = text(settings.headline);
    headline.hidden = headline.textContent === "";

    var scale = Number(settings.scale);
    if (Number.isFinite(scale) && scale > 0 && scale !== 100) {
      document.getElementById("stage").style.zoom = String(scale / 100);
    }
  }

  // -------------------------------------------------------------------------
  // The loop
  // -------------------------------------------------------------------------

  function schedule(ms) {
    if (timer !== null) {
      clearTimeout(timer);
    }
    timer = setTimeout(function () {
      timer = null;
      showNext();
    }, ms);
  }

  // The next enabled list after the current one that has anyone in it.
  function showNext() {
    for (var step = 1; step <= SECTIONS.length; step++) {
      var i = (current + step) % SECTIONS.length;
      var section = SECTIONS[i];
      if (enabled(section) && items(section).length > 0) {
        current = i;
        play(section);
        return;
      }
    }
    schedule(IDLE_RETRY_MS);
  }

  function play(section) {
    var slide = buildSlide(section);
    slidesEl.replaceChildren(slide);

    // Reading layout commits the starting styles, so adding .in transitions.
    void slide.offsetWidth;
    slide.classList.add("in");

    var count = slide.querySelectorAll(".credit").length;
    var entrance = FADE_MS + stagger(count) * Math.max(0, count - 1) + 600;
    var viewport = slide.querySelector(".viewport");
    var list = slide.querySelector(".list");
    // offsetHeight, not scrollHeight: the names' entrance offset would count
    // as overflow and scroll a list that fits.
    var distance = list.offsetHeight - viewport.clientHeight;

    var hold = seconds(settings.secondsPerList, 8) * 1000;
    if (distance > 1) {
      viewport.classList.add("scrolls");
      // The padding .scrolls adds changes the height: measure again.
      distance = list.offsetHeight - viewport.clientHeight;
      var startAt = entrance + SCROLL_PAUSE_MS;
      var scrollMs = (distance / speed()) * 1000;
      list.animate(
        [{ transform: "translateY(0)" }, { transform: "translateY(" + -distance + "px)" }],
        { duration: scrollMs, delay: startAt, easing: "linear", fill: "forwards" }
      );
      hold = Math.max(hold, startAt + scrollMs + SCROLL_PAUSE_MS);
    } else {
      hold = Math.max(hold, entrance + SCROLL_PAUSE_MS);
    }

    setTimeout(function () {
      slide.classList.add("out");
      setTimeout(function () {
        if (slide.parentNode) {
          slide.parentNode.removeChild(slide);
        }
        schedule(150);
      }, FADE_MS);
    }, hold);
  }

  // -------------------------------------------------------------------------
  // Building a list
  // -------------------------------------------------------------------------

  function buildSlide(section) {
    var slide = document.createElement("section");
    slide.className = "slide";
    slide.dataset.section = section.id;

    var title = document.createElement("h1");
    title.className = "slide-title";
    title.textContent = text(settings[section.title]) || section.defaultTitle;
    slide.appendChild(title);

    var rule = document.createElement("div");
    rule.className = "slide-rule";
    slide.appendChild(rule);

    var viewport = document.createElement("div");
    viewport.className = "viewport";
    var list = document.createElement("ul");
    list.className = "list";

    var entries = items(section);
    var step = stagger(entries.length);
    var showAmounts = toggle(settings.showAmounts, true);
    entries.forEach(function (entry, i) {
      var li = document.createElement("li");
      li.className = "credit";
      li.style.setProperty("--delay", (FADE_MS * 0.4 + i * step) + "ms");

      var name = document.createElement("span");
      name.className = "credit-name";
      name.textContent = entry.name;
      li.appendChild(name);

      var amount = showAmounts ? amountText(section.id, entry) : "";
      if (amount) {
        var sub = document.createElement("span");
        sub.className = "credit-amount";
        sub.textContent = amount;
        li.appendChild(sub);
      }
      list.appendChild(li);
    });

    viewport.appendChild(list);
    slide.appendChild(viewport);
    return slide;
  }

  function items(section) {
    var list = (data[section.key] || []).filter(function (e) {
      return e && text(e.name) !== "";
    });
    // Chatters read best alphabetically, like the credits of a film.
    // Supporters and raiders keep the order they arrived in.
    if (section.id === "chatters") {
      list = list.slice().sort(function (a, b) {
        return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
      });
    }
    return list;
  }

  function amountText(sectionId, entry) {
    if (sectionId === "supports") {
      var parts = [];
      var bits = Number(entry.bits) || 0;
      var gifts = Number(entry.gifts) || 0;
      if (bits > 0) {
        parts.push(count(bits) + " bits");
      }
      if (gifts > 0) {
        parts.push(count(gifts) + (gifts === 1 ? " gifted sub" : " gifted subs"));
      }
      return parts.join(" · ");
    }
    if (sectionId === "raids") {
      var viewers = Number(entry.viewers) || 0;
      return viewers > 0 ? count(viewers) + (viewers === 1 ? " viewer" : " viewers") : "";
    }
    return "";
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  function enabled(section) {
    return toggle(settings[section.show], true);
  }

  function stagger(n) {
    return n > 1 ? Math.min(STAGGER_STEP_MS, STAGGER_TOTAL_MS / (n - 1)) : 0;
  }

  function speed() {
    var n = Number(settings.scrollSpeed);
    return Number.isFinite(n) && n > 0 ? n : 60;
  }

  function seconds(value, fallback) {
    var n = Number(value);
    return Number.isFinite(n) && n >= 3 ? n : fallback;
  }

  function count(n) {
    return Math.round(n).toLocaleString("en-US");
  }

  // Toggles may arrive as booleans or as the strings "true"/"false".
  function toggle(value, fallback) {
    if (value === undefined || value === null || value === "") {
      return fallback;
    }
    return value === true || value === "true";
  }

  function text(value) {
    return typeof value === "string" ? value.trim() : "";
  }

  function parse(raw) {
    if (raw === null || raw === undefined || raw === "null") {
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
})();
