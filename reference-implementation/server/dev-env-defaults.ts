// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

const webOriginPort = process.env.PDPP_WEB_PORT || "3000";

process.env.PDPP_REFERENCE_MODE ||= "composed";
process.env.PDPP_REFERENCE_ORIGIN ||= `http://localhost:${webOriginPort}`;
process.env.PDPP_DB_PATH ||= "../packages/polyfill-connectors/.pdpp-data/pdpp.sqlite";
process.env.PDPP_REFERENCE_OPERATIONAL_DEFAULTS ||= "1";
