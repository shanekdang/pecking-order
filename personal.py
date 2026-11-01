"""Your own pecking order: each phone voter's personal ranking of a game.

After a phone-voting game, every player can rank the same flock by their
own taste. The ranking runs the same engine as the group game, from
scratch, but any matchup the player already voted on during the group game
is answered automatically from their ballot. Where their taste matched the
group's, the merge sort walks the same path and most answers are already
known; they're only asked about the pairs their own choices lead to.

State is saved per (game, player name) in storage, so it survives the app
restarting and the host can show everyone's results.
"""
from __future__ import annotations

import json

import storage
from tournament import QuickTournament, Tournament

FLIP = {"a": "b", "b": "a", "tie": "tie"}


def _answers(vote_log: list[dict], name: str) -> dict[tuple[str, str], str]:
    """This player's ballot on every group matchup they voted on."""
    out = {}
    for e in vote_log:
        for b in e.get("ballots") or []:
            if b["name"] == name:
                out[(e["a_id"], e["b_id"])] = b["choice"]
    return out


def _fresh_engine(group_row: dict, items: dict[str, str]):
    if group_row["mode"] == "quick":
        return QuickTournament(items, group_row["top_n"] or 3)
    return Tournament(items)


def _load(group_row: dict, data: dict):
    if group_row["mode"] == "quick":
        return QuickTournament.from_dict(data)
    return Tournament.from_dict(data)


def _autopilot(t, answers) -> tuple[object, int]:
    """Advance, answering every matchup the player already voted on.
    Returns the next pair that needs them (or None when done) and how
    many matchups were filled in along the way."""
    filled = 0
    while True:
        pair = t.advance()
        if pair is None:
            return None, filled
        a, b = pair
        if (a, b) in answers:
            t.vote(answers[(a, b)])
        elif (b, a) in answers:
            t.vote(FLIP[answers[(b, a)]])
        else:
            return pair, filled
        filled += 1


def _order(t) -> list[str]:
    return t.placed if isinstance(t, QuickTournament) else t.final_order


def group_ranks(group_row: dict, group_engine) -> dict[str, int]:
    """name -> the flock's rank (only ranked candidates, in Quick Mode)."""
    order = _order(group_engine)
    return {group_engine.items[cid]: r for cid, r in zip(order, group_engine.ranks())}


def _view(group_row: dict, t, pair, prefilled: int, flock: dict[str, int]) -> dict:
    view = {
        "tid": group_row["id"],
        "category": group_row["category"],
        "mode": group_row["mode"],
        "top_n": group_row["top_n"],
        "prefilled": prefilled,
        "comparisons": t.comparisons_count,
        "total_estimate": t.total_estimate,
        "done": pair is None,
    }
    if pair is None:
        view["standings"] = [
            {"name": t.items[cid], "rank": r, "flock_rank": flock.get(t.items[cid])}
            for cid, r in zip(_order(t), t.ranks())
        ]
    else:
        a, b = pair
        view["a"] = {"id": a, "name": t.items[a]}
        view["b"] = {"id": b, "name": t.items[b]}
    return view


def state(group_row: dict, group_engine, name: str, start: bool = False):
    """The player's personal ranking: None if not started (and start is
    False), else the next matchup to answer or their finished standings."""
    saved = storage.get_personal(group_row["id"], name)
    if saved is None and not start:
        return None
    vote_log = json.loads(group_row["vote_log_json"])
    if saved is None:
        t = _fresh_engine(group_row, dict(group_engine.items))
        prefilled = 0
    else:
        t = _load(group_row, json.loads(saved["engine_json"]))
        prefilled = saved["prefilled"]
    pair, filled = _autopilot(t, _answers(vote_log, name))
    prefilled += filled
    if saved is None or filled:
        storage.save_personal(group_row["id"], name, t.to_dict(), prefilled, pair is None)
    return _view(group_row, t, pair, prefilled, group_ranks(group_row, group_engine))


def vote(group_row: dict, group_engine, name: str, choice: str):
    """Answer the pending personal matchup, then fill in what we can."""
    saved = storage.get_personal(group_row["id"], name)
    if saved is None:
        return None
    t = _load(group_row, json.loads(saved["engine_json"]))
    if t.advance() is not None:
        t.vote(choice)
    vote_log = json.loads(group_row["vote_log_json"])
    pair, filled = _autopilot(t, _answers(vote_log, name))
    prefilled = saved["prefilled"] + filled
    storage.save_personal(group_row["id"], name, t.to_dict(), prefilled, pair is None)
    return _view(group_row, t, pair, prefilled, group_ranks(group_row, group_engine))


def summaries(group_row: dict, group_engine) -> list[dict]:
    """Everyone's personal ranking for the host's results screen."""
    flock = group_ranks(group_row, group_engine)
    out = []
    for saved in storage.list_personal(group_row["id"]):
        entry = {"name": saved["name"], "done": bool(saved["done"])}
        if saved["done"]:
            t = _load(group_row, json.loads(saved["engine_json"]))
            standings = [{"name": t.items[cid], "rank": r} for cid, r in zip(_order(t), t.ranks())]
            entry["standings"] = standings
            entry["matches"] = sum(1 for s in standings if flock.get(s["name"]) == s["rank"])
            entry["total"] = len(standings)
        out.append(entry)
    return out
