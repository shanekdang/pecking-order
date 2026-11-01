"""Fun statistics derived from a tournament's vote log.

Kept separate from the ranking engines in tournament.py: these numbers are
purely descriptive -- they never influence the ranking itself, they just
tell the story of how the group got there (what took forever to decide,
who was on a streak, who came up constantly).

Each vote_log entry (appended by app.py after every vote) looks like:
    {
        "a_id": str, "a_name": str, "b_id": str, "b_name": str,
        "choice": "a" | "b" | "tie",
        "winner_id": str | None, "winner_name": str | None,
        "loser_id": str | None, "loser_name": str | None,
        "duration_ms": int | None,   # time from matchup shown -> voted
        # phone voting only:
        "ballots": [{"name": str, "choice": "a" | "b" | "tie"}, ...],
        "decided_by": "flock" | "host",  # host = broke a deadlock (or no one voted)
    }
"""
from __future__ import annotations

from collections import defaultdict
from itertools import combinations

EMPTY_STATS = {
    "matchup_count": 0,
    "tie_count": 0,
    "total_duration_ms": 0,
    "heaviest_debates": [],
    "easiest_calls": [],
    "hot_streak": None,
    "most_contested": None,
    "flock": None,
}


def _split(entry: dict):
    """A phone vote's split as text, like "3–1" (or "2–2–1" with ties)."""
    ballots = entry.get("ballots")
    if not ballots:
        return None
    n = {c: sum(1 for b in ballots if b["choice"] == c) for c in ("a", "b", "tie")}
    return f"{n['a']}–{n['b']}" + (f"–{n['tie']}" if n["tie"] else "")


def _format_matchup(entry: dict) -> dict:
    return {
        "a": entry["a_name"],
        "b": entry["b_name"],
        "duration_ms": entry["duration_ms"],
        "choice": entry["choice"],
        "split": _split(entry),
    }


def compute_flock_stats(vote_log: list[dict]):
    """Who sided with the flock, who didn't, and who thinks alike -- from
    phone-voting ballots. None for one-screen games."""
    voted = [e for e in vote_log if e.get("ballots")]
    if not voted:
        return None

    per_voter: dict[str, dict] = {}
    by_matchup: list[dict[str, str]] = []
    unanimous = 0
    for e in voted:
        choices = {b["name"]: b["choice"] for b in e["ballots"]}
        by_matchup.append(choices)
        if len(choices) >= 2 and len(set(choices.values())) == 1:
            unanimous += 1
        for name, choice in choices.items():
            v = per_voter.setdefault(name, {"name": name, "votes": 0, "agreed": 0, "ties": 0})
            v["votes"] += 1
            v["agreed"] += choice == e["choice"]
            v["ties"] += choice == "tie"

    voters = sorted(per_voter.values(), key=lambda v: (-v["agreed"] / v["votes"], -v["votes"], v["name"]))
    # Superlatives only count people who voted on a fair share of matchups,
    # so someone who joined for the last two can't win by a fluke.
    regulars = [v for v in voters if v["votes"] >= max(2, len(voted) * 0.4)]

    def rate(v):
        return v["agreed"] / v["votes"]

    voice = contrarian = None
    if len(regulars) >= 2:
        top = max(rate(v) for v in regulars)
        low = min(rate(v) for v in regulars)
        if top > low:
            voice = {"names": [v["name"] for v in regulars if rate(v) == top][:3], "rate": top}
            contrarian = {"names": [v["name"] for v in regulars if rate(v) == low][:3], "rate": low}

    kindred = None
    if len(regulars) >= 3:
        best = None
        for x, y in combinations([v["name"] for v in regulars], 2):
            shared = [m for m in by_matchup if x in m and y in m]
            if len(shared) < 3:
                continue
            together = sum(m[x] == m[y] for m in shared) / len(shared)
            if best is None or together > best["rate"]:
                best = {"names": [x, y], "rate": together}
        kindred = best if best and best["rate"] >= 0.6 else None

    sitter = max(voters, key=lambda v: v["ties"])
    return {
        "voters": voters,
        "matchups": len(voted),
        "unanimous": unanimous,
        "deadlocks": sum(1 for e in voted if e.get("decided_by") == "host"),
        "voice_of_the_flock": voice,
        "contrarian": contrarian,
        "kindred_spirits": kindred,
        "fence_sitter": {"name": sitter["name"], "ties": sitter["ties"]} if sitter["ties"] >= 2 else None,
    }


