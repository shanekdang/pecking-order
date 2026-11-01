"""Phone voting: everyone in the room votes from their own phone.

The host's screen (the computer running the app) still shows each
matchup, but players join by scanning a QR code and vote privately on
their phones. Once everyone present has voted (or the host closes the
vote early) the majority decides; an exact split is a deadlock that the
host breaks by tapping a card on the big screen.

This module holds only the live, in-memory state: who has joined, and
the room for the one phone-voting game in progress. It knows nothing
about storage or the ranking engines -- app.py feeds it matchup payloads
and records each decided vote through the same path a one-screen vote
uses, plus who voted what (for the fun stats). If the app restarts
mid-game, phones quietly rejoin under the same name.

Every change bumps a version number and wakes any long-polling clients,
so phones and the host screen update the moment something happens,
without websockets.

All functions here expect the caller to hold `changed` (the module's
one lock) for the whole read-modify-notify sequence.
"""
from __future__ import annotations

import threading
import time
import uuid
from dataclasses import dataclass, field
from typing import Optional

PRESENT_SECONDS = 45  # a phone that hasn't checked in for this long is treated as gone
UNVEIL_SECONDS = 120  # phones stop waiting for the host's dramatic reveal after this long
POLL_SECONDS = 20     # how long a long-poll waits for news before answering anyway
MAX_NAME = 20

# (body, dark) pairs for each player's bird; reused in order of joining.
BIRD_COLORS = [
    ("#EE7C68", "#CF5E4B"),
    ("#5D9CEC", "#3F7FCF"),
    ("#6CC07A", "#4E9F5C"),
    ("#A57FE0", "#8661C4"),
    ("#F5B83D", "#D3961D"),
    ("#F28DB8", "#D46E99"),
    ("#3FB8B0", "#2A9890"),
    ("#F39A4B", "#D57C2E"),
]

changed = threading.Condition()
_version = 0


def version() -> int:
    return _version


def bump() -> None:
    """Record that something changed and wake every waiting long-poll."""
    global _version
    _version += 1
    changed.notify_all()


def wait_for_change(since: int, timeout: float = POLL_SECONDS) -> None:
    changed.wait_for(lambda: _version != since, timeout=timeout)


class NameTaken(Exception):
    pass


@dataclass
class Player:
    pid: str
    name: str
    color: int
    seen: float

    def present(self, now: float) -> bool:
        return now - self.seen < PRESENT_SECONDS

    def public(self) -> dict:
        body, dark = BIRD_COLORS[self.color % len(BIRD_COLORS)]
        return {"name": self.name, "color": body, "dark": dark}


# Players outlive any one game, so the same group can play again without rejoining.
players: dict[str, Player] = {}


def _now() -> float:
    return time.monotonic()


def present_players() -> list[Player]:
    now = _now()
    return [p for p in players.values() if p.present(now)]


def join(pid: Optional[str], name: str) -> Player:
    """Add a player, or update an existing one (a rename, or a phone
    rejoining after the app restarted, which keeps its old pid)."""
    name = " ".join(name.split())[:MAX_NAME]
    if not name:
        raise ValueError("Pick a name first.")
    now = _now()
    for other in players.values():
        if other.pid != pid and other.name.lower() == name.lower():
            if other.present(now):
                raise NameTaken(f"Someone called {other.name} is already here.")
            # A stale player with this name is almost certainly the same
            # person on a fresh browser: let them take the name over.
            del players[other.pid]
            break
    if pid and pid in players:
        p = players[pid]
        p.name, p.seen = name, now
    else:
        taken = {p.color for p in present_players()}
        color = next((i for i in range(len(BIRD_COLORS)) if i not in taken), len(players))
        p = Player(pid=pid or uuid.uuid4().hex, name=name, color=color, seen=now)
        players[p.pid] = p
    return p


def leave(pid: str) -> None:
    players.pop(pid, None)
    if room:
        room.ballots.pop(pid, None)


def touch(pid: Optional[str]) -> Optional[Player]:
    """Mark a player as still here (every request from their phone does)."""
    p = players.get(pid) if pid else None
    if p:
        now = _now()
        back = not p.present(now)
        p.seen = now
        if back:
            bump()  # they reappear on the host's roster
    return p


