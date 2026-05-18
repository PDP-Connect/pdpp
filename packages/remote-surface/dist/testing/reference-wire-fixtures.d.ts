import type { JsonObject, JsonValue } from "../protocol/index.ts";
export type ReferenceWireFixture = JsonObject | readonly JsonValue[];
export declare const REFERENCE_WIRE_TOKEN = "stream_token_fixture";
export declare const REFERENCE_WIRE_RUN_ID = "run_fixture";
export declare const REFERENCE_WIRE_INTERACTION_ID = "int_fixture";
export declare const REFERENCE_WIRE_BROWSER_SESSION_ID = "browser_session_fixture";
export declare const REFERENCE_WIRE_MINT_REQUEST_FIXTURE: {
    readonly interaction_id: "int_fixture";
    readonly idempotency_key: "mint_key_fixture";
    readonly viewport: {
        readonly width: 390;
        readonly height: 844;
        readonly screenWidth: 1170;
        readonly screenHeight: 2532;
        readonly deviceScaleFactor: 3;
        readonly hasTouch: true;
        readonly mobile: true;
        readonly userAgent: "Mozilla/5.0 fixture";
    };
};
export declare const REFERENCE_WIRE_MINT_RESPONSE_FIXTURE: {
    readonly object: "run_interaction_stream_session";
    readonly run_id: "run_fixture";
    readonly interaction_id: "int_fixture";
    readonly browser_session_id: "browser_session_fixture";
    readonly token: "stream_token_fixture";
    readonly expires_at_ms: 1770000000000;
    readonly idempotency_replayed: false;
    readonly viewer_path: "/_ref/run-interaction-streams/stream_token_fixture/events";
    readonly input_path: "/_ref/run-interaction-streams/stream_token_fixture/input";
    readonly viewport_path: "/_ref/run-interaction-streams/stream_token_fixture/viewport";
};
export declare const REFERENCE_WIRE_SSE_EVENT_FIXTURES: readonly [{
    readonly event: "attached";
    readonly data: {
        readonly run_id: "run_fixture";
        readonly interaction_id: "int_fixture";
        readonly browser_session_id: "browser_session_fixture";
        readonly viewport: {
            readonly width: 390;
            readonly height: 844;
            readonly screenWidth: 1170;
            readonly screenHeight: 2532;
            readonly deviceScaleFactor: 3;
            readonly hasTouch: true;
            readonly mobile: true;
        };
    };
}, {
    readonly event: "frame";
    readonly data: {
        readonly session_id: 7;
        readonly data_base64: "/9j/4AAQSkZJRgABAQfixture";
        readonly metadata: {
            readonly device_width: 390;
            readonly device_height: 844;
            readonly offset_top: 0;
            readonly page_scale_factor: 1;
            readonly timestamp: 1770000000;
            readonly scroll_offset_x: 0;
            readonly scroll_offset_y: 0;
        };
    };
}, {
    readonly event: "backend_ready";
    readonly data: {
        readonly backend: "neko";
        readonly browser_owner_mode: "interactive";
        readonly client_config_path: "/_ref/run-interaction-streams/stream_token_fixture/neko/session";
        readonly iframe_path: "/_ref/run-interaction-streams/stream_token_fixture/neko";
        readonly stealth_mode: "strict";
    };
}, {
    readonly event: "url_changed";
    readonly data: {
        readonly url: "https://example.invalid/account";
        readonly title: "Fixture Account";
    };
}, {
    readonly event: "popup_opened";
    readonly data: {
        readonly targetId: "target_popup_fixture";
        readonly url: "https://example.invalid/popup";
    };
}, {
    readonly event: "popup_closed";
    readonly data: {
        readonly targetId: "target_popup_fixture";
    };
}, {
    readonly event: "clipboard";
    readonly data: {
        readonly kind: "clipboard";
        readonly text: "clipboard fixture text";
    };
}, {
    readonly event: "keyboard_focus";
    readonly data: {
        readonly kind: "keyboard_focus";
        readonly focused: true;
        readonly element: {
            readonly type: "focus";
            readonly tagName: "INPUT";
            readonly inputType: "password";
            readonly id: "";
            readonly name: "";
            readonly x: 10;
            readonly y: 20;
            readonly width: 200;
            readonly height: 32;
        };
    };
}, {
    readonly event: "error";
    readonly data: {
        readonly code: "streaming_target_unregistered";
        readonly message: "No streaming target registered for this run";
    };
}];
export declare const REFERENCE_WIRE_INPUT_PAYLOAD_FIXTURES: readonly [{
    readonly type: "mouse";
    readonly action: "mousemove";
    readonly x: 120;
    readonly y: 240;
    readonly correlationId: "corr_fixture";
    readonly wireSeq: 1;
}, {
    readonly type: "mouse";
    readonly action: "mousedown";
    readonly x: 120;
    readonly y: 240;
    readonly button: 0;
    readonly correlationId: "corr_fixture";
    readonly wireSeq: 2;
}, {
    readonly type: "mouse";
    readonly action: "mouseup";
    readonly x: 120;
    readonly y: 240;
    readonly button: 0;
    readonly correlationId: "corr_fixture";
    readonly wireSeq: 3;
}, {
    readonly type: "keyboard";
    readonly action: "keydown";
    readonly key: "Enter";
    readonly code: "Enter";
    readonly modifiers: 0;
}, {
    readonly type: "keyboard";
    readonly action: "keyup";
    readonly key: "A";
    readonly code: "KeyA";
    readonly modifiers: 8;
}, {
    readonly type: "touch";
    readonly action: "touchstart";
    readonly x: 100;
    readonly y: 200;
    readonly id: 12;
}, {
    readonly type: "touch";
    readonly action: "touchend";
    readonly x: 0;
    readonly y: 0;
}, {
    readonly type: "scroll";
    readonly x: 120;
    readonly y: 240;
    readonly deltaX: 0;
    readonly deltaY: 100;
}, {
    readonly type: "paste";
    readonly text: "paste fixture text";
}];
export declare const REFERENCE_WIRE_INPUT_ACK_FIXTURE: {
    readonly object: "run_interaction_stream_input_ack";
};
export declare const REFERENCE_WIRE_VIEWPORT_PAYLOAD_FIXTURE: {
    readonly width: 1280;
    readonly height: 720;
    readonly screenWidth: 1280;
    readonly screenHeight: 720;
    readonly deviceScaleFactor: 1;
    readonly hasTouch: false;
    readonly mobile: false;
    readonly userAgent: "Mozilla/5.0 fixture";
};
export declare const REFERENCE_WIRE_VIEWPORT_ACK_FIXTURE: {
    readonly object: "run_interaction_stream_viewport_ack";
    readonly viewport: {
        readonly width: 1280;
        readonly height: 720;
        readonly screenWidth: 1280;
        readonly screenHeight: 720;
        readonly deviceScaleFactor: 1;
    };
};
export declare const REFERENCE_WIRE_NEKO_CLIENT_CONFIG_FIXTURE: {
    readonly object: "run_interaction_neko_client";
    readonly server_path: "/neko";
    readonly status_path: "/neko/__pdpp/status";
    readonly login: {
        readonly username: "user";
        readonly password: "neko";
    };
};
export declare const REFERENCE_WIRE_NEKO_STATUS_FIXTURES: readonly [{
    readonly object: "run_interaction_neko_status";
    readonly control_available: false;
}, {
    readonly object: "run_interaction_neko_status";
    readonly control_available: true;
    readonly status: {
        readonly page_cdp_available: true;
        readonly redacted: true;
    };
}];
export declare const REFERENCE_WIRE_TARGET_REGISTRATION_RESPONSE_FIXTURE: {
    readonly object: "run_streaming_target";
    readonly run_id: "run_fixture";
    readonly interaction_id: "int_fixture";
    readonly expiry: 1770000300000;
    readonly action: "registered";
};
export declare const REFERENCE_WIRE_TARGET_DELETE_RESPONSE_FIXTURE: {
    readonly object: "run_streaming_target_deleted";
    readonly run_id: "run_fixture";
    readonly interaction_id: "int_fixture";
};
export declare const REFERENCE_WIRE_BROWSER_VISIBLE_TARGET_DESCRIPTORS: readonly [{
    readonly backend: "neko";
    readonly iframe_path: "/_ref/run-interaction-streams/stream_token_fixture/neko";
    readonly client_config_path: "/_ref/run-interaction-streams/stream_token_fixture/neko/session";
    readonly browser_owner_mode: "interactive";
    readonly stealth_mode: "strict";
}, {
    readonly backend: "cdp";
    readonly iframe_path: null;
    readonly client_config_path: null;
    readonly browser_owner_mode: null;
    readonly stealth_mode: null;
}];
export declare const REFERENCE_WIRE_INPUT_TELEMETRY_FIXTURE: {
    readonly object: "run_interaction_stream_input_telemetry";
    readonly seq: 3;
    readonly records: [{
        readonly seq: 1;
        readonly serverAtMs: 1770000000001;
        readonly source: "server";
        readonly kind: "wire.input.received";
        readonly correlationId: "corr_fixture";
        readonly wireSeq: 1;
        readonly action: "click";
        readonly eventType: "mouse";
        readonly x: 120;
        readonly y: 240;
    }, {
        readonly seq: 2;
        readonly serverAtMs: 1770000000002;
        readonly source: "server";
        readonly kind: "wire.input.dispatched";
        readonly correlationId: "corr_fixture";
        readonly wireSeq: 1;
        readonly action: "click";
        readonly eventType: "mouse";
    }, {
        readonly seq: 3;
        readonly serverAtMs: 1770000000003;
        readonly source: "remote";
        readonly kind: "remote.pointer.mapped";
        readonly correlationId: "corr_fixture";
        readonly wireSeq: 1;
        readonly x: 120;
        readonly y: 240;
    }];
};
export declare const REFERENCE_WIRE_DIAGNOSTICS_RECORD_FIXTURES: readonly [{
    readonly type: "input";
    readonly timestamp: 1770000000010;
    readonly payload: {
        readonly kind: "wire.input.received";
        readonly eventType: "paste";
        readonly textLength: 18;
        readonly redacted: true;
    };
}, {
    readonly type: "clipboard";
    readonly timestamp: 1770000000011;
    readonly payload: {
        readonly action: "remote_to_local";
        readonly textLength: 22;
        readonly redacted: true;
    };
}, {
    readonly type: "viewport";
    readonly timestamp: 1770000000012;
    readonly payload: {
        readonly width: 390;
        readonly height: 844;
        readonly classification: "keyboard-occlusion";
        readonly remoteResize: "hold";
    };
}, {
    readonly type: "backend_ready";
    readonly timestamp: 1770000000013;
    readonly payload: {
        readonly backend: "neko";
        readonly proxy: "same-origin";
        readonly cdpEndpoint: "redacted";
    };
}];
export declare const REFERENCE_WIRE_BROWSER_VISIBLE_FIXTURES: {
    readonly mintResponse: {
        readonly object: "run_interaction_stream_session";
        readonly run_id: "run_fixture";
        readonly interaction_id: "int_fixture";
        readonly browser_session_id: "browser_session_fixture";
        readonly token: "stream_token_fixture";
        readonly expires_at_ms: 1770000000000;
        readonly idempotency_replayed: false;
        readonly viewer_path: "/_ref/run-interaction-streams/stream_token_fixture/events";
        readonly input_path: "/_ref/run-interaction-streams/stream_token_fixture/input";
        readonly viewport_path: "/_ref/run-interaction-streams/stream_token_fixture/viewport";
    };
    readonly sseEvents: readonly [{
        readonly event: "attached";
        readonly data: {
            readonly run_id: "run_fixture";
            readonly interaction_id: "int_fixture";
            readonly browser_session_id: "browser_session_fixture";
            readonly viewport: {
                readonly width: 390;
                readonly height: 844;
                readonly screenWidth: 1170;
                readonly screenHeight: 2532;
                readonly deviceScaleFactor: 3;
                readonly hasTouch: true;
                readonly mobile: true;
            };
        };
    }, {
        readonly event: "frame";
        readonly data: {
            readonly session_id: 7;
            readonly data_base64: "/9j/4AAQSkZJRgABAQfixture";
            readonly metadata: {
                readonly device_width: 390;
                readonly device_height: 844;
                readonly offset_top: 0;
                readonly page_scale_factor: 1;
                readonly timestamp: 1770000000;
                readonly scroll_offset_x: 0;
                readonly scroll_offset_y: 0;
            };
        };
    }, {
        readonly event: "backend_ready";
        readonly data: {
            readonly backend: "neko";
            readonly browser_owner_mode: "interactive";
            readonly client_config_path: "/_ref/run-interaction-streams/stream_token_fixture/neko/session";
            readonly iframe_path: "/_ref/run-interaction-streams/stream_token_fixture/neko";
            readonly stealth_mode: "strict";
        };
    }, {
        readonly event: "url_changed";
        readonly data: {
            readonly url: "https://example.invalid/account";
            readonly title: "Fixture Account";
        };
    }, {
        readonly event: "popup_opened";
        readonly data: {
            readonly targetId: "target_popup_fixture";
            readonly url: "https://example.invalid/popup";
        };
    }, {
        readonly event: "popup_closed";
        readonly data: {
            readonly targetId: "target_popup_fixture";
        };
    }, {
        readonly event: "clipboard";
        readonly data: {
            readonly kind: "clipboard";
            readonly text: "clipboard fixture text";
        };
    }, {
        readonly event: "keyboard_focus";
        readonly data: {
            readonly kind: "keyboard_focus";
            readonly focused: true;
            readonly element: {
                readonly type: "focus";
                readonly tagName: "INPUT";
                readonly inputType: "password";
                readonly id: "";
                readonly name: "";
                readonly x: 10;
                readonly y: 20;
                readonly width: 200;
                readonly height: 32;
            };
        };
    }, {
        readonly event: "error";
        readonly data: {
            readonly code: "streaming_target_unregistered";
            readonly message: "No streaming target registered for this run";
        };
    }];
    readonly inputAck: {
        readonly object: "run_interaction_stream_input_ack";
    };
    readonly viewportAck: {
        readonly object: "run_interaction_stream_viewport_ack";
        readonly viewport: {
            readonly width: 1280;
            readonly height: 720;
            readonly screenWidth: 1280;
            readonly screenHeight: 720;
            readonly deviceScaleFactor: 1;
        };
    };
    readonly nekoClientConfig: {
        readonly object: "run_interaction_neko_client";
        readonly server_path: "/neko";
        readonly status_path: "/neko/__pdpp/status";
        readonly login: {
            readonly username: "user";
            readonly password: "neko";
        };
    };
    readonly nekoStatus: readonly [{
        readonly object: "run_interaction_neko_status";
        readonly control_available: false;
    }, {
        readonly object: "run_interaction_neko_status";
        readonly control_available: true;
        readonly status: {
            readonly page_cdp_available: true;
            readonly redacted: true;
        };
    }];
    readonly targetRegistrationResponse: {
        readonly object: "run_streaming_target";
        readonly run_id: "run_fixture";
        readonly interaction_id: "int_fixture";
        readonly expiry: 1770000300000;
        readonly action: "registered";
    };
    readonly targetDeleteResponse: {
        readonly object: "run_streaming_target_deleted";
        readonly run_id: "run_fixture";
        readonly interaction_id: "int_fixture";
    };
    readonly targetDescriptors: readonly [{
        readonly backend: "neko";
        readonly iframe_path: "/_ref/run-interaction-streams/stream_token_fixture/neko";
        readonly client_config_path: "/_ref/run-interaction-streams/stream_token_fixture/neko/session";
        readonly browser_owner_mode: "interactive";
        readonly stealth_mode: "strict";
    }, {
        readonly backend: "cdp";
        readonly iframe_path: null;
        readonly client_config_path: null;
        readonly browser_owner_mode: null;
        readonly stealth_mode: null;
    }];
    readonly inputTelemetry: {
        readonly object: "run_interaction_stream_input_telemetry";
        readonly seq: 3;
        readonly records: [{
            readonly seq: 1;
            readonly serverAtMs: 1770000000001;
            readonly source: "server";
            readonly kind: "wire.input.received";
            readonly correlationId: "corr_fixture";
            readonly wireSeq: 1;
            readonly action: "click";
            readonly eventType: "mouse";
            readonly x: 120;
            readonly y: 240;
        }, {
            readonly seq: 2;
            readonly serverAtMs: 1770000000002;
            readonly source: "server";
            readonly kind: "wire.input.dispatched";
            readonly correlationId: "corr_fixture";
            readonly wireSeq: 1;
            readonly action: "click";
            readonly eventType: "mouse";
        }, {
            readonly seq: 3;
            readonly serverAtMs: 1770000000003;
            readonly source: "remote";
            readonly kind: "remote.pointer.mapped";
            readonly correlationId: "corr_fixture";
            readonly wireSeq: 1;
            readonly x: 120;
            readonly y: 240;
        }];
    };
    readonly diagnosticsRecords: readonly [{
        readonly type: "input";
        readonly timestamp: 1770000000010;
        readonly payload: {
            readonly kind: "wire.input.received";
            readonly eventType: "paste";
            readonly textLength: 18;
            readonly redacted: true;
        };
    }, {
        readonly type: "clipboard";
        readonly timestamp: 1770000000011;
        readonly payload: {
            readonly action: "remote_to_local";
            readonly textLength: 22;
            readonly redacted: true;
        };
    }, {
        readonly type: "viewport";
        readonly timestamp: 1770000000012;
        readonly payload: {
            readonly width: 390;
            readonly height: 844;
            readonly classification: "keyboard-occlusion";
            readonly remoteResize: "hold";
        };
    }, {
        readonly type: "backend_ready";
        readonly timestamp: 1770000000013;
        readonly payload: {
            readonly backend: "neko";
            readonly proxy: "same-origin";
            readonly cdpEndpoint: "redacted";
        };
    }];
};
export declare const REFERENCE_WIRE_ALL_FIXTURES: {
    readonly mintResponse: {
        readonly object: "run_interaction_stream_session";
        readonly run_id: "run_fixture";
        readonly interaction_id: "int_fixture";
        readonly browser_session_id: "browser_session_fixture";
        readonly token: "stream_token_fixture";
        readonly expires_at_ms: 1770000000000;
        readonly idempotency_replayed: false;
        readonly viewer_path: "/_ref/run-interaction-streams/stream_token_fixture/events";
        readonly input_path: "/_ref/run-interaction-streams/stream_token_fixture/input";
        readonly viewport_path: "/_ref/run-interaction-streams/stream_token_fixture/viewport";
    };
    readonly sseEvents: readonly [{
        readonly event: "attached";
        readonly data: {
            readonly run_id: "run_fixture";
            readonly interaction_id: "int_fixture";
            readonly browser_session_id: "browser_session_fixture";
            readonly viewport: {
                readonly width: 390;
                readonly height: 844;
                readonly screenWidth: 1170;
                readonly screenHeight: 2532;
                readonly deviceScaleFactor: 3;
                readonly hasTouch: true;
                readonly mobile: true;
            };
        };
    }, {
        readonly event: "frame";
        readonly data: {
            readonly session_id: 7;
            readonly data_base64: "/9j/4AAQSkZJRgABAQfixture";
            readonly metadata: {
                readonly device_width: 390;
                readonly device_height: 844;
                readonly offset_top: 0;
                readonly page_scale_factor: 1;
                readonly timestamp: 1770000000;
                readonly scroll_offset_x: 0;
                readonly scroll_offset_y: 0;
            };
        };
    }, {
        readonly event: "backend_ready";
        readonly data: {
            readonly backend: "neko";
            readonly browser_owner_mode: "interactive";
            readonly client_config_path: "/_ref/run-interaction-streams/stream_token_fixture/neko/session";
            readonly iframe_path: "/_ref/run-interaction-streams/stream_token_fixture/neko";
            readonly stealth_mode: "strict";
        };
    }, {
        readonly event: "url_changed";
        readonly data: {
            readonly url: "https://example.invalid/account";
            readonly title: "Fixture Account";
        };
    }, {
        readonly event: "popup_opened";
        readonly data: {
            readonly targetId: "target_popup_fixture";
            readonly url: "https://example.invalid/popup";
        };
    }, {
        readonly event: "popup_closed";
        readonly data: {
            readonly targetId: "target_popup_fixture";
        };
    }, {
        readonly event: "clipboard";
        readonly data: {
            readonly kind: "clipboard";
            readonly text: "clipboard fixture text";
        };
    }, {
        readonly event: "keyboard_focus";
        readonly data: {
            readonly kind: "keyboard_focus";
            readonly focused: true;
            readonly element: {
                readonly type: "focus";
                readonly tagName: "INPUT";
                readonly inputType: "password";
                readonly id: "";
                readonly name: "";
                readonly x: 10;
                readonly y: 20;
                readonly width: 200;
                readonly height: 32;
            };
        };
    }, {
        readonly event: "error";
        readonly data: {
            readonly code: "streaming_target_unregistered";
            readonly message: "No streaming target registered for this run";
        };
    }];
    readonly inputAck: {
        readonly object: "run_interaction_stream_input_ack";
    };
    readonly viewportAck: {
        readonly object: "run_interaction_stream_viewport_ack";
        readonly viewport: {
            readonly width: 1280;
            readonly height: 720;
            readonly screenWidth: 1280;
            readonly screenHeight: 720;
            readonly deviceScaleFactor: 1;
        };
    };
    readonly nekoClientConfig: {
        readonly object: "run_interaction_neko_client";
        readonly server_path: "/neko";
        readonly status_path: "/neko/__pdpp/status";
        readonly login: {
            readonly username: "user";
            readonly password: "neko";
        };
    };
    readonly nekoStatus: readonly [{
        readonly object: "run_interaction_neko_status";
        readonly control_available: false;
    }, {
        readonly object: "run_interaction_neko_status";
        readonly control_available: true;
        readonly status: {
            readonly page_cdp_available: true;
            readonly redacted: true;
        };
    }];
    readonly targetRegistrationResponse: {
        readonly object: "run_streaming_target";
        readonly run_id: "run_fixture";
        readonly interaction_id: "int_fixture";
        readonly expiry: 1770000300000;
        readonly action: "registered";
    };
    readonly targetDeleteResponse: {
        readonly object: "run_streaming_target_deleted";
        readonly run_id: "run_fixture";
        readonly interaction_id: "int_fixture";
    };
    readonly targetDescriptors: readonly [{
        readonly backend: "neko";
        readonly iframe_path: "/_ref/run-interaction-streams/stream_token_fixture/neko";
        readonly client_config_path: "/_ref/run-interaction-streams/stream_token_fixture/neko/session";
        readonly browser_owner_mode: "interactive";
        readonly stealth_mode: "strict";
    }, {
        readonly backend: "cdp";
        readonly iframe_path: null;
        readonly client_config_path: null;
        readonly browser_owner_mode: null;
        readonly stealth_mode: null;
    }];
    readonly inputTelemetry: {
        readonly object: "run_interaction_stream_input_telemetry";
        readonly seq: 3;
        readonly records: [{
            readonly seq: 1;
            readonly serverAtMs: 1770000000001;
            readonly source: "server";
            readonly kind: "wire.input.received";
            readonly correlationId: "corr_fixture";
            readonly wireSeq: 1;
            readonly action: "click";
            readonly eventType: "mouse";
            readonly x: 120;
            readonly y: 240;
        }, {
            readonly seq: 2;
            readonly serverAtMs: 1770000000002;
            readonly source: "server";
            readonly kind: "wire.input.dispatched";
            readonly correlationId: "corr_fixture";
            readonly wireSeq: 1;
            readonly action: "click";
            readonly eventType: "mouse";
        }, {
            readonly seq: 3;
            readonly serverAtMs: 1770000000003;
            readonly source: "remote";
            readonly kind: "remote.pointer.mapped";
            readonly correlationId: "corr_fixture";
            readonly wireSeq: 1;
            readonly x: 120;
            readonly y: 240;
        }];
    };
    readonly diagnosticsRecords: readonly [{
        readonly type: "input";
        readonly timestamp: 1770000000010;
        readonly payload: {
            readonly kind: "wire.input.received";
            readonly eventType: "paste";
            readonly textLength: 18;
            readonly redacted: true;
        };
    }, {
        readonly type: "clipboard";
        readonly timestamp: 1770000000011;
        readonly payload: {
            readonly action: "remote_to_local";
            readonly textLength: 22;
            readonly redacted: true;
        };
    }, {
        readonly type: "viewport";
        readonly timestamp: 1770000000012;
        readonly payload: {
            readonly width: 390;
            readonly height: 844;
            readonly classification: "keyboard-occlusion";
            readonly remoteResize: "hold";
        };
    }, {
        readonly type: "backend_ready";
        readonly timestamp: 1770000000013;
        readonly payload: {
            readonly backend: "neko";
            readonly proxy: "same-origin";
            readonly cdpEndpoint: "redacted";
        };
    }];
    readonly mintRequest: {
        readonly interaction_id: "int_fixture";
        readonly idempotency_key: "mint_key_fixture";
        readonly viewport: {
            readonly width: 390;
            readonly height: 844;
            readonly screenWidth: 1170;
            readonly screenHeight: 2532;
            readonly deviceScaleFactor: 3;
            readonly hasTouch: true;
            readonly mobile: true;
            readonly userAgent: "Mozilla/5.0 fixture";
        };
    };
    readonly viewportPayload: {
        readonly width: 1280;
        readonly height: 720;
        readonly screenWidth: 1280;
        readonly screenHeight: 720;
        readonly deviceScaleFactor: 1;
        readonly hasTouch: false;
        readonly mobile: false;
        readonly userAgent: "Mozilla/5.0 fixture";
    };
    readonly inputPayloads: readonly [{
        readonly type: "mouse";
        readonly action: "mousemove";
        readonly x: 120;
        readonly y: 240;
        readonly correlationId: "corr_fixture";
        readonly wireSeq: 1;
    }, {
        readonly type: "mouse";
        readonly action: "mousedown";
        readonly x: 120;
        readonly y: 240;
        readonly button: 0;
        readonly correlationId: "corr_fixture";
        readonly wireSeq: 2;
    }, {
        readonly type: "mouse";
        readonly action: "mouseup";
        readonly x: 120;
        readonly y: 240;
        readonly button: 0;
        readonly correlationId: "corr_fixture";
        readonly wireSeq: 3;
    }, {
        readonly type: "keyboard";
        readonly action: "keydown";
        readonly key: "Enter";
        readonly code: "Enter";
        readonly modifiers: 0;
    }, {
        readonly type: "keyboard";
        readonly action: "keyup";
        readonly key: "A";
        readonly code: "KeyA";
        readonly modifiers: 8;
    }, {
        readonly type: "touch";
        readonly action: "touchstart";
        readonly x: 100;
        readonly y: 200;
        readonly id: 12;
    }, {
        readonly type: "touch";
        readonly action: "touchend";
        readonly x: 0;
        readonly y: 0;
    }, {
        readonly type: "scroll";
        readonly x: 120;
        readonly y: 240;
        readonly deltaX: 0;
        readonly deltaY: 100;
    }, {
        readonly type: "paste";
        readonly text: "paste fixture text";
    }];
};
//# sourceMappingURL=reference-wire-fixtures.d.ts.map