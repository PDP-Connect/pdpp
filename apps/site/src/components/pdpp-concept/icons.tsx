// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Shared inline marks for the concept chrome. The GitHub and Discord marks get
// identical treatment (currentColor fill, 1em box via .pdpp-icon-*) so the
// footer's SOURCE and COMMUNITY columns read as siblings at matching optical
// size — the owner asked for the Discord icon to match the GitHub icon rather
// than arrive as a new visual register.
//
// Discord path data: simple-icons (icons/discord.svg), the same icon family
// that supplies the GitHub mark. discord.com/branding distributes downloadable
// asset packages rather than inline path data, so simple-icons is the
// verifiable, brand-guideline-tracking source rather than a hand-copied path.

const GITHUB_ICON_PATH =
  "M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z";

const DISCORD_ICON_PATH =
  "M13.545 2.907a13.2 13.2 0 0 0-3.257-1.011.05.05 0 0 0-.052.025c-.141.25-.297.577-.406.833a12.2 12.2 0 0 0-3.658 0 8 8 0 0 0-.412-.833.05.05 0 0 0-.052-.025c-1.125.194-2.22.534-3.257 1.011a.04.04 0 0 0-.021.018C.356 6.024-.213 9.047.066 12.032q.003.022.021.037a13.3 13.3 0 0 0 3.995 2.02.05.05 0 0 0 .056-.019q.463-.63.818-1.329a.05.05 0 0 0-.01-.059l-.018-.011a9 9 0 0 1-1.248-.595.05.05 0 0 1-.02-.066l.015-.019q.127-.093.244-.194a.05.05 0 0 1 .051-.007c2.619 1.196 5.454 1.196 8.041 0a.05.05 0 0 1 .053.007q.116.101.245.195a.05.05 0 0 1-.004.085 8 8 0 0 1-1.249.594.05.05 0 0 0-.03.03.05.05 0 0 0 .003.041q.36.698.817 1.329a.05.05 0 0 0 .056.019 13.2 13.2 0 0 0 4.001-2.02.05.05 0 0 0 .021-.037c.334-3.451-.559-6.449-2.366-9.106a.03.03 0 0 0-.02-.019m-8.198 7.307c-.789 0-1.438-.724-1.438-1.612s.637-1.613 1.438-1.613c.807 0 1.45.73 1.438 1.613 0 .888-.637 1.612-1.438 1.612m5.316 0c-.788 0-1.438-.724-1.438-1.612s.637-1.613 1.438-1.613c.807 0 1.451.73 1.438 1.613 0 .888-.631 1.612-1.438 1.612";

export function GithubIcon({ className = "pdpp-icon-github" }: { className?: string }) {
  return (
    <svg aria-hidden="true" className={className} focusable="false" viewBox="0 0 16 16">
      <path d={GITHUB_ICON_PATH} fill="currentColor" />
    </svg>
  );
}

export function DiscordIcon({ className = "pdpp-icon-discord" }: { className?: string }) {
  return (
    <svg aria-hidden="true" className={className} focusable="false" viewBox="0 0 16 16">
      <path d={DISCORD_ICON_PATH} fill="currentColor" />
    </svg>
  );
}

// Callum Flack's PDPP vector mark (four bracket-shaped glyphs), inlined from
// the design concept (index.html .wordmark__mark). currentColor so it picks
// up --pdpp-concept-ink in the masthead and --pdpp-concept-paper in the
// footer, same as the concept's own wordmark.
const WORDMARK_PATH =
  "M60 30C65.3043 30 70.3919 32.1067 74.1426 35.8574C77.8933 39.6081 80 44.6957 80 50V110C80 115.304 77.8933 120.392 74.1426 124.143C70.3919 127.893 65.3043 130 60 130H20V160H0V30H60ZM270 130H210V160H190V30H270V130ZM345 30C350.304 30 355.392 32.1067 359.143 35.8574C362.893 39.6081 365 44.6957 365 50V110C365 115.304 362.893 120.392 359.143 124.143C355.392 127.893 350.304 130 345 130H305V160H285V30H345ZM175 130H115C109.696 130 104.608 127.893 100.857 124.143C97.1067 120.392 95 115.304 95 110V50C95 44.6957 97.1067 39.6081 100.857 35.8574C104.608 32.1067 109.696 30 115 30H155V0H175V130ZM20 50V110H60V50H20ZM115 110H155V50H115V110ZM210 110H250V50H210V110ZM305 110H345V50H305V110Z";

export function WordmarkIcon({ className = "pdpp-wordmark__mark" }: { className?: string }) {
  return (
    <svg aria-hidden="true" className={className} focusable="false" viewBox="0 0 365 160">
      <path d={WORDMARK_PATH} fill="currentColor" />
    </svg>
  );
}

export function SearchIcon({ className }: { className?: string }) {
  return (
    <svg aria-hidden="true" className={className} focusable="false" viewBox="0 0 16 16">
      <path
        d="M7 12.5A5.5 5.5 0 1 0 7 1.5a5.5 5.5 0 0 0 0 11ZM15 15l-4.35-4.35"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
      />
    </svg>
  );
}