@dataclass
class Room:
    """The live state of the one phone-voting game in progress.

    phase is one of:
      lobby    -- players are joining; the host hasn't started yet
      waiting  -- matchup shown, but the manual squabble timer hasn't started
      voting   -- phones can vote (and change their vote)
      deadlock -- the vote closed on an exact split; the host decides
      reveal   -- the vote is decided and the split is on screen
      done     -- the game is over; payload holds the final standings
    """

    tid: str
    manual_timer: bool
    payload: dict  # the current matchup (or final) payload from app.py
    phase: str = "lobby"
    round: int = 0
    ballots: dict[str, str] = field(default_factory=dict)  # pid -> "a" | "b" | "tie"
    opened_at: Optional[float] = None
    result: Optional[dict] = None   # the split, once the vote closes
    pending: Optional[dict] = None  # payload to move on to after the reveal
    decided: Optional[str] = None   # the winning choice, during the reveal
    unveiled: bool = False          # done, and the big screen has finished its reveal
    done_at: Optional[float] = None

    def open_matchup(self, payload: dict) -> None:
        self.payload = payload
        self.ballots = {}
        self.result = None
        self.pending = None
        self.decided = None
        if payload["done"]:
            self.phase = "done"
            self.opened_at = None
            self.done_at = _now()
            return
        self.round += 1
        self.phase = "waiting" if self.manual_timer else "voting"
        self.opened_at = None if self.manual_timer else _now()

    def start_squabble(self) -> None:
        if self.phase == "waiting":
            self.phase = "voting"
            self.opened_at = _now()

    def elapsed_ms(self) -> Optional[int]:
        if self.opened_at is None:
            return None
        return int((_now() - self.opened_at) * 1000)

    def cast(self, pid: str, choice: str) -> None:
        if self.phase != "voting":
            raise ValueError("Voting isn't open right now.")
        self.ballots[pid] = choice

    def everyone_voted(self) -> bool:
        here = {p.pid for p in present_players()}
        return bool(self.ballots) and here <= set(self.ballots)

    def close(self) -> Optional[str]:
        """Tally the ballots into self.result. Returns the winning choice,
        or None on an exact split between the top options (a deadlock)."""
        counts = {"a": 0, "b": 0, "tie": 0}
        for choice in self.ballots.values():
            counts[choice] += 1
        named = []
        for pid, choice in self.ballots.items():
            p = players.get(pid)
            if p:
                named.append({**p.public(), "choice": choice})
        self.result = {"counts": counts, "ballots": named}
        best = max(counts.values())
        leaders = [c for c, n in counts.items() if n == best]
        return leaders[0] if len(leaders) == 1 else None

    def ballots_for_log(self) -> list[dict]:
        return [{"name": b["name"], "choice": b["choice"]} for b in (self.result or {}).get("ballots", [])]

    def roster(self) -> list[dict]:
        """Everyone present, plus anyone who already voted this round."""
        now = _now()
        out = []
        for p in players.values():
            voted = p.pid in self.ballots
            if p.present(now) or voted:
                out.append({**p.public(), "voted": voted})
        return out

    def host_view(self) -> dict:
        return {
            "tid": self.tid,
            "phase": self.phase,
            "round": self.round,
            "payload": self.payload,
            "players": self.roster(),
            "present_count": len(present_players()),
            "voted_count": len(self.ballots),
            "elapsed_ms": self.elapsed_ms(),
            "result": self.result,
            "decided": self.decided,
            "finishing": bool(self.pending and self.pending["done"]),  # the reveal leads to the results
        }

    def player_view(self, player: Player) -> dict:
        unveiled = self.unveiled or (self.done_at is not None and _now() - self.done_at > UNVEIL_SECONDS)
        payload = self.payload
        if self.phase == "done" and not unveiled:
            # Don't even send the standings until the big screen has revealed them.
            payload = {"category": payload["category"], "done": True}
        return {
            "tid": self.tid,
            "phase": self.phase,
            "round": self.round,
            "payload": payload,
            "players": self.roster(),
            "present_count": len(present_players()),
            "voted_count": len(self.ballots),
            "my_vote": self.ballots.get(player.pid),
            "unveiled": unveiled,
            "result": self.result if self.phase in ("deadlock", "reveal") else None,
            "decided": self.decided,
        }


room: Optional[Room] = None