def compute_fun_stats(items: dict[str, str], vote_log: list[dict]) -> dict:
    if not vote_log:
        return dict(EMPTY_STATS)

    timed = [e for e in vote_log if isinstance(e.get("duration_ms"), (int, float))]
    n_show = 5 if len(vote_log) >= 8 else 3

    heaviest = sorted(timed, key=lambda e: e["duration_ms"], reverse=True)[:n_show]
    heavy_ids = {id(e) for e in heaviest}
    # Only pull "easiest" from matchups not already shown as "heaviest" --
    # matters for small tournaments where the two lists would otherwise
    # just repeat the same handful of matchups in reverse order.
    easiest_pool = [e for e in timed if id(e) not in heavy_ids] or timed
    easiest = sorted(easiest_pool, key=lambda e: e["duration_ms"])[:n_show]

    contested: dict[str, int] = defaultdict(int)
    per_candidate_results: dict[str, list[str]] = defaultdict(list)
    tie_count = 0
    for e in vote_log:
        contested[e["a_id"]] += 1
        contested[e["b_id"]] += 1
        if e["choice"] == "tie":
            tie_count += 1
            continue
        per_candidate_results[e["winner_id"]].append("W")
        per_candidate_results[e["loser_id"]].append("L")

    best_streak = 0
    streak_holders: list[str] = []
    for cid, results in per_candidate_results.items():
        run = 0
        best = 0
        for r in results:
            if r == "W":
                run += 1
                best = max(best, run)
            else:
                run = 0
        if best > best_streak:
            best_streak = best
            streak_holders = [cid]
        elif best == best_streak and best > 0:
            streak_holders.append(cid)

    max_contested = max(contested.values()) if contested else 0
    most_contested_ids = [cid for cid, c in contested.items() if c == max_contested]

    return {
        "matchup_count": len(vote_log),
        "tie_count": tie_count,
        "total_duration_ms": sum(e["duration_ms"] for e in timed),
        "heaviest_debates": [_format_matchup(e) for e in heaviest],
        "easiest_calls": [_format_matchup(e) for e in easiest],
        "hot_streak": (
            {"names": [items[cid] for cid in streak_holders[:3]], "streak": best_streak}
            if best_streak >= 2
            else None
        ),
        "most_contested": (
            {"names": [items[cid] for cid in most_contested_ids[:3]], "matchups": max_contested}
            if max_contested >= 2
            else None
        ),
        "flock": compute_flock_stats(vote_log),
    }


def _decisions(vote_log: list[dict]) -> dict[frozenset, str]:
    """Each decided pair (by name) -> the winner's name, or "tie"."""
    return {
        frozenset((e["a_name"], e["b_name"])): (e["winner_name"] or "tie")
        for e in vote_log
    }


def compare_runs(before: dict, after: dict) -> dict:
    """What changed between a game and its rematch.

    before / after: {"standings": [{"name", "rank"}...], "vote_log": [...], "date": str}
    """
    was = {s["name"]: s["rank"] for s in before["standings"]}
    movers = []
    for s in after["standings"]:
        prev = was.get(s["name"])
        movers.append({
            "name": s["name"],
            "now": s["rank"],
            "before": prev,
            "delta": None if prev is None else prev - s["rank"],  # positive = climbed
        })

    then, now = _decisions(before["vote_log"]), _decisions(after["vote_log"])
    shared = [pair for pair in now if pair in then]
    flipped = []
    for pair in shared:
        if then[pair] != now[pair]:
            a, b = sorted(pair)
            flipped.append({"a": a, "b": b, "before": then[pair], "now": now[pair]})
    return {
        "previous_date": before["date"],
        "movers": movers,
        "flipped": flipped,
        "same_calls": len(shared) - len(flipped),
        "shared_calls": len(shared),
    }
