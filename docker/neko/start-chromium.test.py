#!/usr/bin/env python3
"""
Regression for the neko Chromium launch contract in start-chromium.sh.

Session-scoped auth cookies (no Expires/Max-Age — e.g. USAA's LtpaToken2/
AST/MemberGlobalSession) are dropped by Chromium on a clean process exit
unless --restore-last-session is present on the launch command line. This
was verified experimentally: a disposable profile with one session cookie
and one persistent cookie, launched with these exact flags, stopped
cleanly, and relaunched against the same profile — loses the session
cookie without the flag, keeps it with the flag; the persistent cookie
survives either way. See ~/.tmp/usaa-postdeploy-session-continuity-0803.md
for the full experiment.

This test is static (parses the script text), not a live browser launch —
CI-fast and deterministic. It fails before the flag was added and passes
after, which is what a container-spinning integration test would also show
but far more slowly and flakily.
"""
import pathlib
import re
import unittest


SCRIPT_PATH = pathlib.Path(__file__).with_name("start-chromium.sh")


def chrome_launch_args() -> list[str]:
    """Extract the literal `"$CHROME_BIN" ... &` invocation's flags."""
    text = SCRIPT_PATH.read_text()
    match = re.search(r'"\$CHROME_BIN"\s*\\\n(.*?)&\n', text, re.DOTALL)
    assert match, "could not locate the \"$CHROME_BIN\" launch invocation in start-chromium.sh"
    body = match.group(1)
    # Each continuation line looks like:  --flag=value \
    return [line.strip().rstrip("\\").strip() for line in body.splitlines() if line.strip()]


class ChromiumLaunchContractTest(unittest.TestCase):
    def test_restores_last_session_so_session_scoped_cookies_survive_a_restart(self):
        args = chrome_launch_args()
        self.assertIn(
            "--restore-last-session",
            args,
            "start-chromium.sh must launch Chromium with --restore-last-session, "
            "otherwise session-scoped auth cookies (e.g. USAA's LtpaToken2/AST/"
            "MemberGlobalSession) are dropped on every clean container restart "
            "even though the profile bind mount is intact.",
        )

    def test_user_data_dir_still_points_at_the_bind_mounted_profile(self):
        args = chrome_launch_args()
        self.assertIn(
            "--user-data-dir=/home/user/.config/chromium",
            args,
            "the profile bind-mount target must stay in sync with docker-compose "
            "and the allocator's mount destination.",
        )

    def test_no_incognito_or_guest_flags_that_would_defeat_persistence(self):
        args = chrome_launch_args()
        joined = " ".join(args)
        for forbidden in ("--incognito", "--guest", "--temp-profile"):
            self.assertNotIn(
                forbidden,
                joined,
                f"{forbidden} would make --restore-last-session a no-op by preventing "
                "any persistent profile state in the first place.",
            )


if __name__ == "__main__":
    unittest.main()
