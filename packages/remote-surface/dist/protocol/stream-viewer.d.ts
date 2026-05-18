import type { StreamViewport } from "../client/geometry.ts";
export interface FrameMessage {
    data_base64: string;
    metadata?: {
        device_height?: number | undefined;
        device_width?: number | undefined;
    } | null | undefined;
    session_id?: number | undefined;
}
export interface AttachedMessage {
    browser_session_id: string;
    interaction_id: string;
    run_id: string;
    viewport: (StreamViewport & {
        screenHeight?: number;
        screenWidth?: number;
    }) | null;
}
export interface BackendReadyMessage {
    backend: "cdp" | "neko" | string;
    browser_owner_mode?: string | null | undefined;
    client_config_path?: string | null | undefined;
    iframe_path?: string | null | undefined;
    stealth_mode?: string | null | undefined;
}
export interface UrlChangedMessage {
    title?: string | undefined;
    url: string;
}
export interface PopupOpenedMessage {
    targetId: string;
    url?: string | undefined;
}
export interface PopupClosedMessage {
    targetId: string;
}
export interface ClipboardMessage {
    text?: string;
}
export interface KeyboardFocusMessage {
    element?: {
        inputType?: string | undefined;
        tagName?: string | undefined;
    } | null | undefined;
    focused: boolean;
}
export interface StreamErrorMessage {
    code?: string | undefined;
    message?: string | undefined;
}
export type ProtocolParseResult<T> = {
    ok: true;
    value: T;
} | {
    error: string;
    ok: false;
};
export declare function parseFrameMessage(data: string): ProtocolParseResult<FrameMessage>;
export declare function parseAttachedMessage(data: string): ProtocolParseResult<AttachedMessage>;
export declare function parseBackendReadyMessage(data: string): ProtocolParseResult<BackendReadyMessage>;
export declare function parseUrlChangedMessage(data: string): ProtocolParseResult<UrlChangedMessage>;
export declare function parsePopupOpenedMessage(data: string): ProtocolParseResult<PopupOpenedMessage>;
export declare function parsePopupClosedMessage(data: string): ProtocolParseResult<PopupClosedMessage>;
export declare function parseClipboardMessage(data: string): ProtocolParseResult<ClipboardMessage>;
export declare function parseKeyboardFocusMessage(data: string): ProtocolParseResult<KeyboardFocusMessage>;
export declare function parseStreamErrorMessage(data: string): ProtocolParseResult<StreamErrorMessage>;
//# sourceMappingURL=stream-viewer.d.ts.map