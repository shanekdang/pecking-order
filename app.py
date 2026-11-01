"""Pecking Order -- local web app.

Run with:   python app.py
Then open:  http://127.0.0.1:5000

Everything runs on your own machine: Flask serves the page, votes are sent
to a small JSON API, and results are stored in data/tournaments.db
(SQLite, created automatically). No account, no hosting, nothing leaves
your local network.

Two modes share the same API shape (advance -> comparison -> vote -> repeat
-> standings), just backed by different engines:
  "full"  -- Tournament: ranks every candidate (tournament.py)
  "quick" -- QuickTournament: finds just the top N, far fewer comparisons

And two ways to vote:
  one screen -- the group decides together and clicks a card
  phones     -- everyone votes on their own phone and the majority decides
                (room.py). Phones on the same Wi-Fi reach /play; everything
                else stays restricted to this computer (see _host_only).

Every vote is also appended to a vote log (timestamped from when the
matchup appeared to when it was decided) so results can show fun stats --
heaviest debates, easiest calls, streaks, and with phones, who agreed with
whom -- via stats.py. With the manual debate timer on, the clock instead
starts when the group presses "Start debate" (e.g. after listening to two
songs), so the stats measure only the debate.

After a game: a rematch replays the same flock and compares the two runs
(stats.compare_runs), and in phone games each player can build their own
ranking from their votes (personal.py).
"""
from __future__ import annotations

import argparse
import json

from flask import Flask, jsonify, redirect, render_template, request

import lan
import personal
import room
import storage
from stats import compare_runs, compute_fun_stats
from tournament import QuickTournament, Tournament

app = Flask(__name__)
app.config["LAN"] = False  # set when run directly: whether phones can reach us at all
storage.init_db()

_own_addresses = lan.own_addresses()
PLAYER_PATHS = ("/play", "/api/play/", "/static/")


@app.before_request
def _host_only():
    """Phones on the network may only reach the player pages; everything
    else (setup, history, deleting games...) belongs to this computer."""
    global _own_addresses
    if request.path.startswith(PLAYER_PATHS) or request.remote_addr in _own_addresses:
        return None
    _own_addresses = lan.own_addresses()  # the network may have changed since startup
    if request.remote_addr in _own_addresses:
        return None
    if request.path == "/":
        return redirect("/play")
    return jsonify({"error": "Only the host computer can do that."}), 403


def _load_engine(row: dict):
    """Reconstruct the right engine class for a stored row."""
    data = json.loads(row["engine_json"])
    if row["mode"] == "quick":
        return QuickTournament.from_dict(data)
    return Tournament.from_dict(data)


def _result_order(t) -> list[str]:
    """The engine-specific list of candidate ids in final order."""
    return t.placed if isinstance(t, QuickTournament) else t.final_order


def _standings(t) -> list[dict]:
    return [{"name": t.items[cid], "rank": r} for cid, r in zip(_result_order(t), t.ranks())]


def _rematch_comparison(row: dict, standings: list[dict], vote_log: list):
    """How this game compares to the one it was a rematch of, if any."""
    prev = storage.get(row["rematch_of"]) if row.get("rematch_of") else None
    if not prev or not prev["done"]:
        return None
    return compare_runs(
        {"standings": _standings(_load_engine(prev)), "vote_log": json.loads(prev["vote_log_json"]),
         "date": prev["finished_at"]},
        {"standings": standings, "vote_log": vote_log, "date": row["finished_at"]},
    )


def _matchup_payload(t, row: dict, vote_log: list) -> dict:
    """Shape the engine's current state into what the frontend needs next:
    either the next matchup to show, or the final standings + fun stats."""
    pair = t.advance()
    base = {
        "id": row["id"],
        "category": row["category"],
        "mode": row["mode"],
        "top_n": row["top_n"],
        "manual_timer": bool(row["manual_timer"]),
        "phone_voting": bool(row["phone_voting"]),
        "comparisons": t.comparisons_count,
    }
    if pair is None:
        standings = _standings(t)
        return {
            **base,
            "done": True,
            "date": row["finished_at"],
            "total_candidates": len(t.items),
            "standings": standings,
            "fun_stats": compute_fun_stats(t.items, vote_log),
            "rematch": _rematch_comparison(row, standings, vote_log),
        }
    a, b = pair
    return {
        **base,
        "done": False,
        "total_estimate": t.total_estimate,
        "a": {"id": a, "name": t.items[a]},
        "b": {"id": b, "name": t.items[b]},
    }


