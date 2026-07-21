#!/usr/bin/env python3
import os
import socket
import threading
import itertools
import json
import re
import subprocess
import time
from dataclasses import dataclass
from typing import Optional


LISTEN_HOST = os.environ.get("PDPP_NEKO_CDP_PROXY_HOST", "0.0.0.0")
LISTEN_PORT = int(os.environ.get("PDPP_NEKO_CDP_PROXY_PORT", "9223"))
UPSTREAM_HOST = os.environ.get("PDPP_NEKO_CDP_UPSTREAM_HOST", "127.0.0.1")
UPSTREAM_PORT = int(os.environ.get("PDPP_NEKO_CDP_UPSTREAM_PORT", "9222"))
BUFFER_SIZE = 64 * 1024
MAX_HEADER_SIZE = 1024 * 1024
CONNECTION_IDS = itertools.count(1)
WINDOW_SETTLE_PATH = b"/pdpp/window-settle"
MAX_WINDOW_ANCESTRY = 32
WINDOW_ID_PATTERN = r"(?:0x[0-9a-fA-F]+|[0-9]+)"


def log_event(event, **fields):
    payload = {
        "event": event,
        "ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        **fields,
    }
    print(json.dumps(payload, sort_keys=True), flush=True)


def socket_label(sock):
    try:
        host, port = sock.getpeername()[:2]
        return f"{host}:{port}"
    except OSError:
        return "unknown"


def request_target(request):
    first_line = request.split(b"\r\n", 1)[0]
    try:
        parts = first_line.decode("ascii", "replace").split(" ")
    except UnicodeDecodeError:
        return "unparseable"
    if len(parts) < 2:
        return "unknown"
    target = parts[1]
    if target.startswith("/devtools/"):
        # Target IDs are bearer-like debugging capabilities. Keep route shape,
        # but redact the unstable authority token from container logs.
        pieces = target.split("/")
        return "/".join(pieces[:3] + ["[redacted]"])
    return target[:160]


def request_method_and_path(request):
    first_line = request.split(b"\r\n", 1)[0]
    pieces = first_line.split(b" ")
    if len(pieces) < 2:
        return None, None
    return pieces[0], pieces[1].split(b"?", 1)[0]


@dataclass(frozen=True)
class X11Window:
    window_id: int
    parent_id: Optional[int]
    x: int
    y: int
    width: int
    height: int
    map_state: Optional[str]


def run_x11_command(command):
    try:
        result = subprocess.run(command, check=False, capture_output=True, text=True)
    except (OSError, subprocess.SubprocessError):
        return None
    if result.returncode != 0 or not isinstance(result.stdout, str):
        return None
    return result.stdout


def parse_window_id(value):
    if not isinstance(value, str) or not re.fullmatch(WINDOW_ID_PATTERN, value):
        return None
    try:
        return int(value, 0)
    except ValueError:
        return None


def parse_exact_field(output, pattern):
    matches = re.findall(pattern, output, flags=re.MULTILINE)
    return matches[0] if len(matches) == 1 else None


def parse_xwininfo_window(output, *, require_map_state):
    window_id_text = parse_exact_field(output, rf"^xwininfo: Window id:\s+({WINDOW_ID_PATTERN})(?:\s|$)")
    x_text = parse_exact_field(output, r"^\s*Absolute upper-left X:\s+(-?[0-9]+)\s*$")
    y_text = parse_exact_field(output, r"^\s*Absolute upper-left Y:\s+(-?[0-9]+)\s*$")
    width_text = parse_exact_field(output, r"^\s*Width:\s+([1-9][0-9]*)\s*$")
    height_text = parse_exact_field(output, r"^\s*Height:\s+([1-9][0-9]*)\s*$")
    if not window_id_text or not x_text or not y_text or not width_text or not height_text:
        return None
    window_id = parse_window_id(window_id_text)
    if window_id is None:
        return None
    map_state = None
    if require_map_state:
        map_state = parse_exact_field(output, r"^\s*Map State:\s+([A-Za-z]+)\s*$")
        if not map_state:
            return None
    return X11Window(
        window_id=window_id,
        parent_id=None,
        x=int(x_text),
        y=int(y_text),
        width=int(width_text),
        height=int(height_text),
        map_state=map_state,
    )


