"""Target URL validation and signed file links."""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import ipaddress
import socket
import time
from urllib.parse import urlsplit

from .errors import ServiceError


def _is_public_ip(ip: ipaddress.IPv4Address | ipaddress.IPv6Address) -> bool:
    if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped is not None:
        ip = ip.ipv4_mapped
    return not (
        ip.is_private
        or ip.is_loopback
        or ip.is_link_local
        or ip.is_multicast
        or ip.is_reserved
        or ip.is_unspecified
        or (isinstance(ip, ipaddress.IPv4Address) and ip in ipaddress.ip_network("100.64.0.0/10"))
    )


async def validate_target_url(url: str, allow_private: bool) -> None:
    """Reject non-HTTP(S) URLs and, unless allowed, hosts on private networks.

    This is a pre-flight check: it does not prevent DNS rebinding or redirects
    to internal hosts performed by the extractor itself. Run the service on a
    network segment without access to sensitive internal endpoints.
    """
    try:
        parts = urlsplit(url)
    except ValueError as exc:
        raise ServiceError(400, "Invalid URL") from exc
    if parts.scheme not in {"http", "https"} or not parts.hostname:
        raise ServiceError(400, "Only absolute http(s) URLs are supported")
    if parts.username or parts.password:
        raise ServiceError(400, "URLs with embedded credentials are not supported")
    if allow_private:
        return
    host = parts.hostname
    try:
        literal = ipaddress.ip_address(host)
    except ValueError:
        literal = None
    if literal is not None:
        addresses = [literal]
    else:
        if host == "localhost" or host.endswith(".localhost") or host.endswith(".internal"):
            raise ServiceError(400, "Target host is not publicly routable")
        loop = asyncio.get_running_loop()
        try:
            infos = await loop.getaddrinfo(host, parts.port or (443 if parts.scheme == "https" else 80), type=socket.SOCK_STREAM)
        except socket.gaierror as exc:
            raise ServiceError(400, f"Could not resolve host {host}") from exc
        addresses = [ipaddress.ip_address(info[4][0].split("%")[0]) for info in infos]
    if not addresses or not all(_is_public_ip(a) for a in addresses):
        raise ServiceError(400, "Target host is not publicly routable")


def sign(signing_key: bytes, file_id: str, expires: int) -> str:
    message = f"{file_id}:{expires}".encode()
    return hmac.new(signing_key, message, hashlib.sha256).hexdigest()


def verify(signing_key: bytes, file_id: str, expires: int, signature: str, now: float | None = None) -> bool:
    if expires < (now if now is not None else time.time()):
        return False
    return hmac.compare_digest(sign(signing_key, file_id, expires), signature)


def constant_time_equals(a: str, b: str) -> bool:
    return hmac.compare_digest(a.encode(), b.encode())
