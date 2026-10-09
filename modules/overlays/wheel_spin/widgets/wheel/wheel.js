// Wheel Spin widget.
//
// Reads one key from this module's storage, written by the module's functions
// (functions/wheel.js) as a JSON string:
//
//   wheel  {"items":[string],
//           "spin": {"id","labels":[string],"winnerIndex","landAt","turns",
//                    "durationMs","endsAt","item"} | null}
//
// The winner is picked by the function; this page only spins to it. A spin is
// drawn from `spin.labels`, the wheel as it was when the spin started, and the
// live `items` take over once the winner has been shown, so a winner taken off
// the wheel disappears only after everyone has seen it land.
//
// Geometry: slice i covers wheel angles [i, i+1) * slice, measured clockwise
// from the pointer at 3 o'clock when the wheel's rotation is 0. The wheel
// turns clockwise, so the pointer reads wheel angle -rotation.
//
// The slices are drawn once into an offscreen canvas and each frame just
// rotates that image, so a wheel with thousands of entries spins as smoothly
// as one with four.

/// <reference types="@woofx3/module-sdk" />

(function () {
  "use strict";

  /** @type {import("@woofx3/module-sdk").WidgetHost} */
  var host = window.widgetHost;
  if (!host) {
    document.body.textContent = "no widgetHost — open this widget through the SDK preview harness or streamware";
    return;
  }

  var TAU = Math.PI * 2;
  var DEFAULT_COLORS = ["#3369e8", "#d50f25", "#eeb211", "#009925"];
  var EMPTY_COLOR = "#4a5160";
  // Labels smaller than this aren't readable on stream; past it slices go
  // unlabelled rather than turning into noise.
  var MIN_FONT_PX = 9;
  // The narrowest coloured stripe drawn at the rim.
  var MIN_BAND_PX = 8;
  // The pointer stops twitching on every slice past this many; it would just
  // buzz.
  var MAX_TICK_SLICES = 120;
  // A spin that ended this long before the page saw it is history: the wheel
  // is shown at rest where it landed instead of spinning again.
  var STALE_SPIN_MS = 2000;

  var settings = host.settings || {};
  var body = document.body;
  var wrap = document.getElementById("wheelWrap");
  var canvas = document.getElementById("wheel");
  var g = canvas.getContext("2d");
  var pointer = document.getElementById("pointer");

  var colors = DEFAULT_COLORS.map(function (fallback, i) {
    return text(settings["color" + (i + 1)]) || fallback;
  });

  var items = [];
  // What's on the wheel right now: the live items, or a spin's snapshot.
  var labels = [];
  var rotation = 0;
  var size = 0;
  var cache = null;
  var cacheDirty = true;

  var seenSpin = "";
  var firstValue = true;
  var spinning = false;
  // Holding the spin's snapshot on screen: from the spin until the winner
  // card goes away.
  var holding = false;
  var winnerTimer = null;
  var lastTickSlice = -1;
  // Bumped by each spin, so a spin that arrives mid-animation takes over
  // from the one in flight instead of both turning the wheel.
  var animation = 0;

  applySettings();
  fit();
  if (typeof ResizeObserver === "function") {
    new ResizeObserver(fit).observe(document.getElementById("wheelBox"));
  } else {
    window.addEventListener("resize", fit);
  }

  host.storage.subscribe("wheel", function (raw) {
    var wheel = parse(raw) || {};
    items = Array.isArray(wheel.items) ? wheel.items.map(text) : [];
    var spin = wheel.spin && typeof wheel.spin === "object" ? wheel.spin : null;
    var first = firstValue;
    firstValue = false;

    if (spin && text(spin.id) !== "" && text(spin.id) !== seenSpin) {
      seenSpin = text(spin.id);
      if (first && Date.now() > Number(spin.endsAt) + STALE_SPIN_MS) {
        restAfter(spin);
      } else {
        startSpin(spin);
      }
      return;
    }
    if (!holding) {
      setLabels(items);
    }
    updateIdle();
  });

  // -------------------------------------------------------------------------
  // Setup
  // -------------------------------------------------------------------------

  function applySettings() {
    var accent = text(settings.accent);
    if (accent) {
      document.documentElement.style.setProperty("--accent", accent);
    }
    var title = document.getElementById("title");
    title.textContent = text(settings.title);
    title.hidden = title.textContent === "";
  }

  // The largest square that fits the space under the title.
  function fit() {
    var box = document.getElementById("wheelBox");
    var side = Math.floor(Math.min(box.clientWidth, box.clientHeight));
    if (side <= 0 || side === size) {
      return;
    }
    size = side;
    wrap.style.width = side + "px";
    wrap.style.height = side + "px";
    var dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(side * dpr);
    canvas.height = Math.round(side * dpr);
    cacheDirty = true;
    draw();
  }

  // -------------------------------------------------------------------------
  // Spinning
  // -------------------------------------------------------------------------

  function startSpin(spin) {
    var snapshot = Array.isArray(spin.labels) ? spin.labels.map(text) : [];
    var winner = Math.floor(Number(spin.winnerIndex));
    if (snapshot.length === 0 || !(winner >= 0 && winner < snapshot.length)) {
      return;
    }
    clearTimeout(winnerTimer);
    hideWinner();
    holding = true;
    spinning = true;
    setLabels(snapshot);
    updateIdle();

    var from = rotation;
    var to = from + Math.max(1, Math.round(Number(spin.turns) || 5)) * TAU + forwardTo(from, restingAngle(spin, snapshot.length));
    var duration = Math.max(500, Number(spin.durationMs) || 8000);
    var startedAt = performance.now();
    var mine = ++animation;
    lastTickSlice = sliceUnderPointer();

    function frame(now) {
      if (mine !== animation) {
        return;
      }
      var t = Math.min(1, (now - startedAt) / duration);
      rotation = from + (to - from) * easeOut(t);
      draw();
      tickPointer();
      if (t < 1) {
        requestAnimationFrame(frame);
        return;
      }
      rotation = to % TAU;
      spinning = false;
      land(spin);
    }
    requestAnimationFrame(frame);
  }

  function land(spin) {
    showWinner(text(spin.item));
    var seconds = Number(settings.winnerSeconds);
    if (!Number.isFinite(seconds) || seconds < 0) {
      seconds = 8;
    }
    if (seconds > 0) {
      winnerTimer = setTimeout(finishHold, seconds * 1000);
    }
  }

  // The winner has been shown: back to the live wheel.
  function finishHold() {
    hideWinner();
    holding = false;
    setLabels(items);
    updateIdle();
  }

  // A spin from before this page loaded: sit where it stopped, showing the
  // winner only when the setting keeps winners up until the next spin.
  function restAfter(spin) {
    var count = Array.isArray(spin.labels) ? spin.labels.length : 0;
    if (count > 0) {
      rotation = restingAngle(spin, count);
    }
    if (count > 0 && Number(settings.winnerSeconds) === 0 && text(spin.item) !== "") {
      holding = true;
      setLabels(spin.labels.map(text));
      showWinner(text(spin.item));
    } else {
      setLabels(items);
    }
    updateIdle();
  }

  // The rotation that puts `landAt` of the winning slice under the pointer.
  function restingAngle(spin, count) {
    var landAt = Number(spin.landAt);
    if (!(landAt >= 0 && landAt <= 1)) {
      landAt = 0.5;
    }
    return mod(-(Number(spin.winnerIndex) + landAt) * (TAU / count), TAU);
  }

  // How far clockwise from `from` to reach `target`, both as rotations.
  function forwardTo(from, target) {
    return mod(target - mod(from, TAU), TAU);
  }

  // Fast start, long slow finish, like a real wheel losing speed.
  function easeOut(t) {
    return 1 - Math.pow(1 - t, 4);
  }

  function sliceUnderPointer() {
    if (labels.length === 0) {
      return -1;
    }
    return Math.floor(mod(-rotation, TAU) / (TAU / labels.length));
  }

  function tickPointer() {
    if (labels.length < 2 || labels.length > MAX_TICK_SLICES) {
      return;
    }
    var slice = sliceUnderPointer();
    if (slice === lastTickSlice) {
      return;
    }
    lastTickSlice = slice;
    pointer.classList.remove("tick");
    // Reading layout restarts the animation.
    void pointer.getBoundingClientRect();
    pointer.classList.add("tick");
  }

  // -------------------------------------------------------------------------
  // Winner and idle
  // -------------------------------------------------------------------------

  function showWinner(name) {
    document.getElementById("winnerName").textContent = name;
    body.classList.remove("show-winner");
    void body.offsetWidth;
    body.classList.add("show-winner");
    confetti();
  }

  function hideWinner() {
    body.classList.remove("show-winner");
  }

  function updateIdle() {
    var hide = toggle(settings.hideWhenIdle, false) && !spinning && !holding;
    body.classList.toggle("idle-hidden", hide);
  }

  // -------------------------------------------------------------------------
  // Drawing
  // -------------------------------------------------------------------------

  function setLabels(next) {
    if (sameList(labels, next)) {
      return;
    }
    labels = next;
    cacheDirty = true;
    draw();
  }

  function draw() {
    if (size <= 0) {
      return;
    }
    if (cacheDirty || !cache) {
      cache = renderSlices();
      cacheDirty = false;
    }
    var w = canvas.width;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, w, w);
    g.translate(w / 2, w / 2);
    g.rotate(rotation);
    g.drawImage(cache, -w / 2, -w / 2);
  }

  function renderSlices() {
    var off = document.createElement("canvas");
    off.width = canvas.width;
    off.height = canvas.height;
    var c = off.getContext("2d");
    var dpr = canvas.width / size;
    var r = canvas.width / 2;
    c.translate(r, r);

    var n = labels.length;
    if (n === 0) {
      c.beginPath();
      c.arc(0, 0, r, 0, TAU);
      c.fillStyle = EMPTY_COLOR;
      c.fill();
      c.fillStyle = "rgba(255, 255, 255, 0.75)";
      c.font = "800 " + Math.round(r * 0.08) + "px Nunito, 'Segoe UI', system-ui, sans-serif";
      c.textAlign = "center";
      c.textBaseline = "middle";
      c.fillText("The wheel is empty", 0, r * 0.45);
      return off;
    }

    // Slices thinner than a few pixels at the rim turn into a muddy blur, so
    // a crowded wheel is coloured in bands of neighbouring slices instead.
    // The pointer still lands on exactly one entry; at that size nobody can
    // see a single slice anyway.
    var slice = TAU / n;
    var per = Math.max(1, Math.ceil(MIN_BAND_PX * dpr / (slice * r)));
    var bands = Math.ceil(n / per);
    for (var b = 0; b < bands; b++) {
      c.beginPath();
      c.moveTo(0, 0);
      c.arc(0, 0, r, b * per * slice, Math.min(n, (b + 1) * per) * slice);
      c.closePath();
      c.fillStyle = sliceColor(b, bands);
      c.fill();
    }
    if (per === 1 && n > 1 && n <= 300) {
      c.strokeStyle = "rgba(0, 0, 0, 0.18)";
      c.lineWidth = Math.max(1, dpr);
      for (var s = 0; s < n; s++) {
        c.beginPath();
        c.moveTo(0, 0);
        c.lineTo(Math.cos(s * slice) * r, Math.sin(s * slice) * r);
        c.stroke();
      }
    }

    drawLabels(c, r, slice, dpr);

    c.lineWidth = Math.max(2, r * 0.012);
    c.beginPath();
    c.arc(0, 0, r - c.lineWidth / 2, 0, TAU);
    c.strokeStyle = "rgba(255, 255, 255, 0.55)";
    c.stroke();
    return off;
  }

  // Each label runs along its slice's middle, from the rim inwards, sized to
  // the slice's width where it starts and shortened to stop short of the hub.
  function drawLabels(c, r, slice, dpr) {
    var n = labels.length;
    var inner = r * 0.13;
    var outer = r * 0.94;
    // The slice's width a little in from the rim, where a label starts.
    var room = 2 * outer * 0.9 * Math.sin(Math.min(slice, Math.PI) / 2);
    var font = Math.min(r * 0.085, room * 0.62);
    if (font < MIN_FONT_PX * dpr) {
      return;
    }
    c.font = "800 " + Math.round(font) + "px Nunito, 'Segoe UI', system-ui, sans-serif";
    c.textAlign = "right";
    c.textBaseline = "middle";
    var maxWidth = outer - inner - r * 0.05;
    for (var i = 0; i < n; i++) {
      c.save();
      c.rotate((i + 0.5) * slice);
      c.fillStyle = textColorOn(sliceColor(i, n));
      c.fillText(fitText(c, labels[i], maxWidth), outer, 0);
      c.restore();
    }
  }

  // Cycles the colours, but never lets the last slice match the first one
  // it sits next to.
  function sliceColor(i, n) {
    var color = colors[i % colors.length];
    if (n > 1 && i === n - 1 && i % colors.length === 0) {
      color = colors[2 % colors.length];
    }
    return color;
  }

  function fitText(c, label, maxWidth) {
    if (c.measureText(label).width <= maxWidth) {
      return label;
    }
    var lo = 0;
    var hi = label.length;
    while (lo < hi) {
      var mid = Math.ceil((lo + hi) / 2);
      if (c.measureText(label.slice(0, mid) + "…").width <= maxWidth) {
        lo = mid;
      } else {
        hi = mid - 1;
      }
    }
    return label.slice(0, lo).trimEnd() + "…";
  }

  // White on dark slices, near-black on light ones.
  function textColorOn(hex) {
    var m = /^#?([0-9a-f]{6})$/i.exec(hex);
    if (!m) {
      return "#ffffff";
    }
    var v = parseInt(m[1], 16);
    var lum = 0.2126 * ((v >> 16) & 255) + 0.7152 * ((v >> 8) & 255) + 0.0722 * (v & 255);
    return lum > 160 ? "#1a1a1a" : "#ffffff";
  }

  // -------------------------------------------------------------------------
  // Confetti
  // -------------------------------------------------------------------------

  function confetti() {
    var el = document.getElementById("confetti");
    var dpr = window.devicePixelRatio || 1;
    el.width = Math.round(el.clientWidth * dpr);
    el.height = Math.round(el.clientHeight * dpr);
    var c = el.getContext("2d");
    var palette = colors.concat([text(settings.accent) || "#ffffff"]);
    var cx = el.width / 2;
    var cy = el.height / 2;
    var bits = [];
    for (var i = 0; i < 140; i++) {
      var angle = Math.random() * TAU;
      var speed = (6 + Math.random() * 14) * dpr;
      bits.push({
        x: cx,
        y: cy,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed - 6 * dpr,
        spin: Math.random() * TAU,
        vspin: (Math.random() - 0.5) * 0.4,
        w: (6 + Math.random() * 6) * dpr,
        h: (10 + Math.random() * 8) * dpr,
        color: palette[i % palette.length]
      });
    }
    var start = performance.now();
    function frame(now) {
      var age = now - start;
      c.clearRect(0, 0, el.width, el.height);
      c.globalAlpha = Math.max(0, 1 - age / 3200);
      bits.forEach(function (b) {
        b.vx *= 0.985;
        b.vy = b.vy * 0.985 + 0.45 * dpr;
        b.x += b.vx;
        b.y += b.vy;
        b.spin += b.vspin;
        c.save();
        c.translate(b.x, b.y);
        c.rotate(b.spin);
        c.fillStyle = b.color;
        c.fillRect(-b.w / 2, -b.h / 2, b.w, b.h * Math.abs(Math.cos(b.spin * 2)));
        c.restore();
      });
      if (age < 3200) {
        requestAnimationFrame(frame);
      } else {
        c.clearRect(0, 0, el.width, el.height);
      }
    }
    requestAnimationFrame(frame);
  }

  // -------------------------------------------------------------------------
  // Plumbing
  // -------------------------------------------------------------------------

  function sameList(a, b) {
    if (a.length !== b.length) {
      return false;
    }
    for (var i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) {
        return false;
      }
    }
    return true;
  }

  function mod(a, m) {
    return ((a % m) + m) % m;
  }

  function parse(raw) {
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

  function toggle(value, fallback) {
    if (value === undefined || value === null || value === "") {
      return fallback;
    }
    return value === true || value === "true";
  }

  function text(value) {
    return value === undefined || value === null ? "" : String(value).trim();
  }
})();
