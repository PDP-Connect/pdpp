// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// slackdump-identity is the credential-free-output companion for the pinned
// Slackdump runtime. Credentials enter only through stdin; the public
// Slackdump API performs exactly one AuthTest during slackdump.New.
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"regexp"
	"time"

	"github.com/rusq/slackdump/v3"
	"github.com/rusq/slackdump/v3/auth"
)

const (
	helperVersion   = "3.1.13"
	helperSource    = "github.com/rusq/slackdump/v3@v3.1.13"
	maxInputBytes   = 8192
	maxIdentitySize = 1024
	identityTimeout = 15 * time.Second
)

var (
	clientTokenRE = regexp.MustCompile(`^xoxc-[0-9]+-[0-9]+-[0-9]+-[0-9a-z]{64}$`)
	dCookieRE     = regexp.MustCompile(`^xoxd-[A-Za-z0-9%._~-]+$`)
)

type request struct {
	Token  string `json:"token"`
	Cookie string `json:"cookie"`
}

type identity struct {
	TeamID string `json:"team_id"`
	URL    string `json:"url"`
}

func main() {
	if len(os.Args) == 2 && os.Args[1] == "--version" {
		fmt.Printf("pdpp-slackdump-identity/%s %s\n", helperVersion, helperSource)
		return
	}
	if len(os.Args) != 1 {
		fail()
	}

	req, err := readRequest(os.Stdin)
	if err != nil {
		fail()
	}
	prov, err := auth.NewValueAuth(req.Token, req.Cookie)
	if err != nil {
		fail()
	}
	ctx, cancel := context.WithTimeout(context.Background(), identityTimeout)
	defer cancel()
	sess, err := slackdump.New(ctx, prov)
	if err != nil {
		fail()
	}
	info := sess.Info()
	if info == nil || info.TeamID == "" || info.URL == "" || len(info.TeamID) > 128 || len(info.URL) > 512 {
		fail()
	}
	out, err := json.Marshal(identity{TeamID: info.TeamID, URL: info.URL})
	if err != nil || len(out) > maxIdentitySize {
		fail()
	}
	if _, err := io.Copy(os.Stdout, bytes.NewReader(append(out, '\n'))); err != nil {
		fail()
	}
}

func readRequest(r io.Reader) (request, error) {
	data, err := io.ReadAll(io.LimitReader(r, maxInputBytes+1))
	if err != nil || len(data) > maxInputBytes {
		return request{}, errors.New("invalid request")
	}
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.DisallowUnknownFields()
	var req request
	if err := dec.Decode(&req); err != nil {
		return request{}, errors.New("invalid request")
	}
	var extra any
	if err := dec.Decode(&extra); err != io.EOF {
		return request{}, errors.New("invalid request")
	}
	if len(req.Token) > 256 || len(req.Cookie) > 4096 || !clientTokenRE.MatchString(req.Token) || !dCookieRE.MatchString(req.Cookie) {
		return request{}, errors.New("invalid request")
	}
	return req, nil
}

func fail() {
	_, _ = io.WriteString(os.Stderr, "slackdump_identity_unavailable\n")
	os.Exit(1)
}
