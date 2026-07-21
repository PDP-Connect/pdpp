import type { ExistingSourceSetupLink } from "../../components/source-setup-catalog.tsx";
import type { ConnectorCatalogEntry } from "../../lib/connection-catalog.ts";

export function buildAddSourceDemoCatalog(): {
  catalog: ConnectorCatalogEntry[];
  existingSourcesByConnector: Record<string, ExistingSourceSetupLink[]>;
} {
  return {
    catalog: [
      {
        acquisitionPaths: [],
        connectorKey: "chatgpt",
        deploymentReadiness: { blockers: [], guidance: null, state: "ready" },
        displayName: "ChatGPT",
        disposition: "static_secret_connect",
        modality: "api_network",
        nextStepKind: "capture_static_secret",
        proofGate: null,
        runbookPath: null,
        setupModality: "static_secret",
        supportState: "supported",
      },
      {
        acquisitionPaths: [
          {
            detail: "Export the order archive from the provider, then upload it here.",
            helpUrl: null,
            label: "Order archive upload",
            platform: "Web export",
            posture: "primary",
          },
        ],
        connectorKey: "amazon",
        deploymentReadiness: { blockers: [], guidance: null, state: "ready" },
        displayName: "Amazon",
        disposition: "manual_upload_connect",
        modality: "api_network",
        nextStepKind: "provide_import_file",
        proofGate: null,
        runbookPath: null,
        setupModality: "manual_or_upload",
        supportState: "supported",
      },
      {
        acquisitionPaths: [],
        connectorKey: "claude_code",
        deploymentReadiness: { blockers: [], guidance: null, state: "ready" },
        displayName: "Claude Code",
        disposition: "local_collector_enroll",
        enrollmentKey: "claude_code",
        modality: "local_collector",
        nextStepKind: "enroll_local_collector",
        proofGate: null,
        runbookPath: null,
        setupModality: "local_collector",
        supportState: "supported",
      },
      {
        acquisitionPaths: [],
        connectorKey: "calendar_demo",
        deploymentReadiness: {
          blockers: [{ key: "OAUTH_CLIENT_ID", label: "OAuth client ID", secret: false }],
          guidance: "Configure provider OAuth app material before adding this source.",
          state: "needs_config",
        },
        displayName: "Calendar Demo",
        disposition: "provider_auth_deployment_blocked",
        modality: "api_network",
        nextStepKind: "needs_deployment_config",
        proofGate: null,
        runbookPath: null,
        setupModality: "provider_authorization",
        supportState: "needs_deployment_config",
      },
      {
        acquisitionPaths: [],
        connectorKey: "browser_archive",
        deploymentReadiness: { blockers: [], guidance: null, state: "ready" },
        displayName: "Browser Archive Demo",
        disposition: "browser_bound_runbook",
        modality: "browser_bound",
        nextStepKind: "manual_runbook",
        proofGate: "browser_setup_package",
        runbookPath: "docs/connectors/browser-archive.md",
        setupModality: "browser_bound",
        supportState: "proof_gated",
      },
    ],
    existingSourcesByConnector: {
      amazon: [
        {
          connectionId: "cin_demo_amazon_home",
          displayName: "Amazon household archive",
          latestImportFile: "orders-2026-demo.zip",
          latestImportStatus: "accepted",
          status: "active",
          totalRecords: 2868,
        },
      ],
      chatgpt: [
        {
          connectionId: "cin_demo_chatgpt_work",
          displayName: "ChatGPT work profile",
          latestImportFile: null,
          latestImportStatus: null,
          status: "active",
          totalRecords: 136_507,
        },
      ],
    },
  };
}
