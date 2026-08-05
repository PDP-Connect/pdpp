// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { DiscordIcon, GithubIcon } from "./icons.tsx";
import { DISCORD_INVITE_URL, GITHUB_REPO_URL, SITE_LICENSES } from "./site-facts.ts";

const GITHUB_URL_SCHEME_RE = /^https?:\/\//;
const githubDisplayText = GITHUB_REPO_URL.replace(GITHUB_URL_SCHEME_RE, "");

// ONE footer, identical on every page. The owner's finding was that the footer
// differed on all four pages; the fix is a single component that takes no
// per-page props, so there is no seam where they can diverge again.
//
// Column order and content are load-bearing:
//   LICENSE     — all three licenses LINKED and LABELLED by the artifact they
//                 cover, specification text FIRST (explicit owner instruction).
//   SOURCE      — the repository, with the GitHub mark.
//   COMMUNITY   — Discord. Named for the category, not the product: LICENSE /
//                 SOURCE / GOVERNANCE all name a kind of information, and the
//                 link text underneath already says "Discord". COMMUNITY is
//                 also the dominant convention (Docusaurus's default footer
//                 scaffold, reused by vercel.com) and absorbs a forum or a
//                 mailing list later without a rename.
//   GOVERNANCE  — the LFDT lab line.
//
// Four columns exactly, on all four pages. A fifth was tried during the concept
// pass and reverted: it wrapped to a second row at 1280px.
export function PdppConceptFooter() {
  return (
    <footer className="pdpp-footer">
      <div className="pdpp-footer__inner">
        <div className="pdpp-footer__col pdpp-footer__licenses">
          <p className="pdpp-footer__label">License</p>
          <dl className="pdpp-footer__license-list">
            {SITE_LICENSES.map((row) => (
              <div className="pdpp-license-row" key={row.artifact}>
                <dt>{row.artifact}</dt>
                <dd>
                  <a href={row.href} rel="noopener noreferrer" target="_blank">
                    {row.spdx}
                  </a>
                </dd>
              </div>
            ))}
          </dl>
        </div>

        <div className="pdpp-footer__col">
          <p className="pdpp-footer__label">Source</p>
          <p>
            <a className="pdpp-footer__source-link" href={GITHUB_REPO_URL} rel="noopener noreferrer" target="_blank">
              <GithubIcon />
              {githubDisplayText}
            </a>
          </p>
        </div>

        <div className="pdpp-footer__col">
          <p className="pdpp-footer__label">Community</p>
          <p>
            <a className="pdpp-footer__source-link" href={DISCORD_INVITE_URL} rel="noopener noreferrer" target="_blank">
              <DiscordIcon />
              #pdp-connect on LFDT Discord
            </a>
          </p>
        </div>

        <div className="pdpp-footer__col">
          <p className="pdpp-footer__label">Governance</p>
          <p>
            PDP-Connect is an{" "}
            <a href="https://www.lfdecentralizedtrust.org/" rel="noopener noreferrer" target="_blank">
              LF Decentralized Trust
            </a>{" "}
            Lab.
          </p>
        </div>
      </div>
    </footer>
  );
}
