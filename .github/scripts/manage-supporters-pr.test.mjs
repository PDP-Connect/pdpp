// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  manageSupportersPullRequest,
  publicationAction,
  retireStaleSupportersPublication,
} from "./manage-supporters-pr.mjs";

const options = {
  baseBranch: "main",
  publishBranch: "publish/supporters",
  repository: "PDP-Connect/pdpp",
};

function fakeGh(responses) {
  const calls = [];
  return {
    calls,
    run(arguments_) {
      calls.push(arguments_);
      return responses.shift() ?? { status: 0, stderr: "", stdout: "" };
    },
  };
}

test("creates a pull request when none is open", () => {
  const gh = fakeGh([
    { status: 0, stderr: "", stdout: "" },
    { status: 0, stderr: "", stdout: "https://github.com/PDP-Connect/pdpp/pull/320\n" },
  ]);
  const messages = [];

  const result = manageSupportersPullRequest({ ...options, run: gh.run, write: (message) => messages.push(message) });

  assert.deepEqual(result, { kind: "created" });
  assert.deepEqual(gh.calls.map((arguments_) => arguments_.slice(0, 2)), [
    ["pr", "list"],
    ["pr", "create"],
  ]);
  assert.deepEqual(messages, ["Created supporters pull request."]);
});

test("updates an existing pull request", () => {
  const gh = fakeGh([
    { status: 0, stderr: "", stdout: "319\n" },
    { status: 0, stderr: "", stdout: "" },
  ]);
  const messages = [];

  const result = manageSupportersPullRequest({ ...options, run: gh.run, write: (message) => messages.push(message) });

  assert.deepEqual(result, { kind: "exists", number: "319" });
  assert.deepEqual(gh.calls.map((arguments_) => arguments_.slice(0, 3)), [
    ["pr", "list", "--repo"],
    ["pr", "edit", "319"],
  ]);
  assert.deepEqual(messages, ["Updated pull request #319."]);
});

test("reports a maintainer handoff when Actions cannot create a pull request", () => {
  const gh = fakeGh([
    { status: 0, stderr: "", stdout: "" },
    { status: 1, stderr: "GraphQL: GitHub Actions is not permitted to create or approve pull requests", stdout: "" },
  ]);
  const messages = [];

  const result = manageSupportersPullRequest({ ...options, run: gh.run, write: (message) => messages.push(message) });

  assert.deepEqual(result, { kind: "forbidden" });
  assert.equal(messages[0], "NOTICE: GitHub Actions cannot open a pull request. The publisher pushed publish/supporters.");
  assert.equal(messages[1], "Compare: https://github.com/PDP-Connect/pdpp/compare/main...publish/supporters?expand=1");
  assert.equal(
    messages[2],
    "Maintainer command: 'gh' 'pr' 'create' '--repo' 'PDP-Connect/pdpp' '--base' 'main' '--head' 'publish/supporters' '--title' 'chore(site): publish supporters register' '--body' 'Automated public-register publication.'"
  );
});

test("a rebuilt register equal to main retires the stale publication after a withdrawal", () => {
  const gh = fakeGh([
    { status: 0, stderr: "", stdout: "319\n" },
    { status: 0, stderr: "", stdout: "" },
    { status: 0, stderr: "", stdout: "" },
  ]);
  const gitCalls = [];
  const messages = [];

  assert.equal(publicationAction({ registerMatchesBase: true, registerMatchesPublishBranch: false }), "retire");
  const result = retireStaleSupportersPublication({
    ...options,
    publishBranchExists: true,
    run: gh.run,
    runGitCommand(arguments_) {
      gitCalls.push(arguments_);
      return { status: 0, stderr: "", stdout: "" };
    },
    write: (message) => messages.push(message),
  });

  assert.deepEqual(result, { branchDeleted: true, pullRequest: { kind: "closed", number: "319" } });
  assert.deepEqual(gh.calls.map((arguments_) => arguments_.slice(0, 3)), [
    ["pr", "list", "--repo"],
    ["pr", "comment", "319"],
    ["pr", "close", "319"],
  ]);
  assert.equal(gh.calls[1].at(-1), "register now equals main; nothing to publish");
  assert.deepEqual(gitCalls, [["push", "origin", "--delete", "publish/supporters"]]);
  assert.deepEqual(messages, ["Closed pull request #319; register now equals main.", "Deleted obsolete branch publish/supporters."]);
});