def _record_vote(row: dict, choice: str, duration_ms, ballots=None, decided_by=None) -> dict:
    """Apply a decided vote to the stored game and return the next payload.

    Shared by one-screen voting and phone voting; with phones, `ballots`
    is who voted what and `decided_by` says whether the flock's majority
    or the host (breaking a deadlock) settled it.
    """
    t = _load_engine(row)
    # advance() is a no-op if a comparison is already pending (the normal
    # case) -- it's here so a state saved before that happened can still
    # be voted on, rather than raising.
    a_id, b_id = t.advance()
    a_name, b_name = t.items[a_id], t.items[b_id]

    t.vote(choice)

    if choice == "tie":
        winner_id = winner_name = loser_id = loser_name = None
    else:
        winner_id, loser_id = (a_id, b_id) if choice == "a" else (b_id, a_id)
        winner_name, loser_name = (a_name, b_name) if choice == "a" else (b_name, a_name)

    entry = {
        "a_id": a_id, "a_name": a_name,
        "b_id": b_id, "b_name": b_name,
        "choice": choice,
        "winner_id": winner_id, "winner_name": winner_name,
        "loser_id": loser_id, "loser_name": loser_name,
        "duration_ms": duration_ms,
    }
    if ballots is not None:
        entry["ballots"] = ballots
        entry["decided_by"] = decided_by
    vote_log = json.loads(row["vote_log_json"])
    vote_log.append(entry)

    payload = _matchup_payload(t, row, vote_log)
    storage.update(row["id"], t.to_dict(), done=payload["done"], vote_log=vote_log)
    return payload


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/active")
def api_active():
    """The most recent unfinished tournament, so the page can offer to resume it."""
    row = storage.get_active()
    if not row:
        return jsonify(None)
    t = _load_engine(row)
    return jsonify(_matchup_payload(t, row, json.loads(row["vote_log_json"])))


@app.route("/api/tournaments", methods=["POST"])
def api_create():
    body = request.get_json(force=True) or {}
    category = (body.get("category") or "Untitled Ranking").strip()
    names = [n.strip() for n in body.get("candidates", []) if n.strip()]
    mode = body.get("mode") or "full"
    manual_timer = bool(body.get("manual_timer"))
    phone_voting = bool(body.get("phone_voting"))
    if mode not in ("full", "quick"):
        return jsonify({"error": "Invalid mode."}), 400
    if len(names) < 2:
        return jsonify({"error": "Need at least two candidates."}), 400

    top_n = None
    if mode == "quick":
        try:
            top_n = int(body.get("top_n") or 3)
        except (TypeError, ValueError):
            return jsonify({"error": "Invalid top_n."}), 400
        if top_n < 1:
            return jsonify({"error": "top_n must be at least 1."}), 400
    return jsonify(_create_game(category, names, mode, top_n, manual_timer, phone_voting))


def _create_game(category, names, mode, top_n, manual_timer, phone_voting, rematch_of=None) -> dict:
    items = {str(i): name for i, name in enumerate(names)}
    if mode == "quick":
        top_n = min(top_n, len(names))
        t = QuickTournament(items, top_n)
    else:
        t = Tournament(items)

    tid = storage.create(
        category, t.to_dict(), mode=mode, top_n=top_n, manual_timer=manual_timer,
        phone_voting=phone_voting, rematch_of=rematch_of,
    )
    # advance() populates the first pending comparison; that mutation must
    # be persisted, or the next vote will find nothing pending.
    payload = _matchup_payload(t, storage.get(tid), vote_log=[])
    storage.update(tid, t.to_dict(), done=payload["done"], vote_log=[])

    with room.changed:
        # A new game replaces whatever room was open; joined players carry over.
        room.room = room.Room(tid=tid, manual_timer=manual_timer, payload=payload) if phone_voting else None
        room.bump()
    return payload


