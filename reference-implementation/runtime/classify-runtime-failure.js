// Runtime-failure classification for the connector runtime.
//
// Maps a thrown Error to the stable `failure_reason` string carried on the
// terminal run.failed spine event. An explicit `err.failure_reason` wins;
// otherwise the message is matched against the known protocol-violation and
// interaction-handler shapes, defaulting to 'runtime_error'.
//
// Extracted from runtime/index.js: pure Error->reason mapping with no runtime
// state, secret handling, or grant/scope enforcement.

export function classifyRuntimeFailure(err) {
  if (typeof err?.failure_reason === 'string' && err.failure_reason.trim()) {
    return err.failure_reason;
  }
  const message = err?.message || '';
  if (
    message === 'Interaction handler returned an invalid INTERACTION_RESPONSE envelope'
    || message.startsWith('Invalid INTERACTION_RESPONSE status:')
  ) {
    return 'interaction_handler_invalid_response';
  }
  if (
    message === 'Connector emitted INTERACTION while already waiting'
    || message === 'Connector emitted INTERACTION but START.bindings omitted interactive'
    || message.includes(' while waiting for INTERACTION_RESPONSE')
    || message.startsWith('Connector emitted invalid INTERACTION.')
    || message.startsWith('Connector emitted invalid STATE.')
    || message.startsWith('Connector emitted INTERACTION for undeclared stream:')
    || message.startsWith('Connector emitted invalid PROGRESS.')
    || message.startsWith('Connector emitted invalid ASSISTANCE.')
    || message.startsWith('Connector emitted unsupported ASSISTANCE.')
    || message.startsWith('Connector emitted invalid SKIP_RESULT.')
    || message.startsWith('Connector emitted invalid DETAIL_GAP.')
    || message.startsWith('Connector emitted invalid DETAIL_COVERAGE.')
    || message.startsWith('Connector emitted invalid DETAIL_GAP_RECOVERED.')
    || message.startsWith('Connector emitted DETAIL_COVERAGE for undeclared stream:')
    || message.startsWith('Connector emitted DETAIL_GAP_RECOVERED for undeclared stream:')
    || message.startsWith('Connector detail coverage incomplete:')
    || message.startsWith('Connector emitted PROGRESS for undeclared stream:')
    || message.startsWith('Connector emitted SKIP_RESULT for undeclared stream:')
    || message.startsWith('Connector emitted DETAIL_GAP for undeclared stream:')
    || message.startsWith('Connector emitted invalid DONE status:')
    || message.startsWith('Connector emitted invalid DONE.error')
    || message.startsWith('Connector emitted invalid DONE.records_emitted:')
    || message.startsWith('Connector reported records_emitted ')
    || message.startsWith('Connector emitted RECORD')
    || message.startsWith('Connector emitted STATE')
    || message.startsWith('Connector emitted unknown message type:')
    || message.startsWith('Connector emitted invalid JSONL:')
    || message.startsWith('Connector exit code ')
    || (message.startsWith('Connector emitted ') && message.includes(' after DONE'))
  ) {
    return 'connector_protocol_violation';
  }
  return 'runtime_error';
}
