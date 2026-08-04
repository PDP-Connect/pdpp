// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

const GITHUB_ICON_PATH =
  "M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z";

function GithubIcon() {
  return (
    <svg aria-hidden="true" className="pdpp-icon-github" focusable="false" viewBox="0 0 16 16">
      <path d={GITHUB_ICON_PATH} fill="currentColor" />
    </svg>
  );
}

export function PdppConceptFooter({
  sourceHref = "https://github.com/PDP-Connect/pdpp",
  sourceLabel = "github.com/PDP-Connect/pdpp",
  licenses = (
    <dl className="pdpp-footer__license-list">
      <div className="pdpp-license-row">
        <dt>Reference implementation</dt>
        <dd>Apache-2.0</dd>
      </div>
      <div className="pdpp-license-row">
        <dt>Specification text</dt>
        <dd>CSL-1.0</dd>
      </div>
      <div className="pdpp-license-row">
        <dt>Documentation</dt>
        <dd>CC-BY-4.0</dd>
      </div>
    </dl>
  ),
}: {
  sourceHref?: string;
  sourceLabel?: string;
  licenses?: React.ReactNode;
}) {
  return (
    <footer className="pdpp-footer">
      <div className="pdpp-footer__inner">
        <div className="pdpp-footer__col pdpp-footer__licenses">
          <p className="pdpp-footer__label">License</p>
          {licenses}
        </div>
        <div className="pdpp-footer__col">
          <p className="pdpp-footer__label">Source</p>
          <p>
            <a className="pdpp-footer__source-link" href={sourceHref} rel="noopener noreferrer" target="_blank">
              <GithubIcon />
              {sourceLabel}
            </a>
          </p>
        </div>
        <div className="pdpp-footer__col">
          <p className="pdpp-footer__label">Governance</p>
          <p>PDP-Connect is an LF Decentralized Trust Lab.</p>
        </div>
      </div>
    </footer>
  );
}