@app.route("/api/tournaments/<tid>/rematch", methods=["POST"])
def api_rematch(tid):
    """Play a finished game again: same flock, same options."""
    row = storage.get(tid)
    if not row or not row["done"]:
        return jsonify({"error": "Game not found or not finished."}), 404
    names = list(_load_engine(row).items.values())
    return jsonify(_create_game(
        row["category"], names, row["mode"], row["top_n"], bool(row["manual_timer"]),
        bool(row["phone_voting"]), rematch_of=tid,
    ))


@app.route("/api/tournaments/<tid>/vote", methods=["POST"])
def api_vote(tid):
    row = storage.get(tid)
    if not row or row["done"]:
        return jsonify({"error": "Game not found or already finished."}), 404
    if row["phone_voting"]:
        return jsonify({"error": "This game is voted on from phones."}), 409
    body = request.get_json(force=True) or {}
    choice = body.get("choice")
    if choice not in ("a", "b", "tie"):
        return jsonify({"error": "Invalid choice."}), 400
    duration_ms = body.get("duration_ms")
    if not isinstance(duration_ms, (int, float)) or duration_ms < 0:
        duration_ms = None
    return jsonify(_record_vote(row, choice, duration_ms))


def _close_room(tid: str) -> None:
    with room.changed:
        if room.room and room.room.tid == tid:
            room.room = None
            room.bump()


@app.route("/api/tournaments/<tid>/abandon", methods=["POST"])
def api_abandon(tid):
    storage.delete(tid)
    _close_room(tid)
    return jsonify({"ok": True})


@app.route("/api/tournaments/<tid>", methods=["DELETE"])
def api_delete(tid):
    storage.delete(tid)
    _close_room(tid)
    return jsonify({"ok": True})


@app.route("/api/history")
def api_history():
    return jsonify([
        _matchup_payload(_load_engine(row), row, json.loads(row["vote_log_json"]))
        for row in storage.list_history()
    ])


@app.route("/api/tournaments/<tid>/personal")
def api_personal_summaries(tid):
    """Every phone voter's own pecking order, for the host's results."""
    row = storage.get(tid)
    if not row or not row["done"]:
        return jsonify([])
    return jsonify(personal.summaries(row, _load_engine(row)))


# ---------- Phone voting: shared helpers (callers hold room.changed) ----------

def _room_for(row: dict) -> room.Room:
    """The live room for this phone-voting game, created on first use
    (a brand-new game, or resuming one after the app restarted)."""
    if room.room is None or room.room.tid != row["id"]:
        t = _load_engine(row)
        payload = _matchup_payload(t, row, json.loads(row["vote_log_json"]))
        room.room = room.Room(tid=row["id"], manual_timer=bool(row["manual_timer"]), payload=payload)
        if payload["done"]:
            room.room.phase = "done"
            room.room.unveiled = True  # an old finish: no reveal to wait for
        room.bump()
    return room.room


def _current_room():
    """The room phones should see, rebuilt from the database if the app restarted."""
    if room.room is None:
        row = storage.get_active()
        if row and row["phone_voting"]:
            return _room_for(row)
    return room.room


def _settle(r: room.Room, choice: str, decided_by: str) -> None:
    """Record the decided vote, then show the split (or, if nobody voted
    on a phone, move straight on to the next matchup)."""
    row = storage.get(r.tid)
    if not row or row["done"]:
        return
    ballots = r.ballots_for_log()
    payload = _record_vote(row, choice, r.elapsed_ms(), ballots=ballots, decided_by=decided_by)
    if ballots:
        r.phase, r.decided, r.pending, r.opened_at = "reveal", choice, payload, None
    else:
        r.open_matchup(payload)
    room.bump()


def _close_vote(r: room.Room) -> None:
    winner = r.close()
    if winner:
        _settle(r, winner, "flock")
    else:
        r.phase = "deadlock"  # the squabble clock keeps running while the host decides
        room.bump()


def _maybe_autoclose(r) -> None:
    if r and r.phase == "voting" and r.everyone_voted():
        _close_vote(r)


def _join_url() -> str:
    return f"http://{lan.lan_ip()}:{request.environ.get('SERVER_PORT', '5000')}/play"


