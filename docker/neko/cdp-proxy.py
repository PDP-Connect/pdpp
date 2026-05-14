#!/usr/bin/env python3
import os
import socket
import threading
import itertools
import json
import time


LISTEN_HOST = os.environ.get("PDPP_NEKO_CDP_PROXY_HOST", "0.0.0.0")
LISTEN_PORT = int(os.environ.get("PDPP_NEKO_CDP_PROXY_PORT", "9223"))
UPSTREAM_HOST = os.environ.get("PDPP_NEKO_CDP_UPSTREAM_HOST", "127.0.0.1")
UPSTREAM_PORT = int(os.environ.get("PDPP_NEKO_CDP_UPSTREAM_PORT", "9222"))
BUFFER_SIZE = 64 * 1024
MAX_HEADER_SIZE = 1024 * 1024
CONNECTION_IDS = itertools.count(1)


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


def close_quietly(sock):
    try:
        sock.shutdown(socket.SHUT_RDWR)
    except OSError:
        pass
    try:
        sock.close()
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
