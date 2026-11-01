"""Finding this computer on the local network, for phone voting.

Phones join a game by opening http://<this computer's LAN address>:<port>/play,
offered on the host screen as a QR code. Requests from this computer itself
are the "host"; anything else on the network is a player, and can only
reach the player pages (see app.py's _host_only guard).
"""
from __future__ import annotations

import socket
from functools import lru_cache

import segno


def lan_ip() -> str:
    """This computer's address on the local network (e.g. 192.168.1.23).

    Connecting a UDP socket sends nothing; it just makes the OS pick the
    interface it would route through, which is the one phones can reach.
    """
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("10.255.255.255", 1))
        return s.getsockname()[0]
    except OSError:
        return "127.0.0.1"
    finally:
        s.close()


def own_addresses() -> set[str]:
    """Every address a request from this same computer could arrive from."""
    addrs = {"127.0.0.1", "::1", "::ffff:127.0.0.1", lan_ip()}
    try:
        addrs.update(socket.gethostbyname_ex(socket.gethostname())[2])
    except OSError:
        pass
    return addrs


@lru_cache(maxsize=8)
def qr_svg(url: str) -> str:
    """The join URL as an inline SVG QR code, sized by CSS. Always dark on
    white (even in the dark theme), since that's what phone cameras read best."""
    return segno.make(url, error="m").svg_inline(
        scale=1, border=2, omitsize=True, dark="#2D2433", light="#FFFFFF"
    )
