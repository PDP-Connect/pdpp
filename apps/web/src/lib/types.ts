export type DemoPhase =
  | 'idle'
  | 'requesting'
  | 'consenting_research'
  | 'consenting_ai'
  | 'showing_results'   // NEW: data arrives instantly after grant, before any scrape
  | 'authenticating'
  | 'scraping'
  | 'done'
  | 'error';

export interface DemoState {
  phase: DemoPhase;
  ownerToken: string | null;
  connectorId: string | null;
  seeded: { following_accounts: number; posts: number; ad_targeting: number } | null;
  // Grant A (research, single_use)
  researchDeviceCode: string | null;
  researchToken: string | null;
  researchGrant: Record<string, unknown> | null;
  researchGrantIssuedAt: string | null;
  // Grant B (ai_training, ongoing)
  aiDeviceCode: string | null;
  aiGrantApproved: boolean;
  // Query results
  streamCounts: Partial<Record<string, number>>;
  clientResults: Record<string, unknown[]>;
  rawResults: Record<string, unknown[]>;
  // Incremental sync
  postsCursor: string | null;          // next_changes_since from last posts query (owner)
  syncStateUpdated: boolean;           // connector emitted STATE messages this run
  incrementalPostCount: number | null; // records from last changes_since query
  // Post-demo enforcement demos
  singleUseConsumed: boolean;
  grantRevoked: boolean;
  // Gmail connector
  gmailConnected: boolean;
  gmailSummary: { total_threads: number; label_counts: Record<string, number> } | null;
  error: string | null;
}

export interface LogLine {
  id: number;
  level: 'info' | 'warn' | 'error' | 'success' | 'spec';
  text: string;
  detail?: string;
  timestamp: string;
}

export type BrowserStatus = 'idle' | 'running' | 'done' | 'error';

export interface InputRequest {
  requestId: string;
  input: {
    kind?: 'credentials' | 'otp' | 'manual_action';
    title: string;
    description?: string;
    message?: string;
    schema?: {
      type: string;
      required?: string[];
      properties: Record<string, { type: string; title?: string; minLength?: number; maxLength?: number }>;
    };
    uiSchema?: Record<string, unknown>;
    submitLabel?: string;
    error?: string;
  };
}
