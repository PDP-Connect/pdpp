## 1. Manifest Contract

- [x] 1.1 Update manifest validation to reject `external_tools[].detect.command`.
- [x] 1.2 Validate `external_tools[].detect.executable` as a non-empty string when detection is declared.
- [x] 1.3 Validate `external_tools[].detect.args` as an optional array of strings.
- [x] 1.4 Update shipped manifests to use structured detection metadata.

## 2. Runtime Execution

- [x] 2.1 Remove the shell-string readiness runner.
- [x] 2.2 Route all external-tool detection through array-form child-process spawning with no shell.
- [x] 2.3 Preserve missing-tool readiness messages with tool name and install hint.

## 3. Verification

- [x] 3.1 Add manifest validation tests for accepted structured detection and rejected legacy `detect.command`.
- [x] 3.2 Add readiness tests proving shell metacharacters are not interpreted.
- [x] 3.3 Add a static guard that the readiness path does not use `shell: true`.
- [x] 3.4 Run `openspec validate harden-runtime-tool-detection --strict`.
- [x] 3.5 Run the targeted reference-implementation test suite for manifest validation and scheduler readiness.
