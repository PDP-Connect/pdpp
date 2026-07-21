#!/usr/bin/env python3
import importlib.util
import os
import pathlib
import re
import shutil
import socket
import subprocess
import tempfile
import time
import unittest
from unittest import mock


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


class Completed:
    def __init__(self, stdout="", returncode=0):
        self.returncode = returncode
        self.stdout = stdout


def root_output(window_id="0x1", x=0, y=0, width=1440, height=900):
    return f'''xwininfo: Window id: {window_id} (the root window) (has no name)

  Absolute upper-left X:  {x}
  Absolute upper-left Y:  {y}
  Width: {width}
  Height: {height}
'''


def window_output(window_id, x, y, width, height, map_state="IsViewable"):
    return f'''xwininfo: Window id: {window_id} "RemoteBrowserApp"

  Absolute upper-left X:  {x}
  Absolute upper-left Y:  {y}
  Width: {width}
  Height: {height}
  Map State: {map_state}
'''


def tree_output(window_id, parent_id):
    return f'''xwininfo: Window id: {window_id} (has no name)

  Parent window id: {parent_id} (has no name)
'''


class ConfigureWebsocketTunnelTest(unittest.TestCase):
    def test_clears_socket_timeouts_for_long_lived_websockets(self):
        client = FakeSocket()
        upstream = FakeSocket()

        cdp_proxy.configure_websocket_tunnel(client, upstream)

        self.assertEqual(client.timeout_values, [None])
        self.assertEqual(upstream.timeout_values, [None])
        self.assertIn((socket.IPPROTO_TCP, socket.TCP_NODELAY, 1), client.sockopts)
        self.assertIn((socket.IPPROTO_TCP, socket.TCP_NODELAY, 1), upstream.sockopts)


