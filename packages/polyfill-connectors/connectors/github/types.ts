// Shared types for the GitHub connector. Kept out of index.ts so the pure
// record builders in parsers.ts can import them without pulling in the
// runtime entry point.

export interface GhResult<T> {
  data: T;
  nextUrl: string | null;
}

export interface GhFetchOptions {
  accept?: string;
}

export interface GitHubUser {
  avatar_url?: string | null;
  bio?: string | null;
  blog?: string | null;
  company?: string | null;
  created_at?: string | null;
  email?: string | null;
  followers?: number | null;
  following?: number | null;
  id: number;
  location?: string | null;
  login: string;
  name?: string | null;
  public_gists?: number | null;
  public_repos?: number | null;
  twitter_username?: string | null;
  updated_at?: string | null;
}

export interface GitHubRepo {
  archived: boolean;
  created_at?: string | null;
  default_branch?: string | null;
  description?: string | null;
  disabled: boolean;
  fork: boolean;
  forks_count?: number | null;
  full_name: string;
  homepage?: string | null;
  html_url?: string | null;
  id: number;
  language?: string | null;
  license?: { key?: string | null } | null;
  name: string;
  open_issues_count?: number | null;
  owner?: { login?: string };
  private: boolean;
  pushed_at?: string | null;
  size?: number | null;
  stargazers_count?: number | null;
  topics?: string[];
  updated_at?: string | null;
  watchers_count?: number | null;
}

export interface GitHubStarredEntry {
  repo?: GitHubRepo;
  starred_at?: string | null;
}

export interface GitHubLabelObj {
  name?: string;
}

export interface GitHubIssue {
  assignees?: Array<{ login?: string }>;
  body?: string | null;
  closed_at?: string | null;
  comments?: number | null;
  created_at?: string | null;
  draft?: boolean;
  html_url?: string | null;
  id: number;
  labels?: Array<string | GitHubLabelObj>;
  milestone?: { title?: string | null } | null;
  number?: number;
  pull_request?: { html_url?: string | null } | null;
  reactions?: { total_count?: number | null };
  repository?: { full_name?: string; id?: number } | null;
  repository_url?: string;
  state?: string | null;
  state_reason?: string | null;
  title?: string | null;
  updated_at?: string | null;
  user?: { login?: string; id?: number };
}

export interface GitHubSearchResponse {
  items?: GitHubIssue[];
  total_count?: number;
}

export interface GitHubPullDetail {
  additions?: number | null;
  base?: { ref?: string; repo?: { id?: number } };
  changed_files?: number | null;
  commits?: number | null;
  deletions?: number | null;
  draft?: boolean;
  head?: { ref?: string };
  merged_at?: string | null;
  merged_by?: { login?: string } | null;
  requested_reviewers?: Array<{ login?: string }>;
  review_comments?: number | null;
}

export interface GitHubGistFile {
  filename?: string | null;
  language?: string | null;
  raw_url?: string | null;
  size?: number;
}

export interface GitHubGist {
  comments?: number | null;
  created_at?: string | null;
  description?: string | null;
  files?: Record<string, GitHubGistFile>;
  html_url?: string | null;
  id: string;
  public: boolean;
  updated_at?: string | null;
}