def read_root_window(display):
    output = run_x11_command(["xwininfo", "-root", "-display", display])
    if output is None:
        return None
    return parse_xwininfo_window(output, require_map_state=False)


def read_window(window_id, display):
    output = run_x11_command(["xwininfo", "-id", hex(window_id), "-display", display])
    if output is None:
        return None
    window = parse_xwininfo_window(output, require_map_state=True)
    if not window or window.window_id != window_id:
        return None
    tree_output = run_x11_command(["xwininfo", "-tree", "-id", hex(window_id), "-display", display])
    if tree_output is None:
        return None
    tree_window_id_text = parse_exact_field(tree_output, rf"^xwininfo: Window id:\s+({WINDOW_ID_PATTERN})(?:\s|$)")
    tree_window_id = parse_window_id(tree_window_id_text)
    if tree_window_id != window_id:
        return None
    parent_id_text = parse_exact_field(tree_output, rf"^\s*Parent window id:\s+({WINDOW_ID_PATTERN})(?:\s|$)")
    parent_id = parse_window_id(parent_id_text)
    if parent_id is None:
        return None
    return X11Window(
        window_id=window.window_id,
        parent_id=parent_id,
        x=window.x,
        y=window.y,
        width=window.width,
        height=window.height,
        map_state=window.map_state,
    )


def read_remote_browser_window_ids():
    output = run_x11_command(["xdotool", "search", "--class", "RemoteBrowserApp"])
    if output is None:
        return None
    if not output.strip():
        return []
    window_ids = [parse_window_id(token) for token in output.split()]
    return window_ids if all(window_id is not None for window_id in window_ids) else None


def resolve_top_level_frame(client_window_id, root_window, display):
    # `xdotool search --class` yields a Chromium client, not necessarily the
    # Openbox frame that n.eko presents. `xwininfo -id` reports that explicit
    # client unchanged (even with -frame), so climb verified `-tree` parents
    # to the direct child of root. That root child is the X11 top-level frame
    # whose exact geometry Openbox positions and n.eko captures.
    current_window_id = client_window_id
    visited = set()
    for _ in range(MAX_WINDOW_ANCESTRY):
        if current_window_id in visited:
            return None
        visited.add(current_window_id)
        current = read_window(current_window_id, display)
        if current is None or current.parent_id is None:
            return None
        if current.parent_id == root_window.window_id:
            return current
        if current.parent_id == 0:
            return None
        current_window_id = current.parent_id
    return None


def covers_root_after_clipping(frame, root):
    """Whether the visible portion of a frame is exactly the capture root."""
    return (
        max(frame.x, root.x) == root.x
        and max(frame.y, root.y) == root.y
        and min(frame.x + frame.width, root.x + root.width) == root.x + root.width
        and min(frame.y + frame.height, root.y + root.height) == root.y + root.height
    )