class WindowSettleStatusTest(unittest.TestCase):
    def observe(self, responses):
        def run(command, **_kwargs):
            return responses[tuple(command)]

        with (
            mock.patch.object(cdp_proxy.subprocess, "run", side_effect=run),
            mock.patch.dict(os.environ, {"DISPLAY": ":99"}, clear=False),
        ):
            return cdp_proxy.window_settle_observation()

    def base_responses(self, clients):
        return {
            ("xwininfo", "-root", "-display", ":99"): Completed(root_output()),
            ("xdotool", "search", "--class", "RemoteBrowserApp"): Completed("\n".join(clients) + "\n"),
        }

    def add_window(self, responses, window_id, parent_id, x, y, width, height, map_state="IsViewable"):
        numeric_id = int(window_id, 0)
        responses[("xwininfo", "-id", hex(numeric_id), "-display", ":99")] = Completed(
            window_output(window_id, x, y, width, height, map_state)
        )
        responses[("xwininfo", "-tree", "-id", hex(numeric_id), "-display", ":99")] = Completed(
            tree_output(window_id, parent_id)
        )

    def test_resolves_inset_client_to_larger_root_covering_frame(self):
        responses = self.base_responses(["0x10"])
        self.add_window(responses, "0x10", "0x100", 1, 1, 1440, 900)
        self.add_window(responses, "0x100", "0x1", 0, 0, 1442, 902)

        status, diagnostic = self.observe(responses)

        self.assertEqual(status, {"settled": True, "width": 1440, "height": 900})
        self.assertEqual(
            diagnostic["remote_browser_window_frame_geometries"],
            [{"x": 0, "y": 0, "width": 1442, "height": 902}],
        )
        self.assertEqual(diagnostic["remote_browser_viewable_client_count"], 1)

    def test_rejects_undersized_frame_without_tolerance(self):
        responses = self.base_responses(["0x10"])
        self.add_window(responses, "0x10", "0x100", 1, 1, 1438, 898)
        self.add_window(responses, "0x100", "0x1", 0, 0, 1438, 898)

        status, diagnostic = self.observe(responses)

        self.assertEqual(status, {"settled": False, "width": 1440, "height": 900})
        self.assertEqual(diagnostic["settle_reason"], "remote_browser_window_frame_geometry_mismatch")

    def test_rejects_shifted_frame_with_a_root_gap(self):
        responses = self.base_responses(["0x10"])
        self.add_window(responses, "0x10", "0x100", 2, 1, 1440, 900)
        self.add_window(responses, "0x100", "0x1", 1, 0, 1442, 902)

        status, diagnostic = self.observe(responses)

        self.assertEqual(status, {"settled": False, "width": 1440, "height": 900})
        self.assertEqual(diagnostic["settle_reason"], "remote_browser_window_frame_geometry_mismatch")

    def test_ignores_nonviewable_client_even_when_its_frame_is_viewable(self):
        responses = self.base_responses(["0x10", "0x20"])
        self.add_window(responses, "0x10", "0x100", 1, 1, 1440, 900)
        self.add_window(responses, "0x100", "0x1", 0, 0, 1442, 902)
        self.add_window(responses, "0x20", "0x200", 10, 10, 500, 300, "IsUnMapped")
        self.add_window(responses, "0x200", "0x1", 0, 0, 1442, 902)

        status, diagnostic = self.observe(responses)

        self.assertEqual(status, {"settled": True, "width": 1440, "height": 900})
        self.assertEqual(diagnostic["remote_browser_nonviewable_client_count"], 1)
        self.assertEqual(diagnostic["remote_browser_viewable_client_count"], 1)

    def test_rejects_unmapped_client_inside_a_viewable_root_covering_frame(self):
        responses = self.base_responses(["0x10"])
        self.add_window(responses, "0x10", "0x100", 1, 1, 1440, 900, "IsUnMapped")
        self.add_window(responses, "0x100", "0x1", 0, 0, 1442, 902)

        status, diagnostic = self.observe(responses)

        self.assertEqual(status, {"settled": False, "width": 1440, "height": 900})
        self.assertEqual(diagnostic["settle_reason"], "remote_browser_window_not_viewable")

    def test_rejects_two_viewable_clients_even_when_both_frames_cover_root(self):
        responses = self.base_responses(["0x10", "0x20"])
        self.add_window(responses, "0x10", "0x100", 1, 1, 1440, 900)
        self.add_window(responses, "0x100", "0x1", 0, 0, 1442, 902)
        self.add_window(responses, "0x20", "0x200", 1, 1, 1440, 900)
        self.add_window(responses, "0x200", "0x1", 0, 0, 1442, 902)

        status, diagnostic = self.observe(responses)

        self.assertEqual(status, {"settled": False, "width": 1440, "height": 900})
        self.assertEqual(diagnostic["remote_browser_viewable_client_count"], 2)
        self.assertEqual(diagnostic["settle_reason"], "remote_browser_window_multiple_viewable_clients")

    def test_nonzero_xdotool_exit_fails_closed_even_if_stdout_contains_a_window_id(self):
        responses = self.base_responses(["0x10"])
        responses[("xdotool", "search", "--class", "RemoteBrowserApp")] = Completed("0x10\n", returncode=1)

        status, diagnostic = self.observe(responses)

        self.assertEqual(status, {"settled": False, "width": 1440, "height": 900})
        self.assertEqual(diagnostic["settle_reason"], "remote_browser_window_search_failed")

    def test_malformed_xdotool_output_fails_closed(self):
        responses = self.base_responses(["0x10"])
        responses[("xdotool", "search", "--class", "RemoteBrowserApp")] = Completed("0x10\nnot-a-window\n")

        status, diagnostic = self.observe(responses)

        self.assertEqual(status, {"settled": False, "width": 1440, "height": 900})
        self.assertEqual(diagnostic["settle_reason"], "remote_browser_window_search_failed")

    def test_nonzero_xwininfo_exit_fails_closed_even_if_stdout_looks_valid(self):
        responses = self.base_responses(["0x10"])
        responses[("xwininfo", "-id", "0x10", "-display", ":99")] = Completed(
            window_output("0x10", 0, 0, 1440, 900), returncode=1
        )

        status, diagnostic = self.observe(responses)

        self.assertEqual(status, {"settled": False, "width": 1440, "height": 900})
        self.assertEqual(diagnostic["settle_reason"], "remote_browser_window_ancestry_unavailable")

    def test_malformed_xwininfo_output_fails_closed(self):
        responses = self.base_responses(["0x10"])
        responses[("xwininfo", "-id", "0x10", "-display", ":99")] = Completed(
            'xwininfo: Window id: 0x10 "RemoteBrowserApp"\n\n  Absolute upper-left X:  0\n  Width: 1440\n  Height: 900\n  Map State: IsViewable\n'
        )

        status, diagnostic = self.observe(responses)

        self.assertEqual(status, {"settled": False, "width": 1440, "height": 900})
        self.assertEqual(diagnostic["settle_reason"], "remote_browser_window_ancestry_unavailable")

    def test_cycle_in_window_ancestry_fails_closed(self):
        responses = self.base_responses(["0x10"])
        self.add_window(responses, "0x10", "0x20", 0, 0, 1440, 900)
        self.add_window(responses, "0x20", "0x10", 0, 0, 1440, 900)

        status, diagnostic = self.observe(responses)

        self.assertEqual(status, {"settled": False, "width": 1440, "height": 900})
        self.assertEqual(diagnostic["settle_reason"], "remote_browser_window_ancestry_unavailable")

    def test_window_settle_observation_is_read_only(self):
        responses = self.base_responses(["0x10"])
        self.add_window(responses, "0x10", "0x1", 0, 0, 1440, 900)

        self.observe(responses)

        self.assertTrue(all(command[0] in {"xdotool", "xwininfo"} for command in responses))


