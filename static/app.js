(function () {
  "use strict";

  /* ---------- tiny fetch helpers ---------- */
  function api(path, options) {
    return fetch(path, options).then(function (res) {
      if (!res.ok) return res.json().then(function (e) { throw new Error(e.error || res.statusText); });
      return res.json();
    });
  }
  function apiGet(path) { return api(path); }
  function apiPost(path, body) {
    return api(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) });
  }
  function apiDelete(path) { return api(path, { method: "DELETE" }); }

  /* ---------- local draft (roster being built, before a tournament exists server-side) ---------- */
  var DRAFT_KEY = "tt.draft";
  function loadDraft() {
    try {
      var raw = localStorage.getItem(DRAFT_KEY);
      var parsed = raw ? JSON.parse(raw) : null;
      return Object.assign({ category: "", roster: [], mode: "full", topN: 3, timer: "auto", voting: "screen" }, parsed || {});
    } catch (e) { return { category: "", roster: [], mode: "full", topN: 3, timer: "auto", voting: "screen" }; }
  }
  function saveDraft() {
    try { localStorage.setItem(DRAFT_KEY, JSON.stringify(draft)); } catch (e) { /* ignore */ }
  }

  var draft = loadDraft();
  var activeTournament = null; // last payload from /api/active or /api/tournaments
  var resultsSource = "live"; // "live" | "history"
  var historyCache = [];
  var currentRecord = null; // the results on screen, for Rematch / Replay

  /* ---------- element refs ---------- */
  var el = {};
  ["view-setup", "view-tournament", "view-results", "view-history",
   "resume-banner", "resume-title", "resume-sub", "btn-resume", "btn-discard",
   "input-category", "input-candidate", "btn-add", "add-msg",
   "btn-toggle-bulk", "bulk-area", "input-bulk", "btn-add-bulk",
   "roster-list", "roster-empty", "btn-begin",
   "mode-toggle", "mode-desc", "topn-row", "topn-toggle", "timer-toggle", "timer-desc", "voting-toggle", "voting-desc",
   "bout-category", "bout-counter", "progress-fill",
   "card-a", "name-a", "card-b", "name-b", "btn-tie", "btn-abandon", "ring",
   "debate-bar", "btn-start-debate", "debate-hint", "debate-clock", "debate-clock-time",
   "results-eyebrow", "results-category", "results-stat", "results-list", "btn-copy", "btn-pdf", "btn-new", "btn-back-history",
   "print-date",
   "fun-stats", "stats-footnote", "stat-tiles", "heaviest-list", "easiest-list",
   "history-list", "history-empty", "btn-back-setup", "btn-history", "btn-theme",
   "match-area", "tie-hint", "votes-a", "votes-b", "flock-list",
   "room-lobby", "lobby-category", "lobby-qr", "lobby-url", "lobby-lan-warning", "lobby-players", "lobby-empty", "btn-room-start",
   "flock-bar", "btn-flock-qr", "flock-status", "flock-clock", "flock-players",
   "room-controls", "room-status", "room-tie-voters", "room-tie-birds", "btn-room-close", "btn-room-next",
   "qr-dialog", "qr-dialog-code", "qr-dialog-url", "btn-qr-close",
   "btn-toggle-packs", "btn-clear-roster", "packs-area",
   "unveil", "unveil-category", "unveil-spotlight", "unveil-caption", "unveil-name", "podium", "unveil-tail",
   "btn-unveil-skip", "results-body", "btn-replay", "btn-rematch",
   "rematch-box", "rematch-title", "rematch-movers", "rematch-flips-title", "rematch-flips", "rematch-steady",
   "personal-box", "personal-grid"
  ].forEach(function (id) { el[id] = document.getElementById(id); });

  /* ---------- light / dark theme ---------- */
  var THEME_KEY = "po.theme";
  var systemDark = window.matchMedia("(prefers-color-scheme: dark)");
  function savedTheme() {
    try { return localStorage.getItem(THEME_KEY); } catch (e) { return null; }
  }
  function applyTheme(theme) {
    document.documentElement.setAttribute("data-theme", theme);
    el["btn-theme"].setAttribute("aria-label", theme === "dark" ? "Switch to light theme" : "Switch to dark theme");
    el["btn-theme"].title = theme === "dark" ? "Good morning! (light theme)" : "Good night! (dark theme)";
  }
  applyTheme(document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light");
  el["btn-theme"].addEventListener("click", function () {
    var next = document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark";
    try { localStorage.setItem(THEME_KEY, next); } catch (e) { /* ignore */ }
    applyTheme(next);
  });
  // Follow the OS setting until the user picks a theme themselves.
  systemDark.addEventListener("change", function (e) {
    if (savedTheme() !== "light" && savedTheme() !== "dark") applyTheme(e.matches ? "dark" : "light");
  });

  function showView(name) {
    ["view-setup", "view-tournament", "view-results", "view-history"].forEach(function (v) {
      document.getElementById(v).hidden = (v !== name);
    });
    el["btn-history"].hidden = (name === "view-history") || historyCache.length === 0;
    if (name !== "view-results") {
      unveilGen++;
      releasePhones(); // leaving mid-reveal shouldn't leave phones waiting
      stopPersonal();
    }
  }

  /* ---------- setup view ---------- */
  function estimateComparisons(n) {
    if (n < 2) return 0;
    var queue = new Array(n).fill(1);
    var total = 0;
    while (queue.length > 1) {
      var left = queue.shift(), right = queue.shift();
      total += left + right - 1;
      queue.push(left + right);
    }
    return total;
  }

  function estimateQuickComparisons(n, topN) {
    if (n < 2) return 0;
    topN = Math.max(1, Math.min(topN, n));
    var total = n - 1;
    var remaining = n - 1;
    for (var k = 0; k < topN - 1; k++) {
      var poolGuess = Math.max(2, Math.ceil(Math.log2(Math.max(remaining, 2))) + 1);
      total += poolGuess - 1;
      remaining -= 1;
    }
    return total;
  }

  function renderRoster() {
    el["roster-list"].innerHTML = "";
    el["roster-empty"].hidden = draft.roster.length > 0;
    el["btn-clear-roster"].hidden = draft.roster.length === 0;
    draft.roster.forEach(function (name, idx) {
      var li = document.createElement("li");
      li.className = "roster-row";
      var num = document.createElement("span");
      num.className = "roster-num mono";
      num.textContent = String(idx + 1).padStart(2, "0");
      var nameEl = document.createElement("span");
      nameEl.className = "roster-name";
      nameEl.textContent = name;
      var rm = document.createElement("button");
      rm.className = "roster-remove";
      rm.type = "button";
      rm.setAttribute("aria-label", "Remove " + name);
      rm.textContent = "✕";
      rm.addEventListener("click", function () {
        draft.roster.splice(idx, 1);
        saveDraft();
        renderRoster();
      });
      li.appendChild(num); li.appendChild(nameEl); li.appendChild(rm);
      el["roster-list"].appendChild(li);
    });
    renderModeControls();
  }

  function renderModeControls() {
    var n = draft.roster.length;
    Array.prototype.forEach.call(el["mode-toggle"].children, function (btn) {
      btn.classList.toggle("active", btn.dataset.mode === draft.mode);
    });
    Array.prototype.forEach.call(el["topn-toggle"].children, function (btn) {
      btn.classList.toggle("active", Number(btn.dataset.topn) === draft.topN);
    });
    Array.prototype.forEach.call(el["timer-toggle"].children, function (btn) {
      btn.classList.toggle("active", btn.dataset.timer === draft.timer);
    });
    Array.prototype.forEach.call(el["voting-toggle"].children, function (btn) {
      btn.classList.toggle("active", btn.dataset.voting === draft.voting);
    });
    el["voting-desc"].textContent = draft.voting === "phones"
      ? "Everyone joins by scanning a QR code and votes secretly on their own phone. Majority rules; the host breaks deadlocks."
      : "The group decides together and taps the winner on this screen.";
    el["timer-desc"].textContent = draft.timer === "manual"
      ? "Each matchup waits for you to press “Let them squawk” — great for songs or clips you need to listen to first. Stats only count squabble time."
      : "The clock starts as soon as each matchup appears.";
    el["topn-row"].hidden = draft.mode !== "quick";
    el["mode-desc"].textContent = draft.mode === "quick"
      ? "Finds just the top spot(s) without ranking everyone — much faster with a big list."
      : "Ranks every single candidate, 1st through last.";

    el["btn-begin"].disabled = n < 2;
    if (n < 2) { el["btn-begin"].textContent = "Let the Pecking Begin"; return; }
    if (draft.mode === "quick") {
      var topN = Math.min(draft.topN, n);
      var est = estimateQuickComparisons(n, topN);
      el["btn-begin"].textContent = "Find Top " + topN + " (up to " + est + " matchups)";
    } else {
      el["btn-begin"].textContent = "Let the Pecking Begin (up to " + estimateComparisons(n) + " matchups)";
    }
  }

  Array.prototype.forEach.call(el["mode-toggle"].children, function (btn) {
    btn.addEventListener("click", function () {
      draft.mode = btn.dataset.mode;
      saveDraft();
      renderModeControls();
    });
  });
  Array.prototype.forEach.call(el["timer-toggle"].children, function (btn) {
    btn.addEventListener("click", function () {
      draft.timer = btn.dataset.timer;
      saveDraft();
      renderModeControls();
    });
  });
  Array.prototype.forEach.call(el["voting-toggle"].children, function (btn) {
    btn.addEventListener("click", function () {
      draft.voting = btn.dataset.voting;
      saveDraft();
      renderModeControls();
    });
  });
  Array.prototype.forEach.call(el["topn-toggle"].children, function (btn) {
    btn.addEventListener("click", function () {
      draft.topN = Number(btn.dataset.topn);
      saveDraft();
      renderModeControls();
    });
  });

  function addCandidateName(name) {
    var trimmed = name.trim();
    if (!trimmed) return false;
    var dupe = draft.roster.some(function (n) { return n.toLowerCase() === trimmed.toLowerCase(); });
    if (dupe) { el["add-msg"].textContent = "“" + trimmed + "” is already on the roster."; return false; }
    draft.roster.push(trimmed);
    return true;
  }

  el["btn-add"].addEventListener("click", function () {
    el["add-msg"].textContent = "";
    if (addCandidateName(el["input-candidate"].value)) {
      el["input-candidate"].value = "";
      saveDraft();
      renderRoster();
    }
    el["input-candidate"].focus();
  });
  el["input-candidate"].addEventListener("keydown", function (e) {
    if (e.key === "Enter") { e.preventDefault(); el["btn-add"].click(); }
  });
  el["input-candidate"].addEventListener("input", function () { el["add-msg"].textContent = ""; });

  el["input-category"].value = draft.category || "";
  el["input-category"].addEventListener("input", function () {
    draft.category = el["input-category"].value;
    saveDraft();
  });

  /* ---------- flock packs ---------- */
  function renderPacks() {
    el["packs-area"].innerHTML = "";
    (window.FLOCK_PACKS || []).forEach(function (pack) {
      var b = document.createElement("button");
      b.type = "button";
      b.className = "pack-btn";
      var emoji = document.createElement("span");
      emoji.className = "pack-emoji";
      emoji.textContent = pack.emoji;
      var name = document.createElement("span");
      name.className = "pack-name";
      name.textContent = pack.name;
      var count = document.createElement("span");
      count.className = "pack-count";
      count.textContent = pack.items.length + " contenders";
      b.appendChild(emoji); b.appendChild(name); b.appendChild(count);
      b.addEventListener("click", function () {
        if (!draft.category.trim()) {
          draft.category = pack.name;
          el["input-category"].value = pack.name;
        }
        var added = 0;
        pack.items.forEach(function (n) { if (addCandidateName(n)) added++; });
        saveDraft();
        renderRoster();
        el["packs-area"].hidden = true;
        el["add-msg"].textContent = added ? "" : "Everything in " + pack.name + " is already in the flock.";
      });
      el["packs-area"].appendChild(b);
    });
  }
  renderPacks();
  el["btn-toggle-packs"].addEventListener("click", function () {
    el["packs-area"].hidden = !el["packs-area"].hidden;
  });
  el["btn-clear-roster"].addEventListener("click", function () {
    if (!confirm("Clear all " + draft.roster.length + " contenders from the flock?")) return;
    draft.roster = [];
    saveDraft();
    renderRoster();
  });

  el["btn-toggle-bulk"].addEventListener("click", function () {
    el["bulk-area"].hidden = !el["bulk-area"].hidden;
    if (!el["bulk-area"].hidden) el["input-bulk"].focus();
  });
  el["btn-add-bulk"].addEventListener("click", function () {
    var lines = el["input-bulk"].value.split("\n");
    var added = 0, skipped = 0;
    lines.forEach(function (line) {
      if (!line.trim()) return;
      if (addCandidateName(line)) added++; else skipped++;
    });
    el["input-bulk"].value = "";
    saveDraft();
    renderRoster();
    el["add-msg"].textContent = added
      ? ("Added " + added + (skipped ? (", skipped " + skipped + " duplicate/empty") : "") + ".")
      : "Nothing new to add.";
  });

  el["btn-begin"].addEventListener("click", function () {
    if (draft.roster.length < 2) return;
    apiPost("/api/tournaments", {
      category: draft.category || "Untitled Ranking",
      candidates: draft.roster,
      mode: draft.mode,
      top_n: draft.topN,
      manual_timer: draft.timer === "manual",
      phone_voting: draft.voting === "phones"
    })
      .then(function (payload) {
        draft.roster = [];
        draft.category = "";
        saveDraft();
        enterTournament(payload);
      })
      .catch(function (e) { el["add-msg"].textContent = e.message; });
  });

  function renderResumeBanner() {
    var has = activeTournament && !activeTournament.done;
    el["resume-banner"].hidden = !has;
    if (has) {
      var modeLabel = activeTournament.mode === "quick" ? "Quick · Top " + activeTournament.top_n : "Complete ranking";
      if (activeTournament.manual_timer) modeLabel += " · Manual timer";
      if (activeTournament.phone_voting) modeLabel += " · Phones";
      el["resume-title"].textContent = activeTournament.category || "Untitled Ranking";
      el["resume-sub"].textContent = modeLabel + " · Matchup " + (activeTournament.comparisons + 1) + " of up to " +
        activeTournament.total_estimate;
    }
  }
  el["btn-resume"].addEventListener("click", function () { enterTournament(activeTournament); });
  el["btn-discard"].addEventListener("click", function () {
    if (!confirm("Discard this unfinished game? This can’t be undone.")) return;
    apiPost("/api/tournaments/" + activeTournament.id + "/abandon", {}).then(function () {
      activeTournament = null;
      renderResumeBanner();
    });
  });

  el["btn-history"].addEventListener("click", function () { enterHistory(); });
  el["btn-back-setup"].addEventListener("click", function () { enterSetup(); });

  function enterSetup() {
    renderResumeBanner();
    renderRoster();
    showView("view-setup");
  }

  /* ---------- tournament view ---------- */
  var currentTid = null;
  var matchupShownAt = null; // timestamp the debate clock started, for "heaviest debate" stats
  var manualTimer = false;   // when true, the clock waits for "Start debate" instead of starting on render
  var clockInterval = null;
  var voting = false;        // guards against double-clicks sending two votes for one matchup

  function stopClock() {
    if (clockInterval) { clearInterval(clockInterval); clockInterval = null; }
  }

  function setVotingLocked(locked) {
    el["ring"].classList.toggle("locked", locked);
    el["card-a"].disabled = locked;
    el["card-b"].disabled = locked;
    el["btn-tie"].disabled = locked;
  }

  function startDebate() {
    matchupShownAt = Date.now();
    setVotingLocked(false);
    el["btn-start-debate"].hidden = true;
    el["debate-hint"].hidden = true;
    el["debate-clock"].hidden = false;
    el["debate-clock-time"].textContent = "0:00";
    stopClock();
    clockInterval = setInterval(function () {
      var sec = Math.floor((Date.now() - matchupShownAt) / 1000);
      el["debate-clock-time"].textContent = Math.floor(sec / 60) + ":" + String(sec % 60).padStart(2, "0");
    }, 250);
  }
  el["btn-start-debate"].addEventListener("click", function () {
    if (roomState) roomAction("squawk"); else startDebate();
  });

  function enterTournament(payload) {
    currentTid = payload.id;
    manualTimer = !!payload.manual_timer;
    if (payload.phone_voting && !payload.done) { enterRoom(payload.id); return; }
    setRoomMode(false);
    showView("view-tournament");
    renderMatchup(payload);
  }

  function renderMatchup(payload) {
    voting = false;
    stopClock();
    if (payload.done) { finishTournament(payload); return; }
    showMatchup(payload);
    el["debate-bar"].hidden = !manualTimer;
    if (manualTimer) {
      matchupShownAt = null;
      setVotingLocked(true);
      el["btn-start-debate"].hidden = false;
      el["debate-hint"].hidden = false;
      el["debate-clock"].hidden = true;
    } else {
      setVotingLocked(false);
      matchupShownAt = Date.now();
    }
  }

  // The parts of drawing a matchup shared by one-screen and phone voting.
  function showMatchup(payload) {
    var modeSuffix = payload.mode === "quick" ? " · Top " + payload.top_n : "";
    el["bout-category"].textContent = (payload.category || "") + modeSuffix;
    el["name-a"].textContent = payload.a.name;
    el["name-b"].textContent = payload.b.name;
    el["card-a"].dataset.id = payload.a.id;
    el["card-b"].dataset.id = payload.b.id;
    el["bout-counter"].textContent = "Peck " + (payload.comparisons + 1) + " / up to " + payload.total_estimate;
    var pct = payload.total_estimate > 0 ? Math.min(payload.comparisons / payload.total_estimate, 1) : 1;
    el["progress-fill"].style.width = (pct * 100).toFixed(1) + "%";
    el["card-a"].classList.remove("picked");
    el["card-b"].classList.remove("picked");
    // Restart the pop-in animation so each new matchup bounces in
    el["ring"].classList.remove("pop");
    void el["ring"].offsetWidth;
    el["ring"].classList.add("pop");
  }

  function castVote(choice) {
    if (roomState) { roomDecide(choice); return; }
    if (voting || (manualTimer && !matchupShownAt)) return;
    voting = true;
    if (choice !== "tie") el[choice === "a" ? "card-a" : "card-b"].classList.add("picked");
    var durationMs = matchupShownAt ? (Date.now() - matchupShownAt) : null;
    // Give the picked bird a moment to hop before the next matchup replaces it
    var hopDelay = new Promise(function (resolve) { setTimeout(resolve, choice === "tie" ? 0 : 280); });
    Promise.all([apiPost("/api/tournaments/" + currentTid + "/vote", { choice: choice, duration_ms: durationMs }), hopDelay])
      .then(function (results) { renderMatchup(results[0]); })
      .catch(function () { voting = false; });
  }
  el["card-a"].addEventListener("click", function () { castVote("a"); });
  el["card-b"].addEventListener("click", function () { castVote("b"); });
  el["btn-tie"].addEventListener("click", function () { castVote("tie"); });

  el["btn-abandon"].addEventListener("click", function () {
    if (!confirm("Fly the coop? This game’s progress will be discarded and you’ll return to setup.")) return;
    apiPost("/api/tournaments/" + currentTid + "/abandon", {}).then(function () {
      stopClock();
      leaveRoom();
      activeTournament = null;
      enterSetup();
    });
  });

  function finishTournament(record) {
    activeTournament = null;
    resultsSource = "live";
    renderResults(record);
    refreshHistory().then(function () {
      showView("view-results");
      unveil(record, true);
    });
  }

  /* ---------- phone voting (host side) ---------- */
  var roomState = null;     // latest /api/room state while a phone-voting game is on screen
  var roomPollGen = 0;      // bumped to cancel the long-poll loop
  var roomRound = null;     // the round currently drawn in the ring
  var autoNextTimer = null;
  var AUTO_NEXT_SECONDS = 5;
  var debateHintText = el["debate-hint"].textContent;

  function setRoomMode(on) {
    el["flock-bar"].hidden = !on;
    el["room-controls"].hidden = !on;
    if (on) return;
    el["room-lobby"].hidden = true;
    el["match-area"].hidden = false;
    el["btn-tie"].hidden = false;
    el["tie-hint"].hidden = false;
    el["debate-hint"].textContent = debateHintText;
    el["ring"].classList.remove("remote");
    ["votes-a", "votes-b", "room-tie-birds"].forEach(function (id) {
      el[id].innerHTML = "";
      delete el[id].dataset.key;
    });
    el["card-a"].classList.remove("lost");
    el["card-b"].classList.remove("lost");
  }

  function enterRoom(tid) {
    currentTid = tid;
    roomState = null;
    roomRound = null;
    setRoomMode(true);
    showView("view-tournament");
    var gen = ++roomPollGen;
    function poll(since) {
      apiGet("/api/room/" + tid + (since === null ? "" : "?since=" + since))
        .then(function (s) {
          if (gen !== roomPollGen) return;
          if (s.gone) { leaveRoom(); activeTournament = null; enterSetup(); return; }
          renderRoom(s);
          if (gen === roomPollGen) poll(roomState ? roomState.version : s.version);
        })
        .catch(function () {
          if (gen === roomPollGen) setTimeout(function () { poll(null); }, 2000);
        });
    }
    poll(null);
  }

  function leaveRoom() {
    roomPollGen++;
    roomState = null;
    clearAutoNext();
    stopClock();
    setRoomMode(false);
  }

  function roomAction(action, body) {
    if (!roomState) return;
    apiPost("/api/room/" + currentTid + "/" + action, Object.assign({ round: roomState.round }, body || {}))
      .then(renderRoom)
      .catch(function () { /* the long-poll will catch us up */ });
  }

  function hostCanDecide(s) {
    return s.phase === "deadlock" || (s.phase === "voting" && s.voted_count === 0 && s.present_count === 0);
  }

  function roomDecide(choice) {
    if (!roomState || !hostCanDecide(roomState)) return;
    if (choice !== "tie") el[choice === "a" ? "card-a" : "card-b"].classList.add("picked");
    roomAction("decide", { choice: choice });
  }

  el["btn-room-start"].addEventListener("click", function () { roomAction("start"); });
  el["btn-room-close"].addEventListener("click", function () { roomAction("close"); });
  el["btn-room-next"].addEventListener("click", function () { clearAutoNext(); roomAction("next"); });
  el["btn-flock-qr"].addEventListener("click", function () { el["qr-dialog"].showModal(); });
  el["btn-qr-close"].addEventListener("click", function () { el["qr-dialog"].close(); });

  function birdIcon(p, cls) {
    var ns = "http://www.w3.org/2000/svg";
    var svg = document.createElementNS(ns, "svg");
    svg.setAttribute("class", "bird " + cls);
    svg.setAttribute("aria-hidden", "true");
    svg.style.setProperty("--bird-body", p.color);
    svg.style.setProperty("--bird-dark", p.dark);
    var use = document.createElementNS(ns, "use");
    use.setAttribute("href", "#bird");
    svg.appendChild(use);
    return svg;
  }

  function renderChips(list, players, showVoted) {
    var before = (list.dataset.names || "").split("|");
    list.dataset.names = players.map(function (p) { return p.name; }).join("|");
    list.innerHTML = "";
    players.forEach(function (p) {
      var li = document.createElement("li");
      li.className = "flock-chip" + (showVoted ? (p.voted ? " voted" : " waiting") : "") +
        (before.indexOf(p.name) === -1 ? " new" : ""); // only newcomers hop in
      li.appendChild(birdIcon(p, "chip-bird"));
      var name = document.createElement("span");
      name.textContent = p.name;
      li.appendChild(name);
      if (showVoted && p.voted) {
        var tick = document.createElement("span");
        tick.className = "chip-tick";
        tick.textContent = "✓";
        li.appendChild(tick);
      }
      list.appendChild(li);
    });
  }

  // The little birds that land on a card once the vote closes.
  function renderBallots(container, ballots) {
    container.innerHTML = "";
    ballots.forEach(function (b, i) {
      var wrap = document.createElement("span");
      wrap.className = "ballot";
      wrap.style.animationDelay = (0.15 + i * 0.09) + "s";
      wrap.appendChild(birdIcon(b, "ballot-bird"));
      var name = document.createElement("span");
      name.className = "ballot-name";
      name.textContent = b.name;
      wrap.appendChild(name);
      container.appendChild(wrap);
    });
  }

  function setQr(s) {
    if (el["lobby-qr"].dataset.url === s.join_url) return;
    ["lobby-qr", "btn-flock-qr", "qr-dialog-code"].forEach(function (id) {
      el[id].innerHTML = s.qr_svg; // generated server-side from our own join URL
      el[id].dataset.url = s.join_url;
    });
    el["lobby-url"].textContent = s.join_url;
    el["qr-dialog-url"].textContent = s.join_url;
  }

  function renderLobby(s) {
    el["lobby-category"].textContent = s.payload.category;
    el["lobby-lan-warning"].hidden = s.lan;
    renderChips(el["lobby-players"], s.players, false);
    el["lobby-empty"].hidden = s.players.length > 0;
    var n = s.present_count;
    el["btn-room-start"].textContent = n
      ? "Start the pecking (" + n + (n === 1 ? " bird)" : " birds)")
      : "Start without phones";
  }

  // "3–1", winner's count first, with any tie votes noted.
  function tallyText(c, first) {
    var text = first === "b" ? c.b + "–" + c.a : c.a + "–" + c.b;
    return text + (c.tie ? " (" + c.tie + " for a tie)" : "");
  }

  function verdictText(s) {
    var c = s.result.counts, p = s.payload;
    var top = Math.max(c.a, c.b, c.tie);
    var hostBroke = ["a", "b", "tie"].filter(function (k) { return c[k] === top; }).length > 1;
    var name = s.decided === "a" ? p.a.name : s.decided === "b" ? p.b.name : null;
    if (hostBroke) return name ? "The host breaks the deadlock: " + name + " it is!" : "The host breaks the deadlock: it’s a tie.";
    if (c[s.decided] === c.a + c.b + c.tie && top > 1) {
      return name ? "Unanimous! " + name + " sweeps it " + top + "–0." : "Unanimous: birds of a feather, it’s a tie.";
    }
    return name ? "The flock picks " + name + ", " + tallyText(c, s.decided) + "." : "The flock calls it a tie.";
  }

  function startAutoNext(s) {
    if (autoNextTimer && autoNextTimer.round === s.round) return;
    clearAutoNext();
    var left = AUTO_NEXT_SECONDS;
    var base = s.finishing ? "See the final pecking order ▶" : "Next matchup ▶";
    function label() { el["btn-room-next"].textContent = base + " " + left; }
    label();
    var id = setInterval(function () {
      left--;
      if (left <= 0) { clearAutoNext(); roomAction("next"); return; }
      label();
    }, 1000);
    autoNextTimer = { id: id, round: s.round };
  }

  function clearAutoNext() {
    if (autoNextTimer) clearInterval(autoNextTimer.id);
    autoNextTimer = null;
  }

  function runFlockClock(elapsedMs) {
    stopClock();
    if (elapsedMs === null || elapsedMs === undefined) { el["flock-clock"].textContent = ""; return; }
    var startedAt = Date.now() - elapsedMs;
    function tick() {
      var sec = Math.floor((Date.now() - startedAt) / 1000);
      el["flock-clock"].textContent = "⏱ " + Math.floor(sec / 60) + ":" + String(sec % 60).padStart(2, "0");
    }
    tick();
    clockInterval = setInterval(tick, 250);
  }

  function renderRoom(s) {
    if (!s || (roomState && s.version < roomState.version)) return;
    roomState = s;
    if (s.phase === "done") { leaveRoom(); finishTournament(s.payload); return; }

    var lobby = s.phase === "lobby";
    el["room-lobby"].hidden = !lobby;
    el["match-area"].hidden = lobby;
    setQr(s);
    if (lobby) { renderLobby(s); return; }

    var p = s.payload;
    if (s.round !== roomRound) {
      roomRound = s.round;
      clearAutoNext();
      showMatchup(p);
      el["card-a"].classList.remove("lost");
      el["card-b"].classList.remove("lost");
    }

    var canDecide = hostCanDecide(s);
    el["ring"].classList.toggle("locked", s.phase === "waiting");
    el["ring"].classList.toggle("remote", !canDecide && s.phase !== "waiting");
    el["card-a"].disabled = el["card-b"].disabled = el["btn-tie"].disabled = !canDecide;
    el["btn-tie"].hidden = el["tie-hint"].hidden = !canDecide;

    el["debate-bar"].hidden = s.phase !== "waiting";
    el["btn-start-debate"].hidden = false;
    el["debate-hint"].hidden = false;
    el["debate-hint"].textContent = "Phones stay locked until the squawking starts.";
    el["debate-clock"].hidden = true;
    runFlockClock(s.elapsed_ms);

    // Who's here, and (only while voting) who has voted -- never what they voted.
    renderChips(el["flock-players"], s.players, s.phase === "voting");
    var status;
    if (s.phase === "waiting") status = "Waiting for the squawking to start";
    else if (s.phase === "voting") {
      status = s.present_count === 0 ? "No phones have joined yet"
        : s.voted_count === 0 ? "Voting is open on everyone’s phone"
        : s.voted_count + " of " + Math.max(s.present_count, s.voted_count) + " voted";
    } else status = "The votes are in";
    el["flock-status"].textContent = status;

    var counts = s.result && s.result.counts;
    var ballots = s.result ? s.result.ballots : [];
    function pick(choice) { return ballots.filter(function (b) { return b.choice === choice; }); }
    renderOnce(el["votes-a"], s, pick("a"));
    renderOnce(el["votes-b"], s, pick("b"));
    var ties = pick("tie");
    el["room-tie-voters"].hidden = ties.length === 0;
    renderOnce(el["room-tie-birds"], s, ties);

    var text = "";
    if (s.phase === "voting") {
      text = s.present_count === 0
        ? "Nobody has joined on a phone yet, so tap the winner here — or tap the QR code to let people join."
        : "Ballots stay secret until everyone has voted.";
    } else if (s.phase === "deadlock") {
      text = "Deadlock, " + tallyText(counts, "a") + "! Squabble it out, then tap the winner on this screen.";
    } else if (s.phase === "reveal") {
      text = verdictText(s);
    }
    el["room-status"].textContent = text;
    el["room-status"].classList.toggle("verdict", s.phase === "reveal" || s.phase === "deadlock");
    el["btn-room-close"].hidden = !(s.phase === "voting" && s.voted_count > 0);
    el["btn-room-next"].hidden = s.phase !== "reveal";

    if (s.phase === "reveal") {
      if (s.decided !== "tie") {
        el[s.decided === "a" ? "card-a" : "card-b"].classList.add("picked");
        el[s.decided === "a" ? "card-b" : "card-a"].classList.add("lost");
      }
      startAutoNext(s);
    }
  }

  // Ballot birds only animate in once per round, not on every refresh.
  function renderOnce(container, s, ballots) {
    var key = s.round + ":" + ballots.map(function (b) { return b.name; }).join(",");
    if (container.dataset.key === key) return;
    container.dataset.key = key;
    renderBallots(container, ballots);
  }

  /* ---------- the dramatic reveal ---------- */
  var unveilGen = 0;        // bumped to cancel a reveal in progress
  var unveilRecord = null;
  var unveilLive = false;
  // Gold, silver and bronze birds for the podium
  var PODIUM_COLORS = [["#F5B83D", "#D3961D"], ["#AEB5C6", "#858DA0"], ["#E09A63", "#B86F35"]];

  function ordinal(rank) {
    return ["first", "second", "third"][rank - 1] || "#" + rank;
  }

  function buildPodium(standings) {
    el["podium"].innerHTML = "";
    [1, 0, 2].filter(function (i) { return i < standings.length; }).forEach(function (i) {
      var col = document.createElement("div");
      col.className = "podium-col place-" + (i + 1);
      col.dataset.idx = i;
      var crown = document.createElement("span");
      crown.className = "podium-crown";
      crown.textContent = i === 0 ? "👑" : "";
      col.appendChild(crown);
      col.appendChild(birdIcon({ color: PODIUM_COLORS[i][0], dark: PODIUM_COLORS[i][1] }, "podium-bird" + (i === 1 ? " bird-flip" : "")));
      var name = document.createElement("div");
      name.className = "podium-name";
      col.appendChild(name);
      var step = document.createElement("div");
      step.className = "podium-step mono";
      step.textContent = "#" + standings[i].rank;
      col.appendChild(step);
      el["podium"].appendChild(col);
    });
  }

  function revealPodium(i) {
    var col = el["podium"].querySelector('[data-idx="' + i + '"]');
    if (!col || col.classList.contains("revealed")) return;
    col.querySelector(".podium-name").textContent = unveilRecord.standings[i].name;
    col.classList.add("revealed");
  }

  function addTail(s) {
    var li = document.createElement("li");
    li.className = "tail-row";
    var rank = document.createElement("span");
    rank.className = "standing-rank mono";
    rank.textContent = "#" + s.rank;
    var name = document.createElement("span");
    name.className = "standing-name";
    name.textContent = s.name;
    li.appendChild(rank); li.appendChild(name);
    el["unveil-tail"].insertBefore(li, el["unveil-tail"].firstChild); // revealed bottom-up, read top-down
  }

  function setCaption(text, drumroll) {
    el["unveil-caption"].textContent = text;
    el["unveil-name"].textContent = "";
    el["unveil-name"].classList.remove("pop");
    el["unveil-spotlight"].classList.toggle("drumroll", !!drumroll);
  }

  function setSpotlightName(text) {
    el["unveil-spotlight"].classList.remove("drumroll");
    el["unveil-name"].textContent = text;
    el["unveil-name"].classList.remove("pop");
    void el["unveil-name"].offsetWidth;
    el["unveil-name"].classList.add("pop");
  }

  function runSteps(steps, gen) {
    var i = 0;
    (function next() {
      if (gen !== unveilGen || i >= steps.length) return;
      var step = steps[i++];
      setTimeout(function () {
        if (gen !== unveilGen) return;
        step.fn();
        next();
      }, step.wait);
    })();
  }

  // Reveal the standings from last place up to first, ending on a podium.
  function unveil(record, live) {
    var gen = ++unveilGen;
    var st = record.standings;
    unveilRecord = record;
    unveilLive = live;
    el["unveil"].hidden = false;
    el["unveil"].classList.remove("settled");
    el["results-body"].hidden = true;
    el["unveil-spotlight"].hidden = false;
    el["unveil-tail"].hidden = false;
    el["unveil-tail"].innerHTML = "";
    el["btn-unveil-skip"].hidden = false;
    el["unveil-category"].textContent = record.category;
    buildPodium(st);
    setCaption("", false);
    window.scrollTo(0, 0);

    // Group tied contenders so they're revealed together, last place first.
    var groups = [];
    st.forEach(function (s, i) {
      var g = groups[groups.length - 1];
      if (g && g.rank === s.rank) g.idxs.push(i); else groups.push({ rank: s.rank, idxs: [i] });
    });
    groups.reverse();
    var tail = groups.filter(function (g) { return g.idxs[0] >= 3; });
    var podium = groups.filter(function (g) { return g.idxs[0] < 3; });

    var steps = [{ wait: 200, fn: function () { setCaption("Drumroll, please…", true); } }];
    // The rest of the flock settles quickly (a few seconds, however long the list)...
    var tailWait = tail.length ? Math.max(250, Math.min(800, 3500 / tail.length)) : 0;
    tail.forEach(function (g, k) {
      steps.push({
        wait: k === 0 ? 1500 : tailWait,
        fn: function () {
          if (k === 0) setCaption("Settling the rest of the flock…", false);
          g.idxs.forEach(function (i) { addTail(st[i]); });
        }
      });
    });
    // ...then the podium, one place at a time, with a long pause for the winner.
    podium.forEach(function (g) {
      var top = g.rank === 1;
      steps.push({
        wait: tail.length || g !== podium[0] ? 1300 : 1500,
        fn: function () {
          setCaption(top ? "And top of the roost is…" : (g.idxs.length > 1 ? "Tied for " : "In ") + ordinal(g.rank) + " place…", true);
        }
      });
      steps.push({
        wait: top ? 2600 : 1600,
        fn: function () {
          setSpotlightName(g.idxs.map(function (i) { return st[i].name; }).join(" & "));
          g.idxs.forEach(function (i) { if (i < 3) revealPodium(i); else addTail(st[i]); });
          if (top) window.popConfetti();
        }
      });
    });
    steps.push({ wait: 2200, fn: function () { finishUnveil(); } });
    runSteps(steps, gen);
  }

  function finishUnveil() {
    unveilGen++;
    if (!unveilRecord) return;
    unveilRecord.standings.slice(0, 3).forEach(function (_, i) { revealPodium(i); });
    el["unveil"].classList.add("settled");
    el["unveil-spotlight"].hidden = true;
    el["unveil-tail"].hidden = true;
    el["btn-unveil-skip"].hidden = true;
    el["results-body"].hidden = false;
    releasePhones();
  }

  // Phones keep the results hidden until the big screen has shown them.
  function releasePhones() {
    if (unveilLive && unveilRecord && unveilRecord.phone_voting) {
      apiPost("/api/room/" + unveilRecord.id + "/unveiled", {}).catch(function () { /* phones stop waiting on their own */ });
    }
    unveilLive = false;
  }
  el["btn-unveil-skip"].addEventListener("click", finishUnveil);

  function showResultsPlain() {
    unveilGen++;
    el["unveil"].hidden = true;
    el["results-body"].hidden = false;
  }

  /* ---------- rematch ---------- */
  function renderRematch(rm) {
    el["rematch-box"].hidden = !rm;
    if (!rm) return;
    el["rematch-title"].textContent = "🔁 Rematch: what changed since " +
      (rm.previous_date ? new Date(rm.previous_date).toLocaleDateString() : "last time");
    el["rematch-movers"].innerHTML = "";
    rm.movers.forEach(function (m) {
      var li = document.createElement("li");
      var name = document.createElement("span");
      name.className = "debate-pair";
      name.textContent = "#" + m.now + "  " + m.name;
      var delta = document.createElement("span");
      delta.className = "mover-delta mono";
      if (m.delta === null) { delta.textContent = "new up here"; delta.classList.add("new"); }
      else if (m.delta > 0) { delta.textContent = "▲ " + m.delta + " (was #" + m.before + ")"; delta.classList.add("up"); }
      else if (m.delta < 0) { delta.textContent = "▼ " + (-m.delta) + " (was #" + m.before + ")"; delta.classList.add("down"); }
      else { delta.textContent = "same spot"; }
      li.appendChild(name); li.appendChild(delta);
      el["rematch-movers"].appendChild(li);
    });
    el["rematch-flips"].innerHTML = "";
    el["rematch-flips-title"].hidden = rm.flipped.length === 0;
    rm.flipped.forEach(function (f) {
      var li = document.createElement("li");
      var pair = document.createElement("span");
      pair.className = "debate-pair";
      pair.textContent = f.a + " vs " + f.b;
      var change = document.createElement("span");
      change.className = "debate-duration";
      change.textContent = (f.before === "tie" ? "a tie" : f.before) + " → " + (f.now === "tie" ? "a tie" : f.now);
      li.appendChild(pair); li.appendChild(change);
      el["rematch-flips"].appendChild(li);
    });
    el["rematch-steady"].textContent = !rm.shared_calls ? "No matchups came up both times."
      : rm.flipped.length ? rm.same_calls + " of " + rm.shared_calls + " repeat matchups went the same way."
      : "All " + rm.shared_calls + " repeat matchups went the same way. What a consistent flock!";
  }

  el["btn-rematch"].addEventListener("click", function () {
    if (!currentRecord) return;
    apiPost("/api/tournaments/" + currentRecord.id + "/rematch", {})
      .then(function (payload) { enterTournament(payload); })
      .catch(function (e) { alert(e.message); });
  });
  el["btn-replay"].addEventListener("click", function () {
    if (currentRecord) unveil(currentRecord, false);
  });

  /* ---------- everyone's own pecking order (phone games) ---------- */
  var personalTimer = null;

  function stopPersonal() {
    if (personalTimer) clearInterval(personalTimer);
    personalTimer = null;
  }

  // Players finish their own rankings on their phones after the game, so keep checking.
  function watchPersonal(record) {
    stopPersonal();
    el["personal-box"].hidden = !record.phone_voting;
    el["personal-grid"].innerHTML = "";
    delete el["personal-grid"].dataset.key;
    if (!record.phone_voting) return;
    function load() {
      apiGet("/api/tournaments/" + record.id + "/personal").then(renderPersonal).catch(function () {});
    }
    load();
    personalTimer = setInterval(load, 5000);
  }

  function renderPersonal(list) {
    var key = JSON.stringify(list);
    if (el["personal-grid"].dataset.key === key) return;
    el["personal-grid"].dataset.key = key;
    el["personal-grid"].innerHTML = "";
    if (!list.length) {
      var empty = document.createElement("p");
      empty.className = "text-faint";
      empty.textContent = "Nobody has started theirs yet. It’s waiting on the results screen of every phone.";
      el["personal-grid"].appendChild(empty);
      return;
    }
    list.forEach(function (p) {
      var card = document.createElement("div");
      card.className = "personal-card";
      var name = document.createElement("div");
      name.className = "personal-name";
      name.textContent = p.name;
      card.appendChild(name);
      if (!p.done) {
        var busy = document.createElement("p");
        busy.className = "text-faint";
        busy.textContent = "Still pecking…";
        card.appendChild(busy);
      } else {
        var ol = document.createElement("ol");
        ol.className = "personal-list";
        p.standings.slice(0, 5).forEach(function (s) {
          var li = document.createElement("li");
          var rank = document.createElement("span");
          rank.className = "mono personal-rank";
          rank.textContent = "#" + s.rank;
          li.appendChild(rank);
          li.appendChild(document.createTextNode(s.name));
          ol.appendChild(li);
        });
        card.appendChild(ol);
        if (p.standings.length > 5) {
          var more = document.createElement("p");
          more.className = "text-faint personal-more";
          more.textContent = "…and " + (p.standings.length - 5) + " more";
          card.appendChild(more);
        }
        var match = document.createElement("p");
        match.className = "personal-match";
        match.textContent = "Matched the flock on " + p.matches + " of " + p.total + " spots";
        card.appendChild(match);
      }
      el["personal-grid"].appendChild(card);
    });
  }

  /* ---------- results view ---------- */
  function renderResults(record) {
    currentRecord = record;
    showResultsPlain();
    var isQuick = record.mode === "quick";
    el["results-eyebrow"].textContent = isQuick ? "Top " + record.top_n + " of the pecking order" : "The final pecking order";
    el["results-category"].textContent = record.category;
    el["results-stat"].textContent = isQuick
      ? ("Top " + record.standings.length + " of " + record.total_candidates + " candidates · decided in " +
         record.comparisons + " matchups")
      : (record.standings.length + " contenders · decided in " + record.comparisons + " head-to-head matchups");
    el["results-list"].innerHTML = "";
    var seen = {};
    record.standings.forEach(function (s) { seen[s.rank] = (seen[s.rank] || 0) + 1; });
    record.standings.forEach(function (s) {
      var li = document.createElement("li");
      li.className = "standing-row" + (s.rank === 1 ? " rank-gold" : s.rank === 2 ? " rank-silver" : s.rank === 3 ? " rank-bronze" : "");
      var rank = document.createElement("span");
      rank.className = "standing-rank mono";
      rank.textContent = "#" + s.rank;
      var name = document.createElement("span");
      name.className = "standing-name";
      name.textContent = s.name;
      li.appendChild(rank); li.appendChild(name);
      if (s.rank === 1) {
        var roost = document.createElement("span");
        roost.className = "roost-tag";
        roost.textContent = "👑 Top of the roost";
        li.appendChild(roost);
      }
      if (seen[s.rank] > 1) {
        var tag = document.createElement("span");
        tag.className = "standing-tag";
        tag.textContent = "Tie";
        li.appendChild(tag);
      }
      el["results-list"].appendChild(li);
    });
    renderFunStats(record.fun_stats, !!record.manual_timer);
    el["btn-back-history"].hidden = resultsSource !== "history";
    el["btn-new"].hidden = resultsSource === "history";
    el["btn-replay"].hidden = record.standings.length < 2;
    renderRematch(record.rematch);
    watchPersonal(record);
    el["btn-copy"].dataset.category = record.category;
    el["print-date"].textContent = record.date ? new Date(record.date).toLocaleDateString() : new Date().toLocaleDateString();
  }

  function formatDuration(ms) {
    if (ms === null || ms === undefined) return "—";
    var totalSec = Math.round(ms / 1000);
    if (totalSec < 60) return totalSec + "s";
    var m = Math.floor(totalSec / 60), s = totalSec % 60;
    return m + "m " + String(s).padStart(2, "0") + "s";
  }

  function renderDebateList(container, title, items) {
    container.innerHTML = "";
    var h = document.createElement("div");
    h.className = "debate-list-title";
    h.textContent = title;
    container.appendChild(h);
    if (!items.length) {
      var empty = document.createElement("p");
      empty.className = "text-faint";
      empty.textContent = "Not enough timed matchups yet.";
      container.appendChild(empty);
      return;
    }
    var ol = document.createElement("ol");
    ol.className = "debate-list";
    items.forEach(function (m) {
      var li = document.createElement("li");
      var pair = document.createElement("span");
      pair.className = "debate-pair";
      pair.textContent = m.a + " vs " + m.b + (m.choice === "tie" ? " (tie)" : "") + (m.split ? " · " + m.split : "");
      var dur = document.createElement("span");
      dur.className = "debate-duration mono";
      dur.textContent = formatDuration(m.duration_ms);
      li.appendChild(pair); li.appendChild(dur);
      ol.appendChild(li);
    });
    container.appendChild(ol);
  }

  function renderFunStats(stats, manual) {
    if (!stats || stats.matchup_count === 0) { el["fun-stats"].hidden = true; return; }
    el["fun-stats"].hidden = false;

    var tiles = [{ label: manual ? "Total squabble time" : "Total deliberation time", value: formatDuration(stats.total_duration_ms) }];
    if (stats.hot_streak) {
      tiles.push({
        label: "Hot streak",
        value: stats.hot_streak.names.join(" & ") + " — " + stats.hot_streak.streak + " wins in a row"
      });
    }
    if (stats.most_contested) {
      tiles.push({
        label: "Most contested",
        value: stats.most_contested.names.join(" & ") + " — " + stats.most_contested.matchups + " matchups"
      });
    }
    if (stats.tie_count > 0) {
      tiles.push({ label: "Birds of a feather", value: stats.tie_count + (stats.tie_count === 1 ? " tie" : " ties") });
    }
    var flock = stats.flock;
    if (flock) {
      if (flock.voice_of_the_flock) {
        tiles.push({ label: "Voice of the flock", value: flock.voice_of_the_flock.names.join(" & ") + " — sided with the majority " + pct(flock.voice_of_the_flock.rate) });
      }
      if (flock.contrarian) {
        tiles.push({ label: "Odd bird out", value: flock.contrarian.names.join(" & ") + " — with the majority only " + pct(flock.contrarian.rate) });
      }
      if (flock.kindred_spirits) {
        tiles.push({ label: "Two of a feather", value: flock.kindred_spirits.names.join(" & ") + " — voted alike " + pct(flock.kindred_spirits.rate) });
      }
      if (flock.unanimous > 0) {
        tiles.push({ label: "Unanimous calls", value: flock.unanimous + " of " + flock.matchups });
      }
      if (flock.deadlocks > 0) {
        tiles.push({ label: "Deadlocks the host broke", value: String(flock.deadlocks) });
      }
      if (flock.fence_sitter) {
        tiles.push({ label: "Fence sitter", value: flock.fence_sitter.name + " — voted tie " + flock.fence_sitter.ties + " times" });
      }
    }

    el["stat-tiles"].innerHTML = "";
    tiles.forEach(function (t) {
      var tile = document.createElement("div");
      tile.className = "stat-tile";
      var label = document.createElement("div");
      label.className = "stat-tile-label";
      label.textContent = t.label;
      var value = document.createElement("div");
      value.className = "stat-tile-value";
      value.textContent = t.value;
      tile.appendChild(label); tile.appendChild(value);
      el["stat-tiles"].appendChild(tile);
    });

    renderDebateList(el["heaviest-list"], "🪶 Biggest squabbles", stats.heaviest_debates);
    el["stats-footnote"].textContent = manual
      ? "Timed from when you pressed “Let them squawk” to when you voted — listening time isn’t counted."
      : "Timed from when a matchup appears to when you vote — so a bathroom break might sneak into “biggest squabbles.”";
    renderDebateList(el["easiest-list"], "🌱 Easiest calls", stats.easiest_calls);
    renderFlockList(flock);
  }

  function pct(rate) { return Math.round(rate * 100) + "%"; }

  function renderFlockList(flock) {
    var box = el["flock-list"];
    box.hidden = !flock;
    box.innerHTML = "";
    if (!flock) return;
    var h = document.createElement("div");
    h.className = "debate-list-title";
    h.textContent = "🐦 Who sided with the flock";
    box.appendChild(h);
    var ol = document.createElement("ol");
    ol.className = "debate-list";
    flock.voters.forEach(function (v) {
      var li = document.createElement("li");
      var name = document.createElement("span");
      name.className = "debate-pair";
      name.textContent = v.name;
      var rate = document.createElement("span");
      rate.className = "debate-duration mono";
      rate.textContent = v.agreed + " of " + v.votes + " · " + pct(v.agreed / v.votes);
      li.appendChild(name); li.appendChild(rate);
      ol.appendChild(li);
    });
    box.appendChild(ol);
  }

  el["btn-new"].addEventListener("click", function () { enterSetup(); });
  el["btn-back-history"].addEventListener("click", function () { enterHistory(); });
  el["btn-copy"].addEventListener("click", function () {
    var cat = el["results-category"].textContent;
    var lines = ["PECKING ORDER — " + cat, new Date().toLocaleDateString(), ""];
    Array.prototype.forEach.call(el["results-list"].children, function (li) {
      var rank = li.querySelector(".standing-rank").textContent.replace("#", "");
      var name = li.querySelector(".standing-name").textContent;
      lines.push(rank + ". " + name);
    });
    var text = lines.join("\n");
    var original = el["btn-copy"].textContent;
    function flash(msg) {
      el["btn-copy"].textContent = msg;
      setTimeout(function () { el["btn-copy"].textContent = original; }, 1500);
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { flash("Copied ✓"); }).catch(function () { flash("Copy failed"); });
    } else {
      flash("Copy not supported");
    }
  });

  el["btn-pdf"].addEventListener("click", function () {
    var cat = el["results-category"].textContent || "Pecking Order";
    var originalTitle = document.title;
    document.title = cat.replace(/[\\/:*?"<>|]/g, "").trim() || "Pecking Order Results";
    window.print();
    document.title = originalTitle;
  });

  /* ---------- history view ---------- */
  function refreshHistory() {
    return apiGet("/api/history").then(function (rows) {
      historyCache = rows;
      el["btn-history"].hidden = historyCache.length === 0;
      return rows;
    });
  }

  function enterHistory() {
    el["history-list"].innerHTML = "";
    el["history-empty"].hidden = historyCache.length > 0;
    historyCache.forEach(function (record) {
      var li = document.createElement("li");
      li.className = "history-row";
      var btn = document.createElement("button");
      btn.className = "history-row-btn";
      btn.type = "button";
      var nameSpan = document.createElement("span");
      nameSpan.className = "history-name";
      nameSpan.textContent = record.category;
      var metaWrap = document.createElement("span");
      metaWrap.style.display = "flex";
      metaWrap.style.alignItems = "center";
      metaWrap.style.gap = "8px";
      var modeTag = document.createElement("span");
      modeTag.className = "mode-tag";
      modeTag.textContent = record.mode === "quick" ? "Top " + record.top_n : "Full";
      var metaSpan = document.createElement("span");
      metaSpan.className = "history-meta mono";
      metaSpan.textContent = record.standings.length + " · " + (record.date ? new Date(record.date).toLocaleDateString() : "");
      metaWrap.appendChild(modeTag); metaWrap.appendChild(metaSpan);
      btn.appendChild(nameSpan); btn.appendChild(metaWrap);
      btn.addEventListener("click", function () {
        resultsSource = "history";
        renderResults(record);
        showView("view-results");
      });
      var del = document.createElement("button");
      del.className = "history-del";
      del.type = "button";
      del.setAttribute("aria-label", "Delete " + record.category);
      del.textContent = "✕";
      del.addEventListener("click", function () {
        if (!confirm("Delete “" + record.category + "” from history?")) return;
        apiDelete("/api/tournaments/" + record.id).then(function () {
          refreshHistory().then(enterHistory);
        });
      });
      li.appendChild(btn); li.appendChild(del);
      el["history-list"].appendChild(li);
    });
    showView("view-history");
  }

  /* ---------- boot ---------- */
  Promise.all([
    apiGet("/api/active").catch(function () { return null; }),
    refreshHistory().catch(function () { return []; })
  ]).then(function (results) {
    activeTournament = results[0];
    renderResumeBanner();
    renderRoster();
    el["btn-history"].hidden = historyCache.length === 0;
    showView("view-setup");
  });
})();
