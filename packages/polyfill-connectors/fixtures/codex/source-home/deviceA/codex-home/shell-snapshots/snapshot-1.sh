#!/bin/bash
# Synthetic shell snapshot fixture
export FAKE_API_KEY=FIXTURE_FAKE_SHELL_EXPORT_SECRET_DO_NOT_COLLECT
alias deploy='curl -H "authorization: Bearer FIXTURE_FAKE_SHELL_BEARER_DO_NOT_COLLECT"'
