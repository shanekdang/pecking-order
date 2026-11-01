/* The phone side of phone voting: join under a name, then vote on each
   matchup as the host's screen shows it. State comes from long-polling
   /api/play/state, which answers the moment anything in the room changes. */
(function () {
  "use strict";

  function api(path, options) {
    return fetch(path, options).then(function (res) {
      return res.json().then(function (body) {
        if (!res.ok) { var err = new Error(body.error || res.statusText); err.status = res.status; throw err; }
        return body;
      });
    });
  }
  function apiGet(path) { return api(path, { cache: "no-store" }); }
  function apiPost(path, body) {
    return api(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) });
  }

  var KEY = "po.player";
  function loadMe() {
    try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch (e) { return {}; }
  }
  function saveMe() {
    try { localStorage.setItem(KEY, JSON.stringify(me)); } catch (e) { /* ignore */ }
  }

  var me = loadMe();      // { pid, name } -- remembered so a refresh or app restart rejoins quietly
  var state = null;
  var pollGen = 0;
  var pendingChoice = null; // a tap that's on its way to the server
  var buzzedRound = null;

  var el = {};
  ["p-me", "p-join", "p-name", "p-join-btn", "p-join-msg", "p-game", "p-leave",
   "p-idle", "p-lobby", "p-lobby-bird", "p-lobby-category", "p-lobby-players",
   "p-vote", "p-category", "p-counter", "p-ring", "p-a", "p-b", "p-name-a", "p-name-b", "p-tie", "p-vote-status",
   "p-verdict", "p-verdict-emoji", "p-verdict-title", "p-verdict-sub", "p-verdict-tally",
   "p-done", "p-done-category", "p-done-me", "p-done-list", "p-done-eyebrow", "p-unveiling",
   "p-list-toggle", "p-own-cta", "p-own-blurb", "p-own-start", "p-own-actions", "p-download", "p-copy",
   "p-solo", "p-solo-counter", "p-solo-note", "p-solo-a", "p-solo-b", "p-solo-name-a", "p-solo-name-b", "p-solo-tie", "p-solo-back"
  ].forEach(function (id) { el[id] = document.getElementById(id); });

  function birdIcon(p, cls) {
    var ns = "http://www.w3.org/2000/svg";
    var svg = document.createElementNS(ns, "svg");
    svg.setAttribute("class", "bird " + cls);
    svg.setAttribute("aria-hidden", "true");
    paintBird(svg, p);
    var use = document.createElementNS(ns, "use");
    use.setAttribute("href", "#bird");
    svg.appendChild(use);
    return svg;
  }
  function paintBird(svg, p) {
    svg.style.setProperty("--bird-body", p.color);
    svg.style.setProperty("--bird-dark", p.dark);
  }

  /* ---------- joining ---------- */
  function showJoin(msg) {
    el["p-join"].hidden = false;
    el["p-game"].hidden = true;
    el["p-me"].hidden = true;
    el["p-leave"].hidden = true;
    el["p-join-msg"].textContent = msg || "";
    if (me.name && !el["p-name"].value) el["p-name"].value = me.name;
  }

  function join(name) {
    el["p-join-btn"].disabled = true;
    return apiPost("/api/play/join", { pid: me.pid, name: name })
      .then(function (s) {
        me = { pid: s.me.pid, name: s.me.name };
        saveMe();
        render(s);
        startPolling();
      })
      .catch(function (e) { showJoin(e.message); })
      .then(function () { el["p-join-btn"].disabled = false; });
  }

  el["p-join-btn"].addEventListener("click", function () {
    var name = el["p-name"].value.trim();
    if (!name) { el["p-join-msg"].textContent = "Pick a name first."; return; }
    join(name);
  });
  el["p-name"].addEventListener("keydown", function (e) {
    if (e.key === "Enter") { e.preventDefault(); el["p-join-btn"].click(); }
  });
  el["p-leave"].addEventListener("click", function () {
    if (!confirm("Leave the flock?")) return;
    pollGen++;
    apiPost("/api/play/leave", { pid: me.pid }).catch(function () {});
    me = { name: me.name };
    saveMe();
    state = null;
    showJoin();
  });

  /* ---------- staying in sync ---------- */
  function startPolling() {
    var gen = ++pollGen;
    function poll(since) {
      var q = "/api/play/state?pid=" + encodeURIComponent(me.pid || "") + (since === null ? "" : "&since=" + since);
      apiGet(q)
        .then(function (s) {
          if (gen !== pollGen) return;
          if (!s.joined) {
            // The app restarted (or we were forgotten): rejoin under the same name.
            if (me.name) { join(me.name); } else { showJoin(); }
            return;
          }
          render(s);
          poll(s.version);
        })
        .catch(function () {
          if (gen === pollGen) setTimeout(function () { if (gen === pollGen) poll(null); }, 2000);
        });
    }
    poll(null);
  }

  // A phone that went to sleep may have a dead request hanging; start fresh on wake.
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "visible" && me.pid && state) startPolling();
  });

  /* ---------- rendering ---------- */
  var PANES = ["p-idle", "p-lobby", "p-vote", "p-verdict", "p-unveiling", "p-done", "p-solo"];
  function showPane(id) {
    PANES.forEach(function (p) { el[p].hidden = p !== id; });
  }

  function renderChips(list, players) {
    var before = (list.dataset.names || "").split("|");
    list.dataset.names = players.map(function (p) { return p.name; }).join("|");
    list.innerHTML = "";
    players.forEach(function (p) {
      var li = document.createElement("li");
      li.className = "flock-chip" + (p.name === me.name ? " is-me" : "") +
        (before.indexOf(p.name) === -1 ? " new" : ""); // only newcomers hop in
      li.appendChild(birdIcon(p, "chip-bird"));
      var name = document.createElement("span");
      name.textContent = p.name;
      li.appendChild(name);
      list.appendChild(li);
    });
  }

  function render(s) {
    state = s;
    if (soloActive) return; // they'll see the latest when they leave their own ranking
    el["p-join"].hidden = true;
    el["p-game"].hidden = false;
    el["p-leave"].hidden = false;

    el["p-me"].hidden = false;
    el["p-me"].innerHTML = "";
    el["p-me"].appendChild(birdIcon(s.me, "chip-bird"));
    el["p-me"].appendChild(document.createTextNode(s.me.name));

    var p = s.payload;
    switch (s.phase) {
      case "idle":
        showPane("p-idle");
        break;
      case "lobby":
        showPane("p-lobby");
        paintBird(el["p-lobby-bird"], s.me);
        el["p-lobby-category"].textContent = p.category;
        renderChips(el["p-lobby-players"], s.players);
        break;
      case "waiting":
      case "voting":
      case "deadlock":
        showPane("p-vote");
        renderVote(s);
        break;
      case "reveal":
        showPane("p-verdict");
        renderVerdict(s);
        break;
      case "done":
        if (!s.unveiled) { showPane("p-unveiling"); break; }
        showPane("p-done");
        renderDone(s);
        break;
    }
  }

  function renderVote(s) {
    var p = s.payload;
    var open = s.phase === "voting";
    if (open && buzzedRound !== s.round) {
      buzzedRound = s.round;
      // A little buzz when voting opens (browsers only allow it after a first tap).
      if (navigator.vibrate && navigator.userActivation && navigator.userActivation.hasBeenActive) navigator.vibrate(30);
    }
    el["p-category"].textContent = p.category + (p.mode === "quick" ? " · Top " + p.top_n : "");
    el["p-counter"].textContent = "Peck " + (p.comparisons + 1) + " / up to " + p.total_estimate;
    el["p-name-a"].textContent = p.a.name;
    el["p-name-b"].textContent = p.b.name;

    var mine = pendingChoice || s.my_vote;
    el["p-a"].classList.toggle("chosen", mine === "a");
    el["p-b"].classList.toggle("chosen", mine === "b");
    el["p-tie"].classList.toggle("chosen", mine === "tie");
    el["p-ring"].classList.toggle("has-choice", !!mine);
    el["p-ring"].classList.toggle("locked", !open);
    el["p-a"].disabled = el["p-b"].disabled = el["p-tie"].disabled = !open;

    var status;
    if (s.phase === "waiting") status = "Hold your squawks — the host will open voting in a moment.";
    else if (s.phase === "deadlock") status = "Deadlock! The host’s screen breaks the tie…";
    else if (mine) status = "Vote in ✓ — you can change it until everyone’s voted. (" + s.voted_count + " of " + Math.max(s.present_count, s.voted_count) + ")";
    else status = "Tap your pick. " + s.voted_count + " of " + Math.max(s.present_count, s.voted_count) + " voted so far.";
    el["p-vote-status"].textContent = status;
  }

  function vote(choice) {
    if (!state || state.phase !== "voting") return;
    pendingChoice = choice;
    renderVote(state);
    apiPost("/api/play/vote", { pid: me.pid, choice: choice, round: state.round })
      .then(function (s) { pendingChoice = null; render(s); })
      .catch(function (e) {
        pendingChoice = null;
        if (state) renderVote(state);
        el["p-vote-status"].textContent = e.message;
      });
  }
  el["p-a"].addEventListener("click", function () { vote("a"); });
  el["p-b"].addEventListener("click", function () { vote("b"); });
  el["p-tie"].addEventListener("click", function () { vote("tie"); });

  function renderVerdict(s) {
    var p = s.payload, c = s.result.counts, d = s.decided;
    var winner = d === "a" ? p.a.name : d === "b" ? p.b.name : null;
    var top = Math.max(c.a, c.b, c.tie);
    var hostBroke = ["a", "b", "tie"].filter(function (k) { return c[k] === top; }).length > 1;
    var total = c.a + c.b + c.tie;

    el["p-verdict-title"].textContent = winner ? winner + " wins!" : "It’s a tie!";
    var emoji, sub;
    if (!s.my_vote) { emoji = "🪶"; sub = "You sat this one out."; }
    else if (s.my_vote === d) {
      emoji = total > 1 && c[d] === total ? "🤝" : "🎉";
      sub = total > 1 && c[d] === total ? "Unanimous — the whole flock agreed." : "You sided with the flock.";
    } else { emoji = "🙃"; sub = hostBroke ? "The host broke the deadlock against you." : "Outvoted! You’re the odd bird out."; }
    if (hostBroke && s.my_vote === d) sub = "The host broke the deadlock your way.";
    el["p-verdict-emoji"].textContent = emoji;
    el["p-verdict-sub"].textContent = sub;
    el["p-verdict-tally"].textContent = p.a.name + " " + c.a + " · " + c.b + " " + p.b.name + (c.tie ? " · " + c.tie + " tie" : "");
  }

  /* ---------- results, and your own pecking order ---------- */
  var personal = null;     // this player's own ranking of the finished game (server view)
  var personalTid = null;  // which game `personal` belongs to
  var listChoice = null;   // "mine" | "flock": which list the results show
  var soloActive = false;  // ranking on their own; room updates wait until they're back
  var soloBusy = false;

  function renderDone(s) {
    var p = s.payload;
    if (personalTid !== s.tid) {
      personalTid = s.tid;
      personal = null;
      listChoice = null;
      apiGet("/api/play/personal?pid=" + encodeURIComponent(me.pid) + "&tid=" + encodeURIComponent(s.tid))
        .then(function (v) {
          if (personalTid !== s.tid) return;
          personal = v;
          if (state && state.phase === "done" && !soloActive) renderDone(state);
        })
        .catch(function () { /* the button still works */ });
    }

    el["p-done-category"].textContent = p.category;
    var flock = p.fun_stats && p.fun_stats.flock;
    var mine = flock && flock.voters.filter(function (v) { return v.name === me.name; })[0];
    el["p-done-me"].textContent = mine
      ? "You sided with the flock " + mine.agreed + " of " + mine.votes + " times."
      : "";

    var ownDone = !!(personal && personal.done);
    var which = ownDone ? (listChoice || "mine") : "flock";
    el["p-list-toggle"].hidden = !ownDone;
    Array.prototype.forEach.call(el["p-list-toggle"].children, function (b) {
      b.classList.toggle("active", b.dataset.list === which);
    });
    el["p-done-eyebrow"].textContent = which === "mine" ? "Your own pecking order" : "The flock’s pecking order";
    renderList(which === "mine" ? personal.standings : p.standings, which === "mine");

    el["p-own-cta"].hidden = ownDone;
    el["p-own-actions"].hidden = false;
    el["p-own-blurb"].textContent = personal
      ? "You’re partway through. Pick up where you left off."
      : "Rank the whole flock by your own taste. Your votes from this game fill in most of it, so it only takes a few more picks.";
    el["p-own-start"].textContent = personal ? "Keep going" : "Rank it my way";
    el["p-download"].textContent = ownDone ? "Download both as an image" : "Download as an image";
  }

  function renderList(rows, mine) {
    el["p-done-list"].innerHTML = "";
    rows.forEach(function (st) {
      var li = document.createElement("li");
      li.className = "standing-row" + (st.rank === 1 ? " rank-gold" : st.rank === 2 ? " rank-silver" : st.rank === 3 ? " rank-bronze" : "");
      var rank = document.createElement("span");
      rank.className = "standing-rank mono";
      rank.textContent = "#" + st.rank;
      var name = document.createElement("span");
      name.className = "standing-name";
      name.textContent = st.name;
      li.appendChild(rank); li.appendChild(name);
      if (mine) {
        // Where the flock put it, so you can see your hot takes
        var tag = document.createElement("span");
        tag.className = "standing-tag mono";
        tag.textContent = st.flock_rank ? "flock #" + st.flock_rank : "flock: unranked";
        if (st.flock_rank && st.flock_rank !== st.rank) tag.classList.add(st.flock_rank > st.rank ? "hot-up" : "hot-down");
        li.appendChild(tag);
      }
      el["p-done-list"].appendChild(li);
    });
  }

  Array.prototype.forEach.call(el["p-list-toggle"].children, function (b) {
    b.addEventListener("click", function () {
      listChoice = b.dataset.list;
      if (state) renderDone(state);
    });
  });

  el["p-own-start"].addEventListener("click", function () {
    el["p-own-start"].disabled = true;
    apiPost("/api/play/personal", { pid: me.pid, tid: personalTid })
      .then(function (v) {
        personal = v;
        if (v.done) finishSolo(); else { soloActive = true; renderSolo(true); }
      })
      .catch(function (e) { el["p-own-blurb"].textContent = e.message; })
      .then(function () { el["p-own-start"].disabled = false; });
  });

  function renderSolo(pop) {
    showPane("p-solo");
    var v = personal;
    el["p-solo-counter"].textContent = "Pick " + (v.comparisons + 1) + " / up to " + v.total_estimate;
    el["p-solo-note"].textContent = v.prefilled
      ? v.prefilled + (v.prefilled === 1 ? " pick" : " picks") + " already filled in from your votes."
      : "";
    el["p-solo-name-a"].textContent = v.a.name;
    el["p-solo-name-b"].textContent = v.b.name;
    if (pop) window.scrollTo(0, 0);
  }

  function soloVote(choice) {
    if (soloBusy || !personal || personal.done) return;
    soloBusy = true;
    apiPost("/api/play/personal/vote", { pid: me.pid, tid: personalTid, choice: choice })
      .then(function (v) {
        personal = v;
        if (v.done) finishSolo(); else renderSolo(false);
      })
      .catch(function (e) { el["p-solo-note"].textContent = e.message; })
      .then(function () { soloBusy = false; });
  }
  el["p-solo-a"].addEventListener("click", function () { soloVote("a"); });
  el["p-solo-b"].addEventListener("click", function () { soloVote("b"); });
  el["p-solo-tie"].addEventListener("click", function () { soloVote("tie"); });
  el["p-solo-back"].addEventListener("click", function () {
    soloActive = false;
    if (state) render(state);
  });

  function finishSolo() {
    soloActive = false;
    listChoice = "mine";
    window.popConfetti();
    if (state) render(state);
  }

  /* ---------- taking your results home ---------- */
  function slug(text) {
    return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "pecking-order";
  }

  function asText() {
    var p = state.payload;
    var lines = ["PECKING ORDER: " + p.category, new Date().toLocaleDateString(), ""];
    if (personal && personal.done) {
      lines.push("MY ORDER (" + me.name + ")");
      personal.standings.forEach(function (s) {
        lines.push(s.rank + ". " + s.name + (s.flock_rank ? "  (flock #" + s.flock_rank + ")" : ""));
      });
      lines.push("");
    }
    lines.push("THE FLOCK");
    p.standings.forEach(function (s) { lines.push(s.rank + ". " + s.name); });
    return lines.join("\n");
  }

  function flash(btn, msg) {
    var original = btn.textContent;
    btn.textContent = msg;
    setTimeout(function () { btn.textContent = original; }, 1500);
  }

  // Phones reach the app over plain http, where navigator.clipboard isn't
  // available, so fall back to the old select-and-copy trick.
  el["p-copy"].addEventListener("click", function () {
    var text = asText();
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(function () { flash(el["p-copy"], "Copied ✓"); });
      return;
    }
    var ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, text.length);
    var ok = false;
    try { ok = document.execCommand("copy"); } catch (e) { ok = false; }
    document.body.removeChild(ta);
    flash(el["p-copy"], ok ? "Copied ✓" : "Copy not supported");
  });

  el["p-download"].addEventListener("click", function () {
    var draw = function () { drawCard(); };
    if (document.fonts && document.fonts.load) {
      Promise.all([document.fonts.load("700 40px Fredoka"), document.fonts.load("700 30px Nunito")]).then(draw, draw);
    } else draw();
  });

  // A shareable card: your order next to the flock's (or just the flock's).
  function drawCard() {
    var p = state.payload;
    var own = personal && personal.done ? personal.standings : null;
    var cols = own ? [{ title: "🐣 " + me.name, rows: own }, { title: "🐦 The flock", rows: p.standings }]
      : [{ title: "🐦 The flock", rows: p.standings }];
    var W = 1080, PAD = 64, ROW = 76, TOP = 300;
    var rowsN = Math.max.apply(null, cols.map(function (c) { return c.rows.length; }));
    var H = TOP + rowsN * ROW + 140;
    var canvas = document.createElement("canvas");
    canvas.width = W; canvas.height = H;
    var ctx = canvas.getContext("2d");

    var bg = ctx.createLinearGradient(0, 0, 0, H);
    bg.addColorStop(0, "#D8EEFB");
    bg.addColorStop(Math.min(1, 460 / H), "#FFF8EC");
    bg.addColorStop(1, "#FFF8EC");
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);

    ctx.fillStyle = "#6E6378";
    ctx.font = "600 30px Fredoka, Nunito, sans-serif";
    ctx.fillText("Pecking Order", PAD, 92);
    ctx.fillStyle = "#3D3149";
    ctx.font = "700 64px Fredoka, Nunito, sans-serif";
    ctx.fillText(fit(ctx, p.category, W - PAD * 2), PAD, 168);
    ctx.fillStyle = "#B98A62";
    roundRect(ctx, PAD, 200, W - PAD * 2, 10, 5);
    ctx.fill();

    var colW = (W - PAD * 2 - (cols.length - 1) * 32) / cols.length;
    var MEDALS = { 1: "#D99A0B", 2: "#7D8496", 3: "#B86F35" };
    var TINTS = { 1: "#FFF1C4", 2: "#EEF0F6", 3: "#FBE4D2" };
    cols.forEach(function (c, ci) {
      var x = PAD + ci * (colW + 32);
      ctx.fillStyle = "#3D3149";
      ctx.font = "600 34px Fredoka, Nunito, sans-serif";
      ctx.fillText(fit(ctx, c.title, colW), x, TOP - 26);
      c.rows.forEach(function (s, i) {
        var y = TOP + i * ROW;
        ctx.fillStyle = TINTS[s.rank] || "#FFFFFF";
        roundRect(ctx, x, y, colW, ROW - 12, 22);
        ctx.fill();
        ctx.fillStyle = MEDALS[s.rank] || "#FFF3DF";
        ctx.beginPath();
        ctx.arc(x + 36, y + (ROW - 12) / 2, 24, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = MEDALS[s.rank] ? "#FFFFFF" : "#6E6378";
        ctx.font = "800 22px Nunito, sans-serif";
        ctx.textAlign = "center";
        ctx.fillText("#" + s.rank, x + 36, y + (ROW - 12) / 2 + 8);
        ctx.textAlign = "left";
        ctx.fillStyle = "#3D3149";
        ctx.font = "700 30px Nunito, sans-serif";
        ctx.fillText(fit(ctx, s.name, colW - 90), x + 74, y + (ROW - 12) / 2 + 10);
      });
    });

    ctx.fillStyle = "#8A7F94";
    ctx.font = "600 24px Nunito, sans-serif";
    ctx.fillText(new Date().toLocaleDateString(), PAD, H - 56);

    canvas.toBlob(function (blob) {
      var url = URL.createObjectURL(blob);
      var a = document.createElement("a");
      a.href = url;
      a.download = slug(p.category) + (own ? "-" + slug(me.name) : "") + ".png";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(function () { URL.revokeObjectURL(url); }, 10000);
    }, "image/png");
  }

  function fit(ctx, text, maxW) {
    if (ctx.measureText(text).width <= maxW) return text;
    while (text.length > 1 && ctx.measureText(text + "…").width > maxW) text = text.slice(0, -1);
    return text + "…";
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  /* ---------- boot ---------- */
  if (me.pid && me.name) { join(me.name); } else { showJoin(); }
})();
