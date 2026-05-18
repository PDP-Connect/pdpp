export declare const FIXTURE_REMOTE_SURFACE_CAPABILITIES: {
    readonly eventChannel: "sse";
    readonly input: readonly ["pointer", "keyboard", "text", "paste", "touch", "scroll"];
    readonly clipboard: readonly ["local_to_remote", "remote_to_local", "manual_fallback"];
    readonly viewport: readonly ["report", "resize", "classify_occlusion"];
    readonly diagnostics: readonly ["events", "replay", "redacted_buffer"];
    readonly ownerBrowser: true;
    readonly serverSideAutomationEndpoint: true;
};
export declare const REMOTE_SURFACE_EVENT_FIXTURES: readonly [{
    readonly type: "frame";
    readonly sessionId: "session_fixture_1";
    readonly sequence: 42;
    readonly contentType: "image/jpeg";
    readonly data: "data:image/jpeg;base64,/9j/fixture";
    readonly timestamp: 1765600000001;
}, {
    readonly type: "backend_event";
    readonly sessionId: "session_fixture_1";
    readonly name: "url";
    readonly payload: {
        readonly url: "https://example.test/account";
    };
    readonly timestamp: 1765600000002;
}, {
    readonly type: "lifecycle";
    readonly sessionId: "session_fixture_1";
    readonly state: "ready";
    readonly timestamp: 1765600000003;
}];
export declare const REMOTE_SURFACE_INPUT_FIXTURES: readonly [{
    readonly type: "pointer";
    readonly action: "pointerdown";
    readonly x: 212;
    readonly y: 348;
    readonly pointerType: "touch";
    readonly pointerId: 7;
    readonly button: 0;
    readonly buttons: 1;
    readonly modifiers: readonly ["Shift"];
    readonly timestamp: 1765600000010;
}, {
    readonly type: "pointer";
    readonly action: "wheel";
    readonly x: 320;
    readonly y: 480;
    readonly pointerType: "mouse";
    readonly deltaX: 0;
    readonly deltaY: 180;
    readonly timestamp: 1765600000011;
}, {
    readonly type: "keyboard";
    readonly action: "keydown";
    readonly key: "Enter";
    readonly code: "Enter";
    readonly keysym: 65293;
    readonly modifiers: readonly ["Control", "Meta"];
    readonly timestamp: 1765600000012;
}, {
    readonly type: "text";
    readonly text: "hello";
    readonly composition: "commit";
    readonly timestamp: 1765600000013;
}, {
    readonly type: "clipboard";
    readonly action: "paste";
    readonly text: "paste fixture text";
    readonly timestamp: 1765600000014;
}];
export declare const REMOTE_SURFACE_VIEWPORT_FIXTURES: readonly [{
    readonly type: "viewport";
    readonly width: 390;
    readonly height: 844;
    readonly deviceScaleFactor: 3;
    readonly screenWidth: 390;
    readonly screenHeight: 844;
    readonly hasTouch: true;
    readonly mobile: true;
    readonly orientation: "portrait";
    readonly visualViewport: {
        readonly width: 390;
        readonly height: 520;
        readonly offsetTop: 0;
        readonly offsetLeft: 0;
        readonly scale: 1;
    };
    readonly keyboardOcclusion: {
        readonly visible: true;
        readonly height: 324;
        readonly reason: "software_keyboard";
    };
    readonly timestamp: 1765600000020;
}, {
    readonly type: "viewport";
    readonly width: 960;
    readonly height: 540;
    readonly deviceScaleFactor: 2;
    readonly screenWidth: 960;
    readonly screenHeight: 540;
    readonly hasTouch: true;
    readonly mobile: true;
    readonly orientation: "landscape";
    readonly timestamp: 1765600000021;
}];
export declare const REMOTE_SURFACE_CLIPBOARD_FIXTURES: readonly [{
    readonly type: "clipboard";
    readonly action: "capabilities";
    readonly canReadLocal: true;
    readonly canWriteLocal: true;
    readonly canReadRemote: true;
    readonly canWriteRemote: false;
    readonly timestamp: 1765600000030;
}, {
    readonly type: "clipboard";
    readonly action: "local_to_remote";
    readonly text: "copy fixture text";
    readonly timestamp: 1765600000031;
}, {
    readonly type: "clipboard";
    readonly action: "remote_to_local";
    readonly requestId: "clipboard_request_fixture_1";
    readonly timestamp: 1765600000032;
}];
export declare const REMOTE_SURFACE_TARGET_FIXTURES: readonly [{
    readonly targetId: "target_neko_fixture_1";
    readonly backend: "neko";
    readonly label: "Fixture n.eko target";
    readonly capabilities: {
        readonly eventChannel: "sse";
        readonly input: readonly ["pointer", "keyboard", "text", "paste", "touch", "scroll"];
        readonly clipboard: readonly ["local_to_remote", "remote_to_local", "manual_fallback"];
        readonly viewport: readonly ["report", "resize", "classify_occlusion"];
        readonly diagnostics: readonly ["events", "replay", "redacted_buffer"];
        readonly ownerBrowser: true;
        readonly serverSideAutomationEndpoint: true;
    };
    readonly clientDescriptor: {
        readonly backend: "neko";
        readonly capabilities: {
            readonly eventChannel: "sse";
            readonly input: readonly ["pointer", "keyboard", "text", "paste", "touch", "scroll"];
            readonly clipboard: readonly ["local_to_remote", "remote_to_local", "manual_fallback"];
            readonly viewport: readonly ["report", "resize", "classify_occlusion"];
            readonly diagnostics: readonly ["events", "replay", "redacted_buffer"];
            readonly ownerBrowser: true;
            readonly serverSideAutomationEndpoint: true;
        };
        readonly proxy: {
            readonly path: "/_remote-surface/session_fixture_1/neko/";
            readonly sameOrigin: true;
            readonly allowedMethods: readonly ["GET", "POST"];
        };
        readonly session: {
            readonly path: "/_remote-surface/session_fixture_1/neko/session";
            readonly sameOrigin: true;
            readonly expiresAt: 1765600300000;
        };
    };
    readonly hostMetadata: {
        readonly allocator: "reference-owned";
        readonly profile: "ephemeral";
    };
}, {
    readonly targetId: "target_cdp_fixture_1";
    readonly backend: "cdp";
    readonly label: "Fixture CDP fallback target";
    readonly capabilities: {
        readonly eventChannel: "sse";
        readonly input: readonly ["pointer", "keyboard", "text", "paste", "touch", "scroll"];
        readonly clipboard: readonly ["local_to_remote", "remote_to_local", "manual_fallback"];
        readonly viewport: readonly ["report", "resize", "classify_occlusion"];
        readonly diagnostics: readonly ["events", "replay", "redacted_buffer"];
        readonly ownerBrowser: true;
        readonly serverSideAutomationEndpoint: true;
    };
    readonly clientDescriptor: {
        readonly backend: "cdp";
        readonly capabilities: {
            readonly eventChannel: "sse";
            readonly input: readonly ["pointer", "keyboard", "text", "paste", "touch", "scroll"];
            readonly clipboard: readonly ["local_to_remote", "remote_to_local", "manual_fallback"];
            readonly viewport: readonly ["report", "resize", "classify_occlusion"];
            readonly diagnostics: readonly ["events", "replay", "redacted_buffer"];
            readonly ownerBrowser: true;
            readonly serverSideAutomationEndpoint: true;
        };
    };
}];
export declare const REMOTE_SURFACE_DIAGNOSTICS_FIXTURE: {
    readonly type: "diagnostics";
    readonly cursor: "3";
    readonly events: readonly [{
        readonly type: "input";
        readonly timestamp: 1765600000040;
        readonly payload: {
            readonly kind: "pointer";
            readonly action: "pointerdown";
            readonly x: 212;
            readonly y: 348;
        };
    }, {
        readonly type: "clipboard";
        readonly timestamp: 1765600000041;
        readonly payload: {
            readonly action: "local_to_remote";
            readonly textLength: 17;
            readonly redacted: true;
        };
    }, {
        readonly type: "viewport";
        readonly timestamp: 1765600000042;
        readonly payload: {
            readonly width: 390;
            readonly height: 844;
            readonly classification: "keyboard-occlusion";
        };
    }];
};
//# sourceMappingURL=protocol-fixtures.d.ts.map