def window_settle_observation():
    display = os.environ.get("DISPLAY", ":99")
    root = read_root_window(display)
    if not root:
        return {"settled": False}, {"settle_reason": "root_geometry_unavailable"}
    window_ids = read_remote_browser_window_ids()
    if window_ids is None:
        return (
            {"settled": False, "width": root.width, "height": root.height},
            {"settle_reason": "remote_browser_window_search_failed"},
        )
    if not window_ids:
        return (
            {"settled": False, "width": root.width, "height": root.height},
            {
                "remote_browser_window_count": 0,
                "root_height": root.height,
                "root_width": root.width,
                "settle_reason": "remote_browser_window_missing",
            },
        )
    distinct_window_ids = list(dict.fromkeys(window_ids))
    viewable_clients = []
    nonviewable_client_count = 0
    for window_id in distinct_window_ids:
        client = read_window(window_id, display)
        if client is None:
            return (
                {"settled": False, "width": root.width, "height": root.height},
                {
                    "remote_browser_window_count": len(distinct_window_ids),
                    "settle_reason": "remote_browser_window_ancestry_unavailable",
                },
            )
        if client.map_state != "IsViewable":
            nonviewable_client_count += 1
            continue
        frame = resolve_top_level_frame(window_id, root, display)
        if frame is None:
            return (
                {"settled": False, "width": root.width, "height": root.height},
                {
                    "remote_browser_window_count": len(distinct_window_ids),
                    "settle_reason": "remote_browser_window_ancestry_unavailable",
                },
            )
        if frame.map_state != "IsViewable":
            return (
                {"settled": False, "width": root.width, "height": root.height},
                {
                    "remote_browser_window_count": len(distinct_window_ids),
                    "settle_reason": "remote_browser_window_frame_not_viewable",
                },
            )
        viewable_clients.append((client, frame))
    if not viewable_clients:
        return (
            {"settled": False, "width": root.width, "height": root.height},
            {
                "remote_browser_window_count": len(distinct_window_ids),
                "remote_browser_nonviewable_client_count": nonviewable_client_count,
                "settle_reason": "remote_browser_window_not_viewable",
            },
        )
    if len(viewable_clients) != 1:
        return (
            {"settled": False, "width": root.width, "height": root.height},
            {
                "remote_browser_window_count": len(distinct_window_ids),
                "remote_browser_nonviewable_client_count": nonviewable_client_count,
                "remote_browser_viewable_client_count": len(viewable_clients),
                "settle_reason": "remote_browser_window_multiple_viewable_clients",
            },
        )
    _, frame = viewable_clients[0]
    frame_geometry = {"x": frame.x, "y": frame.y, "width": frame.width, "height": frame.height}
    settled = covers_root_after_clipping(frame, root)
    return (
        {"settled": settled, "width": root.width, "height": root.height},
        {
            "remote_browser_window_count": len(distinct_window_ids),
            "remote_browser_nonviewable_client_count": nonviewable_client_count,
            "remote_browser_viewable_client_count": len(viewable_clients),
            "remote_browser_window_frame_geometries": [frame_geometry],
            "root_height": root.height,
            "root_width": root.width,
            "settle_reason": "settled" if settled else "remote_browser_window_frame_geometry_mismatch",
        },
    )


def window_settle_status():
    """Return the stable public settlement response without log-only detail."""
    status, _ = window_settle_observation()
    return status


def send_json_response(client, payload, status=b"200 OK"):
    body = json.dumps(payload, sort_keys=True).encode("utf-8")
    client.sendall(
        b"HTTP/1.1 " + status + b"\r\n"
        + b"Content-Type: application/json\r\n"
        + b"Content-Length: " + str(len(body)).encode("ascii") + b"\r\n"
        + b"Connection: close\r\n\r\n"
        + body
    )
    close_quietly(client)


def close_quietly(sock):
    try:
        sock.shutdown(socket.SHUT_RDWR)
    except OSError:
        pass
    try:
        sock.close()
    except OSError:
        pass


def configure_websocket_tunnel(*sockets):
    for sock in sockets:
        sock.settimeout(None)
        try:
            sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        except OSError:
            pass


def pump(source, target, *, connection_id, direction):
    bytes_relayed = 0
    try:
        while True:
            chunk = source.recv(BUFFER_SIZE)
            if not chunk:
                log_event(
                    "cdp_proxy.websocket_eof",
                    connection_id=connection_id,
                    direction=direction,
                    bytes_relayed=bytes_relayed,
                )
                break
            bytes_relayed += len(chunk)
            target.sendall(chunk)
    except OSError as err:
        log_event(
            "cdp_proxy.websocket_error",
            connection_id=connection_id,
            direction=direction,
            bytes_relayed=bytes_relayed,
            error=repr(err),
        )
    finally:
        close_quietly(source)
        close_quietly(target)
        log_event(
            "cdp_proxy.websocket_closed",
            connection_id=connection_id,
            direction=direction,
            bytes_relayed=bytes_relayed,
        )


def read_initial_request(client):
    client.settimeout(10)
    data = bytearray()
    try:
        while b"\r\n\r\n" not in data and len(data) < MAX_HEADER_SIZE:
            chunk = client.recv(BUFFER_SIZE)
            if not chunk:
                break
            data.extend(chunk)
    finally:
        client.settimeout(None)
    return bytes(data)


def rewrite_host_header(request):
    header_end = request.find(b"\r\n\r\n")
    if header_end < 0:
        return request
    head = request[:header_end]
    tail = request[header_end:]
    lines = head.split(b"\r\n")
    replacement = f"Host: {UPSTREAM_HOST}:{UPSTREAM_PORT}".encode("ascii")
    is_websocket_upgrade = any(
        line.lower().startswith(b"upgrade:") and b"websocket" in line.lower()
        for line in lines
    )
    connection_replaced = False
    for index, line in enumerate(lines):
        lowered = line.lower()
        if lowered.startswith(b"host:"):
            lines[index] = replacement
        elif lowered.startswith(b"connection:") and not is_websocket_upgrade:
            lines[index] = b"Connection: close"
            connection_replaced = True
    if not any(line.lower().startswith(b"host:") for line in lines):
        lines.append(replacement)
    if not is_websocket_upgrade and not connection_replaced:
        lines.append(b"Connection: close")
    return b"\r\n".join(lines) + tail


def is_websocket_upgrade_request(request):
    header_end = request.find(b"\r\n\r\n")
    if header_end < 0:
        return False
    head = request[:header_end]
    return any(
        line.lower().startswith(b"upgrade:") and b"websocket" in line.lower()
        for line in head.split(b"\r\n")
    )


def rewrite_response_connection_close(response_head):
    lines = response_head.split(b"\r\n")
    connection_replaced = False
    for index, line in enumerate(lines):
        if line.lower().startswith(b"connection:"):
            lines[index] = b"Connection: close"
            connection_replaced = True
    if not connection_replaced:
        lines.append(b"Connection: close")
    return b"\r\n".join(lines)


def extract_inbound_host(request):
    """Return the Host: header value from the inbound request, or None."""
    header_end = request.find(b"\r\n\r\n")
    head = request if header_end < 0 else request[:header_end]
    for line in head.split(b"\r\n"):
        if line.lower().startswith(b"host:"):
            try:
                return line.split(b":", 1)[1].strip()
            except IndexError:
                return None
    return None


def response_is_json(response_head):
    for line in response_head.split(b"\r\n"):
        if line.lower().startswith(b"content-type:") and b"application/json" in line.lower():
            return True
    return False


def rewrite_devtools_ws_urls(body, inbound_host):
    """Rewrite webSocketDebuggerUrl values in DevTools JSON responses so that
    Patchright (and any other CDP client speaking the official discovery
    protocol) dials back through this proxy rather than trying to reach
    Chromium's loopback-bound address directly.

    Chromium hard-binds the WebSocket listener to 127.0.0.1 (the
    --remote-debugging-address override is silently ignored for security
    on non-loopback addresses). Without rewriting we get ECONNREFUSED
    when an external client follows the URL.

    `inbound_host` is the Host: header the client used to reach us. We
    use it verbatim so the rewritten URL resolves from the same network
    perspective as the original request — no environment knowledge baked
    into the proxy.
    """
    if not inbound_host:
        return body
    upstream_endpoint = b"%s:%d" % (UPSTREAM_HOST.encode("ascii"), UPSTREAM_PORT)
    if upstream_endpoint not in body and b"127.0.0.1:%d" % UPSTREAM_PORT not in body:
        return body
    body = body.replace(b"ws://%s/" % upstream_endpoint, b"ws://%s/" % inbound_host)
    body = body.replace(
        b"ws://127.0.0.1:%d/" % UPSTREAM_PORT,
        b"ws://%s/" % inbound_host,
    )
    return body


def response_content_length(response_head):
    for line in response_head.split(b"\r\n"):
        if not line.lower().startswith(b"content-length:"):
            continue
        try:
            return int(line.split(b":", 1)[1].strip())
        except (IndexError, ValueError):
            return None
    return None


