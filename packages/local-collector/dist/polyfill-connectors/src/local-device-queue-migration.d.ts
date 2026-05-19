import { type LocalDeviceOutbox, type LocalDeviceOutboxItem } from "./local-device-outbox.js";
export interface LegacyLocalDeviceQueueInspection {
    exists: boolean;
    importable: number;
    invalid: number;
    path: string;
    permanentFailure: number;
    sent: number;
    total: number;
}
export interface LegacyLocalDeviceQueueImportResult extends LegacyLocalDeviceQueueInspection {
    imported: number;
    importedItems: LocalDeviceOutboxItem[];
    quarantinePath: string | null;
}
export interface ImportLegacyLocalDeviceQueueOptions {
    outbox: LocalDeviceOutbox;
    quarantinePath?: string;
    queuePath: string;
}
export declare function inspectLegacyLocalDeviceQueue(path: string): Promise<LegacyLocalDeviceQueueInspection>;
export declare function importLegacyLocalDeviceQueue(options: ImportLegacyLocalDeviceQueueOptions): Promise<LegacyLocalDeviceQueueImportResult>;
