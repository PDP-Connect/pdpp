export const REFERENCE_WIRE_TOKEN = "stream_token_fixture";
export const REFERENCE_WIRE_RUN_ID = "run_fixture";
export const REFERENCE_WIRE_INTERACTION_ID = "int_fixture";
export const REFERENCE_WIRE_BROWSER_SESSION_ID = "browser_session_fixture";
export const REFERENCE_WIRE_MINT_REQUEST_FIXTURE = {
    interaction_id: REFERENCE_WIRE_INTERACTION_ID,
    idempotency_key: "mint_key_fixture",
    viewport: {
        width: 390,
        height: 844,
        screenWidth: 1170,
        screenHeight: 2532,
        deviceScaleFactor: 3,
        hasTouch: true,
        mobile: true,
        userAgent: "Mozilla/5.0 fixture",
    },
};
export const REFERENCE_WIRE_MINT_RESPONSE_FIXTURE = {
    object: "run_interaction_stream_session",
    run_id: REFERENCE_WIRE_RUN_ID,
    interaction_id: REFERENCE_WIRE_INTERACTION_ID,
    browser_session_id: REFERENCE_WIRE_BROWSER_SESSION_ID,
    token: REFERENCE_WIRE_TOKEN,
    expires_at_ms: 1_770_000_000_000,
    idempotency_replayed: false,
    viewer_path: `/_ref/run-interaction-streams/${REFERENCE_WIRE_TOKEN}/events`,
    input_path: `/_ref/run-interaction-streams/${REFERENCE_WIRE_TOKEN}/input`,
    viewport_path: `/_ref/run-interaction-streams/${REFERENCE_WIRE_TOKEN}/viewport`,
};
export const REFERENCE_WIRE_SSE_EVENT_FIXTURES = [
    {
        event: "attached",
        data: {
            run_id: REFERENCE_WIRE_RUN_ID,
            interaction_id: REFERENCE_WIRE_INTERACTION_ID,
            browser_session_id: REFERENCE_WIRE_BROWSER_SESSION_ID,
            viewport: {
                width: 390,
                height: 844,
                screenWidth: 1170,
                screenHeight: 2532,
                deviceScaleFactor: 3,
                hasTouch: true,
                mobile: true,
            },
        },
    },
    {
        event: "frame",
        data: {
            session_id: 7,
            data_base64: "/9j/4AAQSkZJRgABAQfixture",
            metadata: {
                device_width: 390,
                device_height: 844,
                offset_top: 0,
                page_scale_factor: 1,
                timestamp: 1_770_000_000,
                scroll_offset_x: 0,
                scroll_offset_y: 0,
            },
        },
    },
    {
        event: "backend_ready",
        data: {
            backend: "neko",
            browser_owner_mode: "interactive",
            client_config_path: `/_ref/run-interaction-streams/${REFERENCE_WIRE_TOKEN}/neko/session`,
            iframe_path: `/_ref/run-interaction-streams/${REFERENCE_WIRE_TOKEN}/neko`,
            stealth_mode: "strict",
        },
    },
    {
        event: "url_changed",
        data: {
            url: "https://example.invalid/account",
            title: "Fixture Account",
        },
    },
    {
        event: "popup_opened",
        data: {
            targetId: "target_popup_fixture",
            url: "https://example.invalid/popup",
        },
    },
    {
        event: "popup_closed",
        data: {
            targetId: "target_popup_fixture",
        },
    },
    {
        event: "clipboard",
        data: {
            kind: "clipboard",
            text: "clipboard fixture text",
        },
    },
    {
        event: "keyboard_focus",
        data: {
            kind: "keyboard_focus",
            focused: true,
            element: {
                type: "focus",
                tagName: "INPUT",
                inputType: "password",
                id: "",
                name: "",
                x: 10,
                y: 20,
                width: 200,
                height: 32,
            },
        },
    },
    {
        event: "error",
        data: {
            code: "streaming_target_unregistered",
            message: "No streaming target registered for this run",
        },
    },
];
export const REFERENCE_WIRE_INPUT_PAYLOAD_FIXTURES = [
    {
        type: "mouse",
        action: "mousemove",
        x: 120,
        y: 240,
        correlationId: "corr_fixture",
        wireSeq: 1,
    },
    {
        type: "mouse",
        action: "mousedown",
        x: 120,
        y: 240,
        button: 0,
        correlationId: "corr_fixture",
        wireSeq: 2,
    },
    {
        type: "mouse",
        action: "mouseup",
        x: 120,
        y: 240,
        button: 0,
        correlationId: "corr_fixture",
        wireSeq: 3,
    },
    {
        type: "keyboard",
        action: "keydown",
        key: "Enter",
        code: "Enter",
        modifiers: 0,
    },
    {
        type: "keyboard",
        action: "keyup",
        key: "A",
        code: "KeyA",
        modifiers: 8,
    },
    {
        type: "touch",
        action: "touchstart",
        x: 100,
        y: 200,
        id: 12,
    },
    {
        type: "touch",
        action: "touchend",
        x: 0,
        y: 0,
    },
    {
        type: "scroll",
        x: 120,
        y: 240,
        deltaX: 0,
        deltaY: 100,
    },
    {
        type: "paste",
        text: "paste fixture text",
    },
];
export const REFERENCE_WIRE_INPUT_ACK_FIXTURE = {
    object: "run_interaction_stream_input_ack",
};
export const REFERENCE_WIRE_VIEWPORT_PAYLOAD_FIXTURE = {
    width: 1280,
    height: 720,
    screenWidth: 1280,
    screenHeight: 720,
    deviceScaleFactor: 1,
    hasTouch: false,
    mobile: false,
    userAgent: "Mozilla/5.0 fixture",
};
export const REFERENCE_WIRE_VIEWPORT_ACK_FIXTURE = {
    object: "run_interaction_stream_viewport_ack",
    viewport: {
        width: 1280,
        height: 720,
        screenWidth: 1280,
        screenHeight: 720,
        deviceScaleFactor: 1,
    },
};
export const REFERENCE_WIRE_NEKO_CLIENT_CONFIG_FIXTURE = {
    object: "run_interaction_neko_client",
    server_path: "/neko",
    status_path: "/neko/__pdpp/status",
    login: {
        username: "user",
        password: "neko",
    },
};
export const REFERENCE_WIRE_NEKO_STATUS_FIXTURES = [
    {
        object: "run_interaction_neko_status",
        control_available: false,
    },
    {
        object: "run_interaction_neko_status",
        control_available: true,
        status: {
            page_cdp_available: true,
            redacted: true,
        },
    },
];
export const REFERENCE_WIRE_TARGET_REGISTRATION_RESPONSE_FIXTURE = {
    object: "run_streaming_target",
    run_id: REFERENCE_WIRE_RUN_ID,
    interaction_id: REFERENCE_WIRE_INTERACTION_ID,
    expiry: 1_770_000_300_000,
    action: "registered",
};
export const REFERENCE_WIRE_TARGET_DELETE_RESPONSE_FIXTURE = {
    object: "run_streaming_target_deleted",
    run_id: REFERENCE_WIRE_RUN_ID,
    interaction_id: REFERENCE_WIRE_INTERACTION_ID,
};
export const REFERENCE_WIRE_BROWSER_VISIBLE_TARGET_DESCRIPTORS = [
    {
        backend: "neko",
        iframe_path: `/_ref/run-interaction-streams/${REFERENCE_WIRE_TOKEN}/neko`,
        client_config_path: `/_ref/run-interaction-streams/${REFERENCE_WIRE_TOKEN}/neko/session`,
        browser_owner_mode: "interactive",
        stealth_mode: "strict",
    },
    {
        backend: "cdp",
        iframe_path: null,
        client_config_path: null,
        browser_owner_mode: null,
        stealth_mode: null,
    },
];
export const REFERENCE_WIRE_INPUT_TELEMETRY_FIXTURE = {
    object: "run_interaction_stream_input_telemetry",
    seq: 3,
    records: [
        {
            seq: 1,
            serverAtMs: 1_770_000_000_001,
            source: "server",
            kind: "wire.input.received",
            correlationId: "corr_fixture",
            wireSeq: 1,
            action: "click",
            eventType: "mouse",
            x: 120,
            y: 240,
        },
        {
            seq: 2,
            serverAtMs: 1_770_000_000_002,
            source: "server",
            kind: "wire.input.dispatched",
            correlationId: "corr_fixture",
            wireSeq: 1,
            action: "click",
            eventType: "mouse",
        },
        {
            seq: 3,
            serverAtMs: 1_770_000_000_003,
            source: "remote",
            kind: "remote.pointer.mapped",
            correlationId: "corr_fixture",
            wireSeq: 1,
            x: 120,
            y: 240,
        },
    ],
};
export const REFERENCE_WIRE_DIAGNOSTICS_RECORD_FIXTURES = [
    {
        type: "input",
        timestamp: 1_770_000_000_010,
        payload: {
            kind: "wire.input.received",
            eventType: "paste",
            textLength: 18,
            redacted: true,
        },
    },
    {
        type: "clipboard",
        timestamp: 1_770_000_000_011,
        payload: {
            action: "remote_to_local",
            textLength: 22,
            redacted: true,
        },
    },
    {
        type: "viewport",
        timestamp: 1_770_000_000_012,
        payload: {
            width: 390,
            height: 844,
            classification: "keyboard-occlusion",
            remoteResize: "hold",
        },
    },
    {
        type: "backend_ready",
        timestamp: 1_770_000_000_013,
        payload: {
            backend: "neko",
            proxy: "same-origin",
            cdpEndpoint: "redacted",
        },
    },
];
export const REFERENCE_WIRE_BROWSER_VISIBLE_FIXTURES = {
    mintResponse: REFERENCE_WIRE_MINT_RESPONSE_FIXTURE,
    sseEvents: REFERENCE_WIRE_SSE_EVENT_FIXTURES,
    inputAck: REFERENCE_WIRE_INPUT_ACK_FIXTURE,
    viewportAck: REFERENCE_WIRE_VIEWPORT_ACK_FIXTURE,
    nekoClientConfig: REFERENCE_WIRE_NEKO_CLIENT_CONFIG_FIXTURE,
    nekoStatus: REFERENCE_WIRE_NEKO_STATUS_FIXTURES,
    targetRegistrationResponse: REFERENCE_WIRE_TARGET_REGISTRATION_RESPONSE_FIXTURE,
    targetDeleteResponse: REFERENCE_WIRE_TARGET_DELETE_RESPONSE_FIXTURE,
    targetDescriptors: REFERENCE_WIRE_BROWSER_VISIBLE_TARGET_DESCRIPTORS,
    inputTelemetry: REFERENCE_WIRE_INPUT_TELEMETRY_FIXTURE,
    diagnosticsRecords: REFERENCE_WIRE_DIAGNOSTICS_RECORD_FIXTURES,
};
export const REFERENCE_WIRE_ALL_FIXTURES = {
    mintRequest: REFERENCE_WIRE_MINT_REQUEST_FIXTURE,
    viewportPayload: REFERENCE_WIRE_VIEWPORT_PAYLOAD_FIXTURE,
    inputPayloads: REFERENCE_WIRE_INPUT_PAYLOAD_FIXTURES,
    ...REFERENCE_WIRE_BROWSER_VISIBLE_FIXTURES,
};
//# sourceMappingURL=reference-wire-fixtures.js.map