@unittest.skipUnless(
    all(shutil.which(command) for command in ("Xvfb", "openbox", "xterm", "xdpyinfo", "xwininfo")),
    "requires Xvfb, Openbox, xterm, xdpyinfo, and xwininfo",
)
class WindowSettleX11IntegrationTest(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory(prefix="pdpp-neko-x11-")
        self.bin_dir = pathlib.Path(self.tempdir.name, "bin")
        self.bin_dir.mkdir()
        self.processes = []
        self.display = self.start_disposable_display()
        env = {**os.environ, "DISPLAY": self.display}
        self.openbox = subprocess.Popen(["openbox"], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        self.processes.append(self.openbox)
        time.sleep(0.2)

    def start_disposable_display(self):
        first_display_number = 300 + (os.getpid() % 1000)
        for display_number in range(first_display_number, first_display_number + 20):
            display = f":{display_number}"
            xvfb = subprocess.Popen(
                ["Xvfb", display, "-screen", "0", "246x161x24"],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            for _ in range(20):
                if subprocess.run(["xdpyinfo", "-display", display], capture_output=True).returncode == 0:
                    self.processes.append(xvfb)
                    return display
                if xvfb.poll() is not None:
                    break
                time.sleep(0.05)
            xvfb.terminate()
            xvfb.wait(timeout=2)
        self.fail("could not allocate a disposable Xvfb display")

    def tearDown(self):
        for process in reversed(self.processes):
            process.terminate()
            try:
                process.wait(timeout=2)
            except subprocess.TimeoutExpired:
                process.kill()
        self.tempdir.cleanup()

    def wait_for(self, predicate):
        for _ in range(100):
            if predicate():
                return
            time.sleep(0.05)
        self.fail("timed out waiting for disposable X11 fixture")

    def wait_for_value(self, predicate):
        for _ in range(100):
            value = predicate()
            if value is not None:
                return value
            time.sleep(0.05)
        self.fail("timed out waiting for disposable X11 fixture")

    def launch_xterm(self, *, iconic=False):
        command = ["xterm", "-display", self.display, "-class", "RemoteBrowserApp", "-geometry", "43x11+0+0"]
        if iconic:
            command.append("-iconic")
        process = subprocess.Popen(command, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        self.processes.append(process)
        return process

    def remote_browser_ids(self):
        output = subprocess.run(
            ["xwininfo", "-root", "-tree", "-display", self.display],
            capture_output=True,
            text=True,
            check=True,
        ).stdout
        return [match.group(1) for match in re.finditer(r"^\s*(0x[0-9a-f]+).*RemoteBrowserApp", output, re.MULTILINE)]

    def install_xdotool_stub(self, window_ids):
        stub = self.bin_dir / "xdotool"
        stub.write_text("#!/bin/sh\nprintf '%s\\n' " + " ".join(window_ids) + "\n", encoding="utf-8")
        stub.chmod(0o755)

    def observe(self, window_ids):
        self.install_xdotool_stub(window_ids)
        with mock.patch.dict(
            os.environ,
            {"DISPLAY": self.display, "PATH": f"{self.bin_dir}:{os.environ['PATH']}"},
            clear=False,
        ):
            return cdp_proxy.window_settle_observation()

    def mapped_reparented_client_id(self):
        client_ids = self.remote_browser_ids()
        if len(client_ids) != 1:
            return None
        root = cdp_proxy.read_root_window(self.display)
        client = cdp_proxy.read_window(int(client_ids[0], 0), self.display)
        if root is None or client is None:
            return None
        frame = cdp_proxy.resolve_top_level_frame(int(client_ids[0], 0), root, self.display)
        if frame is None or frame.parent_id != root.window_id or frame.map_state != "IsViewable":
            return None
        if not cdp_proxy.covers_root_after_clipping(frame, root):
            return None
        if frame.width <= root.width or frame.height <= root.height:
            return None
        if (client.width, client.height) == (frame.width, frame.height):
            return None
        return client_ids[0]

    def test_mapped_reparented_client_uses_larger_viewable_root_covering_frame(self):
        self.launch_xterm()
        client_id = self.wait_for_value(self.mapped_reparented_client_id)

        root = cdp_proxy.read_root_window(self.display)
        client = cdp_proxy.read_window(int(client_id, 0), self.display)
        frame = cdp_proxy.resolve_top_level_frame(int(client_id, 0), root, self.display)
        status, diagnostic = self.observe([client_id])

        self.assertIsNotNone(root)
        self.assertIsNotNone(client)
        self.assertIsNotNone(frame)
        self.assertNotEqual((client.width, client.height), (frame.width, frame.height))
        self.assertEqual(frame.parent_id, root.window_id)
        self.assertEqual((frame.x, frame.y), (root.x, root.y))
        self.assertGreater(frame.width, root.width)
        self.assertGreater(frame.height, root.height)
        self.assertEqual(status, {"settled": True, "width": 246, "height": 161})
        self.assertEqual(
            diagnostic["remote_browser_window_frame_geometries"],
            [{"x": root.x, "y": root.y, "width": frame.width, "height": frame.height}],
        )

    def test_unmapped_remote_browser_client_is_not_presentation_geometry(self):
        self.launch_xterm()
        self.wait_for_value(self.mapped_reparented_client_id)
        self.launch_xterm(iconic=True)
        self.wait_for(lambda: len(self.remote_browser_ids()) == 2)
        window_ids = self.remote_browser_ids()
        status, diagnostic = self.observe(window_ids)

        self.assertEqual(status, {"settled": True, "width": 246, "height": 161})
        self.assertEqual(diagnostic["remote_browser_nonviewable_client_count"], 1)
        self.assertEqual(diagnostic["remote_browser_viewable_client_count"], 1)


if __name__ == "__main__":
    unittest.main()
