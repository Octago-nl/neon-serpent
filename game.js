/* Neon Serpent — game.js
 * A self-contained, guaranteed-playable grid trail-survival mechanic (genome: neon-serpent).
 * It INTEGRATES the shared Octagonal engine/beacon when present (canonical-origin load) but NEVER
 * depends on it for the core loop, so the cabinet plays even if the engine fails to load. Cartridge
 * concerns wired: beacon telemetry (17-event vocab), meta-layer tokens/XP, flags.json monetization
 * slots, SEO/OG share deep-link, "Made with Octagonal" backlink. No build step; classic script.
 */
(function () {
  "use strict";

  // ---- Cartridge integration (all guarded — missing engine = no-op, never a crash) ----------
  var SLUG = "neon-serpent";
  var Beacon = (window.OCTAGO_BEACON && typeof window.OCTAGO_BEACON.emit === "function")
    ? window.OCTAGO_BEACON : { emit: function () {} };
  var Meta = window.OCTAGO || null;                    // profile / addTokens / addXP if the engine booted
  var VARIANT = "A";
  function emit(event, value, unit, dims) {
    try { Beacon.emit(event, { entity: SLUG, value: value == null ? 1 : value, unit: unit || "count",
      dims: Object.assign({ variant: VARIANT, slug: SLUG }, dims || {}) }); } catch (e) {}
  }
  function tokens(n) { try { if (Meta && Meta.addTokens) Meta.addTokens(n); } catch (e) {} }
  function xp(n) { try { if (Meta && Meta.addXP) Meta.addXP(n); } catch (e) {} }

  // ---- board / tuning -----------------------------------------------------------------------
  var cvs = document.getElementById("game"), ctx = cvs.getContext("2d");
  var GRID = 24, CELL = cvs.width / GRID;              // 480 / 24 = 20px cells
  var TICK0 = 135, TICK_MIN = 62, SPEEDUP = 4;         // gentle -> spike: shave ms per level
  var reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;

  var els = {
    score: document.getElementById("score"), best: document.getElementById("best"),
    len: document.getElementById("len"), overlay: document.getElementById("overlay"),
    title: document.getElementById("title"), tag: document.getElementById("tag"),
    start: document.getElementById("start"), shareWrap: document.getElementById("share-wrap"),
    share: document.getElementById("share")
  };

  var S = null;              // game state
  var best = +(localStorage.getItem("oct.neon-serpent.best") || 0);
  els.best.textContent = best;

  // ---- beat-my-score deep link (?s=&p=) → attract-mode challenge ----------------------------
  var q = new URLSearchParams(location.search);
  var rivalScore = +q.get("s") || 0, rival = q.get("p") || "";
  if (rivalScore > 0) {
    els.tag.innerHTML = "a challenger scored <b style='color:#20e6ff'>" + rivalScore +
      "</b> — can you beat it?<br>arrows / WASD · swipe on touch";
    emit("cross_promo_click", 1, "count", { referrer: "share", rival: rival });
  }

  // ---- flags.json → monetization slots (the A/B substrate; never rebuild to change money) ----
  fetch("./flags.json").then(function (r) { return r.json(); }).then(function (f) {
    var slots = (f && f.slots) || {};
    VARIANT = (f && f.experiment && f.experiment.variant) || "A";
    Object.keys(slots).forEach(function (k) {
      var on = slots[k] && slots[k].on;
      var el = document.querySelector('[data-slot="' + k + '"]');
      if (el && on) {
        el.classList.add("on");
        if (k === "cabinet_banner") emit("ad_impression", 1, "count", { network: (slots[k].network || "house") });
        if (k === "insert_coin_jar") {
          el.href = "https://ko-fi.com/octagonal";     // hosted checkout — zero server, no card data touches us
          el.addEventListener("click", function () { emit("coin_insert", 1, "count"); emit("checkout_step", 1, "count", { step: "jar_click" }); });
        }
      }
    });
  }).catch(function () {/* flags optional; slots stay off */});

  // ---- input --------------------------------------------------------------------------------
  var DIRS = { up: { x: 0, y: -1 }, down: { x: 0, y: 1 }, left: { x: -1, y: 0 }, right: { x: 1, y: 0 } };
  function setDir(d) {
    if (!S || S.mode !== "play") return;
    var nd = DIRS[d]; if (!nd) return;
    var cur = S.dir;
    if (nd.x === -cur.x && nd.y === -cur.y) return;    // no 180° reversal into the neck
    S.queued = nd;
  }
  var KEYMAP = { ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right",
    w: "up", s: "down", a: "left", d: "right", W: "up", S: "down", A: "left", D: "right" };
  addEventListener("keydown", function (e) {
    if (e.key === " " || e.key === "Enter") { if (!S || S.mode !== "play") startGame(); e.preventDefault(); return; }
    var d = KEYMAP[e.key]; if (d) { setDir(d); e.preventDefault(); }
  });
  // touch swipe
  var tsx = 0, tsy = 0, tracking = false;
  cvs.addEventListener("touchstart", function (e) { var t = e.changedTouches[0]; tsx = t.clientX; tsy = t.clientY; tracking = true; }, { passive: true });
  cvs.addEventListener("touchend", function (e) {
    if (!tracking) return; tracking = false;
    var t = e.changedTouches[0], dx = t.clientX - tsx, dy = t.clientY - tsy;
    if (Math.abs(dx) < 16 && Math.abs(dy) < 16) { if (!S || S.mode !== "play") startGame(); return; }
    if (Math.abs(dx) > Math.abs(dy)) setDir(dx > 0 ? "right" : "left"); else setDir(dy > 0 ? "down" : "up");
  }, { passive: true });
  els.start.addEventListener("click", startGame);
  els.share.addEventListener("click", share);

  // ---- lifecycle ----------------------------------------------------------------------------
  function startGame() {
    var mid = Math.floor(GRID / 2);
    S = {
      mode: "play", dir: DIRS.right, queued: DIRS.right,
      body: [{ x: mid - 1, y: mid }, { x: mid - 2, y: mid }, { x: mid - 3, y: mid }],
      food: null, score: 0, level: 1, tick: TICK0, acc: 0, last: performance.now(),
      grow: 0, pops: [], shake: 0, startTs: Date.now()
    };
    placeFood();
    els.overlay.classList.add("hide");
    hud();
    emit("play_start");
    requestAnimationFrame(loop);
  }

  function endGame() {
    S.mode = "over";
    var dur = Date.now() - S.startTs;
    emit("score", S.score, "count");
    emit("play_end", dur, "ms", { score: S.score, level: S.level });
    xp(S.score);                                        // meta-layer: XP accrues cross-catalog
    if (S.score > best) { best = S.score; localStorage.setItem("oct.neon-serpent.best", best); els.best.textContent = best; }
    els.title.textContent = "GAME OVER";
    els.tag.innerHTML = "score <b style='color:#20e6ff'>" + S.score + "</b> · length <b>" + S.body.length +
      "</b><br>" + (S.score >= best ? "★ NEW BEST ★" : "best " + best) + " — press start to continue";
    els.start.textContent = "▶ INSERT COIN";
    els.shareWrap.style.display = "";
    els.overlay.classList.remove("hide");
  }

  function placeFood() {
    var free = [];
    for (var y = 0; y < GRID; y++) for (var x = 0; x < GRID; x++) {
      if (!S.body.some(function (c) { return c.x === x && c.y === y; })) free.push({ x: x, y: y });
    }
    if (!free.length) { endGame(); return; }             // board full = flawless victory
    // deterministic-enough spread without Math.random dependence on any one RNG quirk
    S.food = free[(Math.random() * free.length) | 0];
  }

  function step() {
    S.dir = S.queued;
    var nh = { x: S.body[0].x + S.dir.x, y: S.body[0].y + S.dir.y };
    // wall death
    if (nh.x < 0 || nh.y < 0 || nh.x >= GRID || nh.y >= GRID) return endGame();
    // self death (the current tail cell will vacate this step unless we're growing)
    var willGrow = S.grow > 0 || (S.food && nh.x === S.food.x && nh.y === S.food.y);
    for (var i = 0; i < S.body.length; i++) {
      if (S.body[i].x === nh.x && S.body[i].y === nh.y) {
        if (i === S.body.length - 1 && !willGrow) continue; // tail moves away — safe
        return endGame();
      }
    }
    S.body.unshift(nh);
    if (S.food && nh.x === S.food.x && nh.y === S.food.y) {
      S.score += 10; S.grow += 1;
      tokens(1);                                          // meta-layer soft currency
      S.pops.push({ x: nh.x, y: nh.y, t: 1 });            // crunch-pop juice
      if (!reduce) S.shake = 3;
      // gentle -> spike difficulty: every 5 nodes, level up + speed up
      if (S.score % 50 === 0) { S.level++; S.tick = Math.max(TICK_MIN, S.tick - SPEEDUP * 2); emit("level", S.level, "count"); }
      else { S.tick = Math.max(TICK_MIN, S.tick - 0.5); }
      placeFood();
      hud();
    }
    if (S.grow > 0) S.grow--; else S.body.pop();
  }

  function hud() { els.score.textContent = S.score; els.len.textContent = S.body.length; }

  // ---- render (synthwave dusk grid, magenta trail, VHS bloom via shadowBlur) -----------------
  function draw() {
    var W = cvs.width, H = cvs.height, sh = S && S.shake ? S.shake : 0;
    var ox = sh ? (Math.random() * 2 - 1) * sh : 0, oy = sh ? (Math.random() * 2 - 1) * sh : 0;
    ctx.setTransform(1, 0, 0, 1, ox, oy);
    // background wash
    var g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, "#160a3a"); g.addColorStop(1, "#070225");
    ctx.fillStyle = g; ctx.fillRect(-4, -4, W + 8, H + 8);
    // cyan lattice
    ctx.strokeStyle = "rgba(32,230,255,.10)"; ctx.lineWidth = 1;
    ctx.beginPath();
    for (var i = 0; i <= GRID; i++) { var p = i * CELL + .5; ctx.moveTo(p, 0); ctx.lineTo(p, H); ctx.moveTo(0, p); ctx.lineTo(W, p); }
    ctx.stroke();
    if (!S) return;
    // glow-node
    if (S.food) {
      var fx = S.food.x * CELL + CELL / 2, fy = S.food.y * CELL + CELL / 2;
      ctx.shadowColor = "#20e6ff"; ctx.shadowBlur = reduce ? 0 : 16; ctx.fillStyle = "#8ff6ff";
      ctx.beginPath(); ctx.arc(fx, fy, CELL * 0.32, 0, 7); ctx.fill();
    }
    // serpent trail (head brightest)
    ctx.shadowColor = "#ff2fb9"; ctx.shadowBlur = reduce ? 0 : 14;
    for (var s = S.body.length - 1; s >= 0; s--) {
      var c = S.body[s], t = 1 - s / (S.body.length + 2);
      ctx.fillStyle = s === 0 ? "#ffffff" : "rgba(255,47,185," + (0.35 + 0.6 * t).toFixed(3) + ")";
      var pad = s === 0 ? 2 : 3;
      rrect(c.x * CELL + pad, c.y * CELL + pad, CELL - pad * 2, CELL - pad * 2, 4);
    }
    ctx.shadowBlur = 0;
    // crunch-pop bursts
    for (var k = S.pops.length - 1; k >= 0; k--) {
      var po = S.pops[k]; po.t -= 0.08;
      if (po.t <= 0) { S.pops.splice(k, 1); continue; }
      ctx.strokeStyle = "rgba(143,246,255," + po.t.toFixed(2) + ")"; ctx.lineWidth = 2;
      var r = (1 - po.t) * CELL * 1.4;
      ctx.beginPath(); ctx.arc(po.x * CELL + CELL / 2, po.y * CELL + CELL / 2, r, 0, 7); ctx.stroke();
    }
    if (S.shake > 0) S.shake = Math.max(0, S.shake - 0.35);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }
  function rrect(x, y, w, h, r) { ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath(); ctx.fill(); }

  // ---- fixed-timestep loop ------------------------------------------------------------------
  function loop(now) {
    if (!S) return;
    var dt = now - S.last; S.last = now;
    if (S.mode === "play") {
      S.acc += dt;
      while (S.acc >= S.tick) { S.acc -= S.tick; if (S.mode === "play") step(); }
    }
    draw();
    if (S.mode === "play") requestAnimationFrame(loop);
    else draw();                                          // final frame on the game-over overlay
  }

  // ---- share (beat-my-score deep link + OG rewrite) -----------------------------------------
  function share() {
    var pid = (Meta && Meta.pid && Meta.pid()) || localStorage.getItem("oct_pid") || ("g" + (Date.now() % 1e7));
    try { localStorage.setItem("oct_pid", pid); } catch (e) {}
    var url = location.origin + location.pathname + "?s=" + (S ? S.score : 0) + "&p=" + encodeURIComponent(pid);
    emit("share_click", 1, "count", { score: S ? S.score : 0 });
    var text = "I scored " + (S ? S.score : 0) + " in Neon Serpent — can you beat it? ⯃";
    if (navigator.share) { navigator.share({ title: "Neon Serpent", text: text, url: url }).catch(function () {}); }
    else if (navigator.clipboard) { navigator.clipboard.writeText(url).then(function () { els.share.textContent = "✓ LINK COPIED"; setTimeout(function () { els.share.textContent = "↗ SHARE / BEAT MY SCORE"; }, 1500); }).catch(function () { prompt("Copy your challenge link:", url); }); }
    else prompt("Copy your challenge link:", url);
  }

  // idle attract-mode draw so the board isn't blank before first coin
  draw();
})();
