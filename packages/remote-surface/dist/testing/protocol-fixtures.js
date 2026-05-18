export const FIXTURE_REMOTE_SURFACE_CAPABILITIES = {
    eventChannel: "sse",
    input: ["pointer", "keyboard", "text", "paste", "touch", "scroll"],
    clipboard: ["local_to_remote", "remote_to_local", "manual_fallback"],
    viewport: ["report", "resize", "classify_occlusion"],
    diagnostics: ["events", "replay", "redacted_buffer"],
    ownerBrowser: true,
    serverSideAutomationEndpoint: true,
};
export const REMOTE_SURFACE_EVENT_FIXTURES = [
    {
        type: "frame",
        sessionId: "session_fixture_1",
        sequence: 42,
        contentType: "image/jpeg",
        data: "data:image/jpeg;base64,/9j/fixture",
        timestamp: 1_765_600_000_001,
    },
    {
        type: "backend_event",
        sessionId: "session_fixture_1",
        name: "url",
        payload: { url: "https://example.test/account" },
        timestamp: 1_765_600_000_002,
    },
    {
        type: "lifecycle",
        sessionId: "session_fixture_1",
        state: "ready",
        timestamp: 1_765_600_000_003,
    },
];
export const REMOTE_SURFACE_INPUT_FIXTURES = [
    {
        type: "pointer",
        action: "pointerdown",
        x: 212,
        y: 348,
        pointerType: "touch",
        pointerId: 7,
        button: 0,
        buttons: 1,
        modifiers: ["Shift"],
        timestamp: 1_765_600_000_010,
    },
    {
        type: "pointer",
        action: "wheel",
        x: 320,
        y: 480,
        pointerType: "mouse",
        deltaX: 0,
        deltaY: 180,
        timestamp: 1_765_600_000_011,
    },
    {
        type: "keyboard",
        action: "keydown",
        key: "Enter",
        code: "Enter",
        keysym: 65_293,
        modifiers: ["Control", "Meta"],
        timestamp: 1_765_600_000_012,
    },
    {
        type: "text",
        text: "hello",
        composition: "commit",
        timestamp: 1_765_600_000_013,
    },
    {
        type: "clipboard",
        action: "paste",
        text: "paste fixture text",
        timestamp: 1_765_600_000_014,
    },
];
export const REMOTE_SURFACE_VIEWPORT_FIXTURES = [
    {
        type: "viewport",
        width: 390,
        height: 844,
        deviceScaleFactor: 3,
        screenWidth: 390,
        screenHeight: 844,
        hasTouch: true,
        mobile: true,
        orientation: "portrait",
        visualViewport: {
            width: 390,
            height: 520,
            offsetTop: 0,
            offsetLeft: 0,
            scale: 1,
        },
        keyboardOcclusion: {
            visible: true,
            height: 324,
            reason: "software_keyboard",
        },
        timestamp: 1_765_600_000_020,
    },
    {
        type: "viewport",
        width: 960,
        height: 540,
        deviceScaleFactor: 2,
        screenWidth: 960,
        screenHeight: 540,
        hasTouch: true,
        mobile: true,
        orientation: "landscape",
        timestamp: 1_765_600_000_021,
    },
];
export const REMOTE_SURFACE_CLIPBOARD_FIXTURES = [
    {
        type: "clipboard",
        action: "capabilities",
        canReadLocal: true,
        canWriteLocal: true,
        canReadRemote: true,
        canWriteRemote: false,
        timestamp: 1_765_600_000_030,
    },
    {
        type: "clipboard",
        action: "local_to_remote",
        text: "copy fixture text",
        timestamp: 1_765_600_000_031,
    },
    {
        type: "clipboard",
        action: "remote_to_local",
        requestId: "clipboard_request_fixture_1",
        timestamp: 1_765_600_000_032,
    },
];
export const REMOTE_SURFACE_TARGET_FIXTURES = [
    {
        targetId: "target_neko_fixture_1",
        backend: "neko",
        label: "Fixture n.eko target",
        capabilities: FIXTURE_REMOTE_SURFACE_CAPABILITIES,
        clientDescriptor: {
            backend: "neko",
            capabilities: FIXTURE_REMOTE_SURFACE_CAPABILITIES,
            proxy: {
                path: "/_remote-surface/session_fixture_1/neko/",
                sameOrigin: true,
                allowedMethods: ["GET", "POST"],
            },
            session: {
                path: "/_remote-surface/session_fixture_1/neko/session",
                sameOrigin: true,
                expiresAt: 1_765_600_300_000,
            },
        },
        hostMetadata: {
            allocator: "reference-owned",
            profile: "ephemeral",
        },
    },
    {
        targetId: "target_cdp_fixture_1",
        backend: "cdp",
        label: "Fixture CDP fallback target",
        capabilities: FIXTURE_REMOTE_SURFACE_CAPABILITIES,
        clientDescriptor: {
            backend: "cdp",
            capabilities: FIXTURE_REMOTE_SURFACE_CAPABILITIES,
        },
    },
];
export const REMOTE_SURFACE_DIAGNOSTICS_FIXTURE = {
    type: "diagnostics",
    cursor: "3",
    events: [
        {
            type: "input",
            timestamp: 1_765_600_000_040,
            payload: {
                kind: "pointer",
                action: "pointerdown",
                x: 212,
                y: 348,
            },
        },
        {
            type: "clipboard",
            timestamp: 1_765_600_000_041,
            payload: {
                action: "local_to_remote",
                textLength: 17,
                redacted: true,
            },
        },
        {
            type: "viewport",
            timestamp: 1_765_600_000_042,
            payload: {
                width: 390,
                height: 844,
                classification: "keyboard-occlusion",
            },
        },
    ],
};
//# sourceMappingURL=protocol-fixtures.js.map