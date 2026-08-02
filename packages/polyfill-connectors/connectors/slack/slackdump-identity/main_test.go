// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"
)

func TestReadRequestIsBoundedAndStrict(t *testing.T) {
	valid := `{"token":"xoxc-1-2-3-` + strings.Repeat("a", 64) + `","cookie":"xoxd-` + strings.Repeat("b", 32) + `"}`
	req, err := readRequest(strings.NewReader(valid))
	if err != nil || req.Token == "" || req.Cookie == "" {
		t.Fatalf("valid request rejected: %v", err)
	}
	for _, input := range []string{
		"{",
		valid + valid,
		strings.Repeat("x", maxInputBytes+1),
		`{"token":"xoxp-personal","cookie":"xoxd-valid"}`,
		`{"token":"xoxc-1-2-3-` + strings.Repeat("a", 64) + `","cookie":"bad"}`,
	} {
		if _, err := readRequest(strings.NewReader(input)); err == nil {
			t.Fatalf("malformed request accepted: %q", input[:min(len(input), 32)])
		}
	}
}

func TestIdentityOutputIsOnlyBoundedIdentity(t *testing.T) {
	data, err := marshalIdentityForTest(identity{TeamID: "T123", URL: "https://example.slack.com/"})
	if err != nil {
		t.Fatal(err)
	}
	if string(data) != `{"team_id":"T123","url":"https://example.slack.com/"}` {
		t.Fatalf("unexpected identity output: %s", data)
	}
	if bytes.Contains(data, []byte("xoxc-")) || bytes.Contains(data, []byte("xoxd-")) {
		t.Fatal("identity output contains credential-shaped data")
	}
}

func marshalIdentityForTest(value identity) ([]byte, error) {
	return json.Marshal(value)
}