def _host_state(r: room.Room) -> dict:
    url = _join_url()
    return {
        **r.host_view(),
        "version": room.version(),
        "join_url": url,
        "qr_svg": lan.qr_svg(url),
        "lan": app.config["LAN"],
    }


def _host_room(tid: str):
    """The live room for tid, or None if that game isn't the open room."""
    r = room.room
    return r if r and r.tid == tid else None


def _round_matches(r: room.Room) -> bool:
    """Host actions carry the round they were made in, so a double-click
    (or the auto-advance racing a tap) can't act on the next matchup."""
    body = request.get_json(silent=True) or {}
    return body.get("round") == r.round


# ---------- Phone voting: the host screen ----------

@app.route("/api/room/<tid>")
def api_room(tid):
    """Long-poll the room's state: with ?since=<version>, waits until
    something changes (or POLL_SECONDS pass) before answering."""
    since = request.args.get("since", type=int)
    with room.changed:
        row = storage.get(tid)
        if not row or not row["phone_voting"]:
            return jsonify({"error": "Game not found."}), 404
        _room_for(row)
        if since is not None and since == room.version():
            room.wait_for_change(since)
        r = _host_room(tid)
        if r is None:
            return jsonify({"gone": True})
        # A player may have drifted away, leaving everyone else voted.
        _maybe_autoclose(r)
        return jsonify(_host_state(r))


@app.route("/api/room/<tid>/start", methods=["POST"])
def api_room_start(tid):
    """Leave the lobby and open the first matchup."""
    with room.changed:
        r = _host_room(tid)
        if r is None:
            return jsonify({"error": "Game not found."}), 404
        if r.phase == "lobby":
            r.open_matchup(r.payload)
            room.bump()
        return jsonify(_host_state(r))


@app.route("/api/room/<tid>/squawk", methods=["POST"])
def api_room_squawk(tid):
    """Manual timer: open voting on the current matchup."""
    with room.changed:
        r = _host_room(tid)
        if r is None:
            return jsonify({"error": "Game not found."}), 404
        if _round_matches(r) and r.phase == "waiting":
            r.start_squabble()
            room.bump()
        return jsonify(_host_state(r))


@app.route("/api/room/<tid>/close", methods=["POST"])
def api_room_close(tid):
    """Close the vote early, without waiting for everyone."""
    with room.changed:
        r = _host_room(tid)
        if r is None:
            return jsonify({"error": "Game not found."}), 404
        if _round_matches(r) and r.phase == "voting" and r.ballots:
            _close_vote(r)
        return jsonify(_host_state(r))


@app.route("/api/room/<tid>/decide", methods=["POST"])
def api_room_decide(tid):
    """The host decides: breaking a deadlock, or voting directly when
    nobody has voted from a phone."""
    choice = (request.get_json(silent=True) or {}).get("choice")
    if choice not in ("a", "b", "tie"):
        return jsonify({"error": "Invalid choice."}), 400
    with room.changed:
        r = _host_room(tid)
        if r is None:
            return jsonify({"error": "Game not found."}), 404
        if _round_matches(r) and (r.phase == "deadlock" or (r.phase == "voting" and not r.ballots)):
            _settle(r, choice, "host")
        return jsonify(_host_state(r))


@app.route("/api/room/<tid>/next", methods=["POST"])
def api_room_next(tid):
    """Move on from the reveal to the next matchup (or the results)."""
    with room.changed:
        r = _host_room(tid)
        if r is None:
            return jsonify({"error": "Game not found."}), 404
        if _round_matches(r) and r.phase == "reveal":
            r.open_matchup(r.pending)
            room.bump()
        return jsonify(_host_state(r))


@app.route("/api/room/<tid>/unveiled", methods=["POST"])
def api_room_unveiled(tid):
    """The big screen finished its dramatic reveal: phones may show results."""
    with room.changed:
        r = _host_room(tid)
        if r and not r.unveiled:
            r.unveiled = True
            room.bump()
        return jsonify({"ok": True})


# ---------- Phone voting: players ----------

def _player_state(p) -> dict:
    if p is None:
        return {"joined": False, "version": room.version()}
    r = _current_room()
    view = r.player_view(p) if r else {"phase": "idle"}
    return {**view, "joined": True, "me": {**p.public(), "pid": p.pid}, "version": room.version()}