def relay_single_http_response(upstream, client, inbound_host=None, connection_id=None):
    upstream.settimeout(10)
    data = bytearray()
    try:
        while b"\r\n\r\n" not in data and len(data) < MAX_HEADER_SIZE:
            chunk = upstream.recv(BUFFER_SIZE)
            if not chunk:
                break
            data.extend(chunk)
        if not data:
            log_event("cdp_proxy.http_upstream_empty", connection_id=connection_id)
            return
        header_end = data.find(b"\r\n\r\n")
        if header_end < 0:
            client.sendall(bytes(data))
            return

        head = bytes(data[:header_end])
        body = bytes(data[header_end + 4 :])

        # Read remainder of body if Content-Length is set so we can rewrite
        # any embedded webSocketDebuggerUrl values atomically. This trades a
        # little buffering for a guarantee that DevTools JSON discovery
        # responses come back with a URL the client can actually dial.
        remaining = response_content_length(head)
        if remaining is not None:
            still = remaining - len(body)
            buf = bytearray(body)
            while still > 0:
                chunk = upstream.recv(min(BUFFER_SIZE, still))
                if not chunk:
                    break
                buf.extend(chunk)
                still -= len(chunk)
            body = bytes(buf)

        if response_is_json(head):
            body = rewrite_devtools_ws_urls(body, inbound_host)
            # Update Content-Length to match the rewritten body length.
            head_lines = []
            for line in head.split(b"\r\n"):
                if line.lower().startswith(b"content-length:"):
                    head_lines.append(b"Content-Length: %d" % len(body))
                else:
                    head_lines.append(line)
            head = b"\r\n".join(head_lines)

        client.sendall(rewrite_response_connection_close(head) + b"\r\n\r\n" + body)

        if remaining is not None:
            return

        upstream.settimeout(2)
        while True:
            chunk = upstream.recv(BUFFER_SIZE)
            if not chunk:
                break
            client.sendall(chunk)
    except OSError as err:
        log_event("cdp_proxy.http_error", connection_id=connection_id, error=repr(err))
    finally:
        close_quietly(upstream)
        close_quietly(client)


def handle(client):
    connection_id = next(CONNECTION_IDS)
    client_peer = socket_label(client)
    initial_request = read_initial_request(client)
    if not initial_request:
        log_event("cdp_proxy.empty_request", connection_id=connection_id, client=client_peer)
        close_quietly(client)
        return
    method, path = request_method_and_path(initial_request)
    if method == b"GET" and path == WINDOW_SETTLE_PATH:
        status, diagnostic = window_settle_observation()
        log_event("cdp_proxy.window_settle", connection_id=connection_id, settled=status["settled"], **diagnostic)
        send_json_response(client, status)
        return
    is_websocket_upgrade = is_websocket_upgrade_request(initial_request)
    log_event(
        "cdp_proxy.request",
        connection_id=connection_id,
        client=client_peer,
        target=request_target(initial_request),
        websocket=is_websocket_upgrade,
    )
    try:
        upstream = socket.create_connection((UPSTREAM_HOST, UPSTREAM_PORT), timeout=10)
    except OSError as err:
        log_event(
            "cdp_proxy.upstream_connect_error",
            connection_id=connection_id,
            client=client_peer,
            error=repr(err),
        )
        close_quietly(client)
        return
    inbound_host = extract_inbound_host(initial_request)
    upstream.sendall(rewrite_host_header(initial_request))
    if not is_websocket_upgrade:
        relay_single_http_response(upstream, client, inbound_host=inbound_host, connection_id=connection_id)
        return

    log_event(
        "cdp_proxy.websocket_open",
        connection_id=connection_id,
        client=client_peer,
        upstream=f"{UPSTREAM_HOST}:{UPSTREAM_PORT}",
    )
    configure_websocket_tunnel(client, upstream)
    for source, target, direction in (
        (client, upstream, "client_to_upstream"),
        (upstream, client, "upstream_to_client"),
    ):
        threading.Thread(
            target=pump,
            args=(source, target),
            kwargs={"connection_id": connection_id, "direction": direction},
            daemon=True,
        ).start()


def main():
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as server:
        server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        server.bind((LISTEN_HOST, LISTEN_PORT))
        server.listen(64)
        print(
            f"pdpp cdp proxy listening on {LISTEN_HOST}:{LISTEN_PORT} -> "
            f"{UPSTREAM_HOST}:{UPSTREAM_PORT}",
            flush=True,
        )
        while True:
            client, _ = server.accept()
            threading.Thread(target=handle, args=(client,), daemon=True).start()


if __name__ == "__main__":
    main()
