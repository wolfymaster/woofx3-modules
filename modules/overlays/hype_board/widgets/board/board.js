// Hype Board widget.
//
// Reads two keys from this module's storage, both written by the module's
// functions (functions/hype.js) as JSON strings:
//
//   board     {"currency","subs","bits","tipsCents",
//              "bosses":{"bits"|"gifts"|"tips": {"name","amount"} | null}}
//   subathon  {"active","ended"}: whether a subathon is on, or ran out
//
// and the subathon timer itself: the WoofX3 timer the module's `timer`
// setting links, at `state:<its canonical id>`, which the host answers with
// `{ running, remainingMs, durationMs }` whenever it changes, measured as it
// is sent.
//
// Which parts show is the theme's `sections` variable, overridden per part by
// the show* settings. Labels come from the theme too, overridden by settings.
// Everything about the look is CSS: this script only fills in text and sets
// classes (see board.css for the list themes can key off).

/// <reference types="@woofx3/module-sdk" />

(function () {
  "use strict";

  /** @type {import("@woofx3/module-sdk").WidgetHost} */
  var host = window.widgetHost;
  if (!host) {
    document.body.textContent = "no widgetHost — open this widget through the SDK preview harness or streamware";
    return;
  }

  var SECTIONS = ["timer", "goal", "note", "bosses", "totals", "milestones"];
  var SHOW_SETTING = {
    timer: "showTimer",
    goal: "showGoal",
    note: "showNote",
    bosses: "showBosses",
    totals: "showTotals",
    milestones: "showMilestones"
  };
  // Contract defaults, for an engine that hands over no theme at all.
  var THEME_DEFAULTS = {
    sections: "timer goal bosses",
    bitsLabel: "Top cheer",
    giftsLabel: "Top gifter",
    tipsLabel: "Top tip",
    timerLabel: "Subathon",
    subsUnit: "subs"
  };

  var settings = host.settings || {};
  var theme = host.theme || null;
  var body = document.body;

  var board = null;
  var subathon = null;
  // The timer's reading as last sent, and when it arrived on this page's
  // monotonic clock: the time left counts down from those alone, so this
  // page's clock never has to agree with the engine's.
  var reading = null;
  var syncedAt = 0;
  var tick = null;

  applyTheme();
  applySettings();

  host.storage.subscribe("board", function (raw) {
    board = parse(raw);
    renderBoard();
  });
  host.storage.subscribe("subathon", function (raw) {
    subathon = parse(raw);
    renderTimer();
  });
  var linkedTimer = host.linkedResources ? host.linkedResources.timer : "";
  if (linkedTimer) {
    host.storage.subscribe("state:" + linkedTimer, function (raw) {
      var r = parse(raw);
      reading = r && typeof r.running === "boolean" && typeof r.remainingMs === "number" ? r : null;
      syncedAt = performance.now();
      renderTimer();
    });
  } else {
    renderTimer();
  }

  // Redrawn as the streamer edits it in the scene editor, rather than
  // reloaded. A host without live settings reloads the widget instead.
  if (host.onSettings) {
    host.onSettings(function (next) {
      settings = next || {};
      applySettings();
      renderBoard();
      renderTimer();
    });
  }

  // -------------------------------------------------------------------------
  // Setup
  // -------------------------------------------------------------------------

  function themeVar(id) {
    var v = theme && theme.variables ? theme.variables[id] : undefined;
    return typeof v === "string" && v.trim() !== "" ? v.trim() : THEME_DEFAULTS[id];
  }

  function applyTheme() {
    var assets = (theme && theme.assets) || {};
    Object.keys(assets).forEach(function (slot) {
      if (assets[slot]) {
        body.classList.add("has-" + slot);
      }
    });
    if (theme && theme.id) {
      body.dataset.theme = theme.id;
    }
    // A stylesheet can't name a font file (the slot arrives as a url() in a
    // custom property, which @font-face can't read), so the font slot is
    // registered here under the family board.css asks for first.
    if (assets.font && typeof FontFace === "function") {
      var face = new FontFace("HypeBoardFont", "url(" + JSON.stringify(assets.font) + ")");
      face.load().then(function (loaded) {
        document.fonts.add(loaded);
      }).catch(function () {
        // The fallback stack in --theme-fontFamily covers a font that won't load.
      });
    }
  }

  function applySettings() {
    var themed = themeVar("sections").toLowerCase().split(/[\s,]+/);
    var first = true;
    SECTIONS.forEach(function (id) {
      var choice = settings[SHOW_SETTING[id]];
      var show = choice === "show" || (choice !== "hide" && themed.indexOf(id) !== -1);
      if (id === "note" && text(settings.note) === "") {
        show = false;
      }
      if (id === "milestones" && milestones().length === 0) {
        show = false;
      }
      var el = document.getElementById(id);
      el.hidden = !show;
      el.classList.toggle("first-shown", show && first);
      first = first && !show;
      body.classList.toggle("show-" + id, show);
    });

    setText("timerLabel", text(settings.timerLabel) || themeVar("timerLabel"));
    setText("noteText", text(settings.note));
    setText("goalTitle", text(settings.goalTitle));
    document.getElementById("goalTitle").hidden = text(settings.goalTitle) === "";
    setText("goalMetric", metricLabel(goalMetric()));
    setText("goalTarget", formatMetric(goalMetric(), goalTarget()));

    ["bits", "gifts", "tips"].forEach(function (kind) {
      var label = text(settings[kind + "Label"]) || themeVar(kind + "Label");
      bossEl(kind).querySelector(".boss-label").textContent = label;
    });

    var scale = Number(settings.scale);
    document.getElementById("board").style.zoom =
      Number.isFinite(scale) && scale > 0 && scale !== 100 ? String(scale / 100) : "";
  }

  // -------------------------------------------------------------------------
  // Board: top supporters, totals, goal, milestones
  // -------------------------------------------------------------------------

  function renderBoard() {
    var b = board || {};
    var bosses = b.bosses || {};
    var empty = text(settings.emptyName) || "Be first!";

    ["bits", "gifts", "tips"].forEach(function (kind) {
      var el = bossEl(kind);
      var boss = bosses[kind];
      var nameEl = el.querySelector(".boss-name");
      var amountEl = el.querySelector(".boss-amount");
      if (!boss) {
        el.classList.add("empty");
        nameEl.textContent = empty;
        amountEl.textContent = "";
        return;
      }
      el.classList.remove("empty");
      var amount = kind === "tips" ? formatTips(boss.amount) : formatCount(boss.amount);
      if (nameEl.textContent !== boss.name || amountEl.textContent !== amount) {
        bump(el);
      }
      nameEl.textContent = boss.name;
      amountEl.textContent = amount;
    });

    setTotal("subs", formatCount(b.subs || 0));
    setTotal("bits", formatCount(b.bits || 0));
    setTotal("tips", formatTips(b.tipsCents || 0));

    var metric = goalMetric();
    var current = metricValue(metric);
    var target = goalTarget();
    setChanged("goalCurrent", formatMetric(metric, current));
    document.getElementById("goalFill").style.width = Math.min(100, (current / target) * 100) + "%";
    body.classList.toggle("goal-reached", current >= target);

    renderMilestones(current);
  }

  function renderMilestones(current) {
    var list = document.getElementById("milestoneList");
    var metric = goalMetric();
    var items = milestones();
    var nextFound = false;
    list.replaceChildren();
    items.forEach(function (m) {
      var li = document.createElement("li");
      li.className = "milestone";
      if (current >= m.target) {
        li.classList.add("reached");
      } else if (!nextFound) {
        li.classList.add("next");
        nextFound = true;
      }
      var label = document.createElement("span");
      label.className = "milestone-label";
      label.textContent = m.label;
      var target = document.createElement("span");
      target.className = "milestone-target";
      target.textContent = formatMetric(metric, m.target);
      li.appendChild(label);
      li.appendChild(target);
      list.appendChild(li);
    });
  }

  function milestones() {
    var raw = Array.isArray(settings.milestones) ? settings.milestones : [];
    return raw
      .map(function (m) {
        var target = Number(m && m.target);
        return { target: target, label: text(m && m.label) };
      })
      .filter(function (m) { return Number.isFinite(m.target) && m.target > 0 && m.label !== ""; })
      .sort(function (a, b) { return a.target - b.target; });
  }

  function goalMetric() {
    return ["subs", "bits", "tips"].indexOf(settings.goalMetric) !== -1 ? settings.goalMetric : "subs";
  }

  function goalTarget() {
    var n = Number(settings.goalTarget);
    return Number.isFinite(n) && n > 0 ? n : 100;
  }

  // The goal's metric, in the units the streamer typed the goal in.
  function metricValue(metric) {
    var b = board || {};
    if (metric === "tips") {
      return (Number(b.tipsCents) || 0) / 100;
    }
    return Number(b[metric]) || 0;
  }

  function metricLabel(metric) {
    if (metric === "subs") {
      return themeVar("subsUnit");
    }
    return metric;
  }

  function formatMetric(metric, value) {
    return metric === "tips" ? formatTips(value * 100) : formatCount(value);
  }

  // -------------------------------------------------------------------------
  // Subathon timer
  // -------------------------------------------------------------------------

  function renderTimer() {
    if (tick !== null) {
      clearTimeout(tick);
      tick = null;
    }
    var left = remaining();
    var sub = subathon || {};
    var state;
    if (sub.active !== true && sub.ended !== true) {
      state = "idle";
    } else if (left <= 0) {
      state = "done";
    } else {
      state = reading && reading.running ? "running" : "paused";
    }
    ["idle", "running", "paused", "done"].forEach(function (s) {
      body.classList.toggle("timer-" + s, s === state);
    });
    setText("timerValue", formatDuration(left));
    if (state === "running") {
      // Wake just as the shown second turns over.
      tick = setTimeout(renderTimer, (left % 1000 || 1000) + 5);
    }
  }

  function remaining() {
    if (!reading) {
      return 0;
    }
    if (!reading.running) {
      return Math.max(0, reading.remainingMs);
    }
    return Math.max(0, reading.remainingMs - (performance.now() - syncedAt));
  }

  // H:MM:SS with hours unbounded, so a long subathon reads 214:39:09. Seconds
  // round up, so a timer with any time left never shows 0:00:00.
  function formatDuration(ms) {
    var total = Math.ceil(ms / 1000);
    var hours = Math.floor(total / 3600);
    var minutes = Math.floor((total % 3600) / 60);
    var seconds = total % 60;
    return hours + ":" + pad(minutes) + ":" + pad(seconds);
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  function bossEl(kind) {
    return document.querySelector('.boss[data-kind="' + kind + '"]');
  }

  function setTotal(kind, value) {
    var el = document.querySelector('.total[data-kind="' + kind + '"] .total-value');
    if (el.textContent !== value) {
      el.textContent = value;
      bump(el);
    }
  }

  function setChanged(id, value) {
    var el = document.getElementById(id);
    if (el.textContent !== value) {
      el.textContent = value;
      bump(el);
    }
  }

  function setText(id, value) {
    document.getElementById(id).textContent = value;
  }

  function bump(el) {
    el.classList.remove("bump");
    // Reading layout restarts the animation when the class goes straight back.
    void el.offsetWidth;
    el.classList.add("bump");
  }

  function formatCount(n) {
    return Math.round(Number(n) || 0).toLocaleString("en-US");
  }

  function formatTips(cents) {
    var symbol = board && typeof board.currency === "string" ? board.currency : "$";
    var units = (Number(cents) || 0) / 100;
    var whole = Math.round(units * 100) % 100 === 0;
    return symbol + units.toLocaleString("en-US", {
      minimumFractionDigits: whole ? 0 : 2,
      maximumFractionDigits: whole ? 0 : 2
    });
  }

  function pad(n) {
    return n < 10 ? "0" + n : String(n);
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