@app.route("/play")
def play():
    return render_template("play.html")


@app.route("/api/play/join", methods=["POST"])
def api_play_join():
    body = request.get_json(silent=True) or {}
    with room.changed:
        try:
            p = room.join(body.get("pid"), str(body.get("name") or ""))
        except room.NameTaken as e:
            return jsonify({"error": str(e)}), 409
        except ValueError as e:
            return jsonify({"error": str(e)}), 400
        room.bump()
        return jsonify(_player_state(p))


@app.route("/api/play/leave", methods=["POST"])
def api_play_leave():
    body = request.get_json(silent=True) or {}
    with room.changed:
        room.leave(str(body.get("pid") or ""))
        room.bump()
        _maybe_autoclose(room.room)
        return jsonify({"ok": True})


@app.route("/api/play/state")
def api_play_state():
    """Long-poll a player's view of the room, same as /api/room."""
    pid = request.args.get("pid")
    since = request.args.get("since", type=int)
    with room.changed:
        if room.touch(pid) and since is not None and since == room.version():
            room.wait_for_change(since)
        return jsonify(_player_state(room.touch(pid)))


@app.route("/api/play/vote", methods=["POST"])
def api_play_vote():
    body = request.get_json(silent=True) or {}
    choice = body.get("choice")
    if choice not in ("a", "b", "tie"):
        return jsonify({"error": "Invalid choice."}), 400
    with room.changed:
        p = room.touch(body.get("pid"))
        if p is None:
            return jsonify({"error": "Join the flock first."}), 403
        r = _current_room()
        if r is None or body.get("round") != r.round or r.phase != "voting":
            return jsonify({"error": "Voting on that matchup is closed."}), 409
        r.cast(p.pid, choice)
        room.bump()
        _maybe_autoclose(r)
        return jsonify(_player_state(p))


def _personal_request():
    """(player, finished group game row, error response) for personal-ranking calls."""
    body = request.get_json(silent=True) or {}
    pid = body.get("pid") or request.args.get("pid")
    tid = body.get("tid") or request.args.get("tid")
    with room.changed:
        p = room.touch(pid)
    if p is None:
        return None, None, (jsonify({"error": "Join the flock first."}), 403)
    row = storage.get(tid) if tid else None
    if not row or not row["done"] or not row["phone_voting"]:
        return None, None, (jsonify({"error": "That game isn't finished."}), 404)
    return p, row, None


@app.route("/api/play/personal", methods=["GET", "POST"])
def api_play_personal():
    """GET: this player's own ranking (null if not started). POST: start it."""
    p, row, err = _personal_request()
    if err:
        return err
    return jsonify(personal.state(row, _load_engine(row), p.name, start=request.method == "POST"))


@app.route("/api/play/personal/vote", methods=["POST"])
def api_play_personal_vote():
    choice = (request.get_json(silent=True) or {}).get("choice")
    if choice not in ("a", "b", "tie"):
        return jsonify({"error": "Invalid choice."}), 400
    p, row, err = _personal_request()
    if err:
        return err
    view = personal.vote(row, _load_engine(row), p.name, choice)
    if view is None:
        return jsonify({"error": "Start your ranking first."}), 409
    if view["done"]:
        with room.changed:
            room.bump()  # nudges anyone watching (e.g. the host's results)
    return jsonify(view)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Run Pecking Order.")
    parser.add_argument("--port", type=int, default=5000)
    parser.add_argument("--local", action="store_true",
                        help="only accept connections from this computer (no phone voting)")
    parser.add_argument("--debug", action="store_true",
                        help="Flask debug mode with auto-reload (implies --local)")
    args = parser.parse_args()
    local = args.local or args.debug
    app.config["LAN"] = not local

    print(f"\n  Pecking Order is running. Open http://127.0.0.1:{args.port}")
    if not local:
        print(f"  Phones on the same Wi-Fi can join at http://{lan.lan_ip()}:{args.port}/play\n")
    # The debugger runs code on request, so it's never exposed beyond this computer.
    app.run(host="127.0.0.1" if local else "0.0.0.0", port=args.port, debug=args.debug, threaded=True)
