#!/usr/bin/env python3
import importlib.util
import pathlib
import socket
import unittest


MODULE_PATH = pathlib.Path(__file__).with_name("cdp-proxy.py")
spec = importlib.util.spec_from_file_location("cdp_proxy", MODULE_PATH)
cdp_proxy = importlib.util.module_from_spec(spec)
assert spec and spec.loader
spec.loader.exec_module(cdp_proxy)


class FakeSocket:
    def __init__(self):
        self.timeout_values = []
        self.sockopts = []

    def settimeout(self, value):
        self.timeout_values.append(value)

    def setsockopt(self, level, optname, value):
        self.sockopts.append((level, optname, value))


class ConfigureWebsocketTunnelTest(unittest.TestCase):
    def test_clears_socket_timeouts_for_long_lived_websockets(self):
        client = FakeSocket()
        upstream = FakeSocket()

        cdp_proxy.configure_websocket_tunnel(client, upstream)

        self.assertEqual(client.timeout_values, [None])
        self.assertEqual(upstream.timeout_values, [None])
        self.assertIn((socket.IPPROTO_TCP, socket.TCP_NODELAY, 1), client.sockopts)
        self.assertIn((socket.IPPROTO_TCP, socket.TCP_NODELAY, 1), upstream.sockopts)


if __name__ == "__main__":
    unittest.main()
