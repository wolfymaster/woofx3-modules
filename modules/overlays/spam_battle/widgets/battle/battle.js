// Spam Battle widget.
//
// Reads one key from this module's storage, written by the module's functions
// (functions/battle.js) as a JSON string:
//
//   battle  {"round","phase":"idle"|"live"|"done","callout","prize",
//            "lengthMs","endedAt","total",
//            "contenders":[{"login","name","avatar","votes"}],   most votes first
//            "winner": {"login","name","avatar","votes","percent"} | null}
//
// and the battle timer itself: the WoofX3 timer the module's `timer` setting
// links, at `state:<its canonical id>`, which the host answers with
// `{ running, remainingMs, durationMs }` whenever it changes, measured as it
// is sent.
//
// Idle shows nothing. Live shows the arena: the top two head to head, every
// name on the board as a racing bar with its share of the votes, and the
// clock. Done plays the winner reveal, then fades after `winnerSeconds`.

/// <reference types="@woofx3/module-sdk" />

(function () {
  "use strict";

  /** @type {import("@woofx3/module-sdk").WidgetHost} */
  var host = window.widgetHost;
  if (!host) {
    document.body.textContent = "no widgetHost — open this widget through the SDK preview harness or streamware";
    return;
  }

  var FINAL_SECONDS = 10;
  // Pops are capped so a flooded chat doesn't stack hundreds of "+1"s.
  var MAX_POPS_PER_ROW = 3;

  var settings = host.settings || {};
  var body = document.body;
  var ranksEl = document.getElementById("ranks");

  var battle = null;
  var shownRound = "";
  var shownPhase = "";
  var leader = "";
  // Votes each contender had when last drawn, to tell who just got more.
  var lastVotes = {};
  var rows = {};
  // The timer's reading as last sent, and when it arrived on this page's
  // monotonic clock: the time left counts down from those alone, so this
  // page's clock never has to agree with the engine's.
  var reading = null;
  var syncedAt = 0;
  var tick = null;
  var hideTimer = null;
  var lastShownSecond = -1;

  applySettings();

  host.storage.subscribe("battle", function (raw) {
    battle = parse(raw);
    render();
  });
  var linkedTimer = host.linkedResources ? host.linkedResources.timer : "";
  if (linkedTimer) {
    host.storage.subscribe("state:" + linkedTimer, function (raw) {
      var r = parse(raw);
      reading = r && typeof r.running === "boolean" && typeof r.remainingMs === "number" ? r : null;
      syncedAt = performance.now();
      renderClock();
    });
  }

  // -------------------------------------------------------------------------
  // Setup
  // -------------------------------------------------------------------------

  function applySettings() {
    var root = document.documentElement.style;
    setOrClear(root, "--accent", text(settings.accent));
    setOrClear(root, "--accent-alt", text(settings.accentAlt));
    document.getElementById("title").textContent = text(settings.title) || "Spam Battle";
    var scale = Number(settings.scale);
    document.getElementById("stage").style.zoom =
      Number.isFinite(scale) && scale > 0 && scale !== 100 ? String(scale / 100) : "";
  }

  function boardSize() {
    var n = Math.round(Number(settings.contenders));
    return Number.isFinite(n) ? Math.min(6, Math.max(2, n)) : 4;
  }

  // -------------------------------------------------------------------------
  // Phases
  // -------------------------------------------------------------------------

  function render() {
    var b = battle || {};
    var phase = b.phase === "live" || b.phase === "done" ? b.phase : "idle";
    var round = text(b.round);

    if (phase === "done" && winnerExpired(b)) {
      phase = "idle";
    }

    var entering = phase !== shownPhase || round !== shownRound;
    if (entering && phase === "live") {
      resetArena();
    }
    setPhase(phase);
    shownRound = round;
    shownPhase = phase;

    if (phase === "live") {
      document.getElementById("callout").textContent = text(b.callout);
      var prize = document.getElementById("prize");
      prize.textContent = text(b.prize);
      prize.hidden = prize.textContent === "";
      renderArena(b);
      renderClock();
    } else if (phase === "done" && entering) {
      renderReveal(b);
    }
  }

  function setPhase(phase) {
    ["idle", "live", "done"].forEach(function (p) {
      body.classList.toggle("phase-" + p, p === phase);
    });
    if (phase !== "live") {
      body.classList.remove("final-seconds");
    }
  }

  function resetArena() {
    ranksEl.replaceChildren();
    rows = {};
    lastVotes = {};
    leader = "";
    // Restart the slam-in animation for a battle replacing another.
    var arena = document.getElementById("arena");
    arena.style.animation = "none";
    void arena.offsetWidth;
    arena.style.animation = "";
  }

  // Seconds the winner stays up; 0 keeps it until the next battle.
  function winnerExpired(b) {
    var seconds = Number(settings.winnerSeconds);
    if (!Number.isFinite(seconds) || seconds <= 0 || !b.endedAt) {
      return false;
    }
    return Date.now() - Number(b.endedAt) >= seconds * 1000;
  }

  // -------------------------------------------------------------------------
  // Arena
  // -------------------------------------------------------------------------

  function renderArena(b) {
    var total = Number(b.total) || 0;
    var all = Array.isArray(b.contenders) ? b.contenders : [];
    var top = all.filter(function (c) { return c && c.votes > 0; }).slice(0, boardSize());

    document.getElementById("waiting").hidden = top.length > 0;
    document.getElementById("totalWrap").hidden = top.length === 0;
    setChanged("total", total.toLocaleString("en-US"));

    renderVersus(top[0], top[1]);
    renderRanks(top, total);

    var first = top[0] ? top[0].login : "";
    if (leader !== "" && first !== "" && first !== leader) {
      flashLeader();
    }
    leader = first;

    top.forEach(function (c) {
      lastVotes[c.login] = c.votes;
    });
  }

  function renderVersus(a, b) {
    body.classList.toggle("solo", !!a && !b);
    fillFighter(document.getElementById("fighterLeft"), a);
    fillFighter(document.getElementById("fighterRight"), b);
    var av = a ? a.votes : 0;
    var bv = b ? b.votes : 0;
    var split = av + bv > 0 ? (av / (av + bv)) * 100 : 50;
    // Kept off the very ends, so the VS badge never leaves the bar.
    var shown = Math.min(92, Math.max(8, split));
    document.getElementById("tugFill").style.width = shown + "%";
    document.querySelector(".tug").style.setProperty("--split", shown + "%");
  }

  function fillFighter(el, c) {
    el.classList.toggle("empty", !c);
    setAvatar(el.querySelector(".avatar"), c);
    el.querySelector(".fighter-name").textContent = c ? c.name : "???";
    var total = (battle && Number(battle.total)) || 0;
    el.querySelector(".fighter-pct").textContent = c ? percent(c.votes, total) + "%" : "–";
    if (c && lastVotes[c.login] !== undefined && c.votes > lastVotes[c.login]) {
      bump(el, "hit");
    }
  }

  // One row per contender, kept across updates so a row that changes place
  // slides there (first measure, then move, then animate from the old spot).
  function renderRanks(top, total) {
    var before = {};
    Object.keys(rows).forEach(function (login) {
      before[login] = rows[login].getBoundingClientRect().top;
    });

    var keep = {};
    top.forEach(function (c, i) {
      var row = rows[c.login] || makeRow(c);
      rows[c.login] = row;
      keep[c.login] = true;
      row.style.setProperty("--row-color", i % 2 === 0 ? "var(--accent)" : "var(--accent-alt)");
      row.querySelector(".row-rank").textContent = String(i + 1);
      row.querySelector(".row-name").textContent = c.name;
      setAvatar(row.querySelector(".avatar"), c);
      var pct = percent(c.votes, total);
      row.querySelector(".row-pct").textContent = pct + "%";
      row.querySelector(".row-fill").style.width = pct + "%";
      var gained = lastVotes[c.login] !== undefined ? c.votes - lastVotes[c.login] : 0;
      if (gained > 0) {
        bump(row, "hit");
        pop(row, gained);
      }
      if (ranksEl.children[i] !== row) {
        ranksEl.insertBefore(row, ranksEl.children[i] || null);
      }
    });
    Object.keys(rows).forEach(function (login) {
      if (!keep[login]) {
        rows[login].remove();
        delete rows[login];
      }
    });

    Object.keys(before).forEach(function (login) {
      var row = rows[login];
      if (!row) {
        return;
      }
      var moved = before[login] - row.getBoundingClientRect().top;
      if (moved !== 0 && row.animate) {
        row.animate(
          [{ transform: "translateY(" + moved + "px)" }, { transform: "none" }],
          { duration: 450, easing: "cubic-bezier(0.3, 1.3, 0.5, 1)" }
        );
      }
    });
  }

  function makeRow(c) {
    var li = document.createElement("li");
    li.className = "row";
    li.innerHTML =
      '<div class="row-fill"></div>' +
      '<span class="row-rank"></span>' +
      '<div class="avatar"><img alt="" /><span class="initial"></span></div>' +
      '<span class="row-name"></span>' +
      '<span class="row-pct"></span>';
    li.dataset.login = c.login;
    return li;
  }

  function pop(row, gained) {
    if (row.querySelectorAll(".pop").length >= MAX_POPS_PER_ROW) {
      return;
    }
    var el = document.createElement("span");
    el.className = "pop";
    el.textContent = "+" + gained;
    el.style.right = 70 + Math.random() * 60 + "px";
    row.appendChild(el);
    el.addEventListener("animationend", function () {
      el.remove();
    });
  }

  function flashLeader() {
    bump(document.getElementById("leaderFlash"), "show");
  }

  // -------------------------------------------------------------------------
  // Clock
  // -------------------------------------------------------------------------

  function renderClock() {
    if (tick !== null) {
      clearTimeout(tick);
      tick = null;
    }
    var left = remaining();
    var seconds = Math.ceil(left / 1000);
    var value = document.getElementById("clockValue");
    value.textContent = formatClock(seconds);
    if (seconds !== lastShownSecond) {
      lastShownSecond = seconds;
      if (shownPhase === "live" && seconds <= FINAL_SECONDS) {
        bump(value, "tick");
      }
    }

    var length = (battle && Number(battle.lengthMs)) || (reading && reading.durationMs) || 0;
    var fraction = length > 0 ? Math.min(1, left / length) : 1;
    document.getElementById("clockFill").style.strokeDashoffset = String(100 - fraction * 100);
    body.classList.toggle("final-seconds", shownPhase === "live" && left > 0 && seconds <= FINAL_SECONDS);

    if (reading && reading.running && left > 0) {
      // Wake just as the shown second turns over.
      tick = setTimeout(renderClock, (left % 1000 || 1000) + 5);
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

  // M:SS, or H:MM:SS for a battle an hour or longer.
  function formatClock(total) {
    var hours = Math.floor(total / 3600);
    var minutes = Math.floor((total % 3600) / 60);
    var secs = total % 60;
    return hours > 0 ? hours + ":" + pad(minutes) + ":" + pad(secs) : minutes + ":" + pad(secs);
  }

  // -------------------------------------------------------------------------
  // Winner reveal
  // -------------------------------------------------------------------------

  function renderReveal(b) {
    var w = b.winner;
    body.classList.toggle("has-winner", !!w);
    if (w) {
      setAvatar(document.getElementById("winnerAvatar"), w);
      document.getElementById("winnerName").textContent = w.name;
      document.getElementById("winnerPct").textContent =
        w.percent + "% of the vote · " + Number(w.votes).toLocaleString("en-US") + " votes";
      document.getElementById("winnerPrize").textContent = text(b.prize);
      confetti();
    }

    if (hideTimer !== null) {
      clearTimeout(hideTimer);
      hideTimer = null;
    }
    var seconds = Number(settings.winnerSeconds);
    if (Number.isFinite(seconds) && seconds > 0 && b.endedAt) {
      var wait = Math.max(0, Number(b.endedAt) + seconds * 1000 - Date.now());
      hideTimer = setTimeout(render, wait + 50);
    }
  }

  // A burst of confetti from both bottom corners, then a gentle fall.
  function confetti() {
    var canvas = document.getElementById("confetti");
    var c2d = canvas.getContext && canvas.getContext("2d");
    if (!c2d || matchMedia("(prefers-reduced-motion: reduce)").matches) {
      return;
    }
    var w = (canvas.width = canvas.clientWidth);
    var h = (canvas.height = canvas.clientHeight);
    var styles = getComputedStyle(document.documentElement);
    var colors = [
      styles.getPropertyValue("--accent").trim() || "#ff3d81",
      styles.getPropertyValue("--accent-alt").trim() || "#2de2ff",
      "#ffd84d",
      "#ffffff"
    ];
    var parts = [];
    for (var i = 0; i < 180; i++) {
      var left = i % 2 === 0;
      parts.push({
        x: left ? 0 : w,
        y: h * 0.9,
        vx: (left ? 1 : -1) * (4 + Math.random() * 9),
        vy: -(10 + Math.random() * 12),
        size: 6 + Math.random() * 8,
        spin: Math.random() * Math.PI,
        vspin: (Math.random() - 0.5) * 0.4,
        color: colors[i % colors.length]
      });
    }
    var started = performance.now();
    function frame(now) {
      var t = now - started;
      c2d.clearRect(0, 0, w, h);
      parts.forEach(function (p) {
        p.vy += 0.35;
        p.vx *= 0.99;
        p.x += p.vx;
        p.y += p.vy;
        p.spin += p.vspin;
        c2d.save();
        c2d.globalAlpha = Math.max(0, 1 - t / 5000);
        c2d.translate(p.x, p.y);
        c2d.rotate(p.spin);
        c2d.fillStyle = p.color;
        c2d.fillRect(-p.size / 2, -p.size / 4, p.size, p.size / 2);
        c2d.restore();
      });
      if (t < 5000 && shownPhase === "done") {
        requestAnimationFrame(frame);
      } else {
        c2d.clearRect(0, 0, w, h);
      }
    }
    requestAnimationFrame(frame);
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  function setAvatar(el, c) {
    var img = el.querySelector("img");
    var src = c && c.avatar ? c.avatar : "";
    if (img.getAttribute("src") !== src) {
      if (src) {
        img.setAttribute("src", src);
      } else {
        img.removeAttribute("src");
      }
    }
    el.querySelector(".initial").textContent = c && c.name ? c.name.charAt(0).toUpperCase() : "?";
  }

  function percent(votes, total) {
    return total > 0 ? Math.round((votes / total) * 100) : 0;
  }

  function setChanged(id, value) {
    var el = document.getElementById(id);
    if (el.textContent !== value) {
      el.textContent = value;
    }
  }

  function bump(el, cls) {
    el.classList.remove(cls);
    // Reading layout restarts the animation when the class goes straight back.
    void el.offsetWidth;
    el.classList.add(cls);
  }

  function setOrClear(style, prop, value) {
    if (value) {
      style.setProperty(prop, value);
    } else {
      style.removeProperty(prop);
    }
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
