#!/usr/bin/env python3
import os
import socket
import threading


LISTEN_HOST = os.environ.get("PDPP_NEKO_CDP_PROXY_HOST", "0.0.0.0")
LISTEN_PORT = int(os.environ.get("PDPP_NEKO_CDP_PROXY_PORT", "9223"))
UPSTREAM_HOST = os.environ.get("PDPP_NEKO_CDP_UPSTREAM_HOST", "127.0.0.1")
UPSTREAM_PORT = int(os.environ.get("PDPP_NEKO_CDP_UPSTREAM_PORT", "9222"))
BUFFER_SIZE = 64 * 1024
MAX_HEADER_SIZE = 1024 * 1024


def close_quietly(sock):
    try:
        sock.shutdown(socket.SHUT_RDWR)
    except OSError:
        pass
    try:
        sock.close()
    except OSError:
        pass


def pump(source, target):
    try:
        while True:
            chunk = source.recv(BUFFER_SIZE)
            if not chunk:
                break
            target.sendall(chunk)
    except OSError:
        pass
    finally:
        close_quietly(source)
        close_quietly(target)


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


def response_content_length(response_head):
    for line in response_head.split(b"\r\n"):
        if not line.lower().startswith(b"content-length:"):
            continue
        try:
            return int(line.split(b":", 1)[1].strip())
        except (IndexError, ValueError):
            return None
    return None


def relay_single_http_response(upstream, client):
    upstream.settimeout(10)
    data = bytearray()
    try:
        while b"\r\n\r\n" not in data and len(data) < MAX_HEADER_SIZE:
            chunk = upstream.recv(BUFFER_SIZE)
            if not chunk:
                break
            data.extend(chunk)
        if not data:
            return
        header_end = data.find(b"\r\n\r\n")
        if header_end < 0:
            client.sendall(bytes(data))
            return

        head = bytes(data[:header_end])
        body = bytes(data[header_end + 4 :])
        client.sendall(rewrite_response_connection_close(head) + b"\r\n\r\n" + body)

        remaining = response_content_length(head)
        if remaining is not None:
            remaining -= len(body)
            while remaining > 0:
                chunk = upstream.recv(min(BUFFER_SIZE, remaining))
                if not chunk:
                    break
                client.sendall(chunk)
                remaining -= len(chunk)
            return

        upstream.settimeout(2)
        while True:
            chunk = upstream.recv(BUFFER_SIZE)
            if not chunk:
                break
            client.sendall(chunk)
    except OSError:
        pass
    finally:
        close_quietly(upstream)
        close_quietly(client)


def handle(client):
    initial_request = read_initial_request(client)
    if not initial_request:
        close_quietly(client)
        return
    is_websocket_upgrade = is_websocket_upgrade_request(initial_request)
    try:
        upstream = socket.create_connection((UPSTREAM_HOST, UPSTREAM_PORT), timeout=10)
    except OSError:
        close_quietly(client)
        return
    upstream.sendall(rewrite_host_header(initial_request))
    if not is_websocket_upgrade:
        relay_single_http_response(upstream, client)
        return

    for source, target in ((client, upstream), (upstream, client)):
        threading.Thread(target=pump, args=(source, target), daemon=True).start()


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
