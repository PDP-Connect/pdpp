"use client";

import {
  CopyMono,
  RecordBody,
  Sheet,
  SheetBody,
  SheetFoot,
  SheetHead,
  SheetSerial,
  SheetTitle,
} from "@pdpp/brand-react";
import type {
  ExplorerBlobAffordance,
  ExplorerPeekData,
} from "@pdpp/operator-ui/components/views/records-explorer-view";
import type { ParentBackLink, RelatedLink, ReverseChildListLink } from "../sources/lib/relationships.ts";

const IMAGE_MIME_RE = /^image\//i;

export interface RecordInspectorRelationships {
  parentBackLinks: ParentBackLink[];
  relatedLinks: RelatedLink[];
  reverseChildListLinks: ReverseChildListLink[];
}

export interface RecordInspectorProps {
  record: ExplorerPeekData | null;
  relationships?: RecordInspectorRelationships | null;
  streamRecordsHref?: string | null;
}

function parseRecordBody(record: ExplorerPeekData): Record<string, unknown> {
  if (!record.bodyJson) {
    return {};
  }
  try {
    const parsed = JSON.parse(record.bodyJson) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function blobAffordance(record: ExplorerPeekData): ExplorerBlobAffordance | null {
  for (const field of record.fields) {
    if (field.blobAffordance) {
      return field.blobAffordance;
    }
  }
  return null;
}

function declaredBlobMime(body: Record<string, unknown>, fieldName: string): string | undefined {
  const ref = body[fieldName];
  if (!(ref && typeof ref === "object") || Array.isArray(ref)) {
    return;
  }
  const mime = (ref as { mime_type?: unknown }).mime_type;
  return typeof mime === "string" && mime.length > 0 ? mime : undefined;
}

function BlobAffordanceView({
  affordance,
  mimeType,
}: {
  affordance: ExplorerBlobAffordance;
  mimeType: string | undefined;
}) {
  if (affordance.state === "unavailable") {
    return <span className="rr-x-blob rr-x-blob--off">{affordance.reason ?? "Blob unavailable for this view."}</span>;
  }
  if (!affordance.href) {
    return null;
  }
  const isImage = mimeType ? IMAGE_MIME_RE.test(mimeType) : false;
  return (
    <div className="rr-x-blob">
      {isImage ? (
        // biome-ignore lint/performance/noImgElement: blob fetch_url is a grant-scoped RS URL, not a static asset Next can optimize.
        // biome-ignore lint/correctness/useImageSize: a remote record blob has no known intrinsic dimensions; the CSS box constrains it.
        <img alt={affordance.fieldName} className="rr-x-blob__img" src={affordance.href} />
      ) : null}
      <a className="rr-x-blob__open" href={affordance.href}>
        Open blob →
      </a>
    </div>
  );
}

export function RecordInspector({ record, relationships, streamRecordsHref }: RecordInspectorProps) {
  if (!record) {
    return (
      <Sheet className="rr-inspector rr-inspector--empty">
        <SheetBody className="rr-x-empty">
          <span className="rr-x-empty__eyebrow">The reading room</span>
          <p className="rr-x-empty__line">
            Select any row to inspect the full record, links, files, and sharing facts.
          </p>
          <dl className="rr-x-empty__preview">
            <div className="rr-x-empty__preview-row">
              <dt className="rr-x-empty__preview-k">Fields</dt>
              <dd className="rr-x-empty__preview-v">label + the wire key a client receives</dd>
            </div>
            <div className="rr-x-empty__preview-row">
              <dt className="rr-x-empty__preview-k">The call</dt>
              <dd className="rr-x-empty__preview-v">the exact request that reads this record</dd>
            </div>
            <div className="rr-x-empty__preview-row">
              <dt className="rr-x-empty__preview-k">Withheld</dt>
              <dd className="rr-x-empty__preview-v">what stays with you, never shared</dd>
            </div>
          </dl>
        </SheetBody>
      </Sheet>
    );
  }

  const body = parseRecordBody(record);
  const declaredTypes: Record<string, string> = {};
  for (const field of record.fields) {
    if (field.type) {
      declaredTypes[field.name] = field.type;
    }
  }
  const withheld = record.fields.filter((field) => field.state === "withheld");
  const visibleCount = record.fields.filter((field) => field.state === "visible").length;
  const totalDeclared = record.fields.length;
  const blob = blobAffordance(record);
  const blobMime = blob ? declaredBlobMime(body, blob.fieldName) : undefined;
  const relatedLinks = relationships?.relatedLinks ?? [];
  const parentBackLinks = relationships?.parentBackLinks ?? [];
  const reverseChildListLinks = relationships?.reverseChildListLinks ?? [];
  const hasRelationships = relatedLinks.length > 0 || parentBackLinks.length > 0 || reverseChildListLinks.length > 0;

  return (
    <Sheet className="rr-inspector">
      <SheetHead>
        <SheetTitle>{record.stream}</SheetTitle>
        <SheetSerial>
          <CopyMono text={record.recordId} />
        </SheetSerial>
      </SheetHead>
      <SheetBody>
        <div className="rr-ex-lens">
          <span className="rr-ex-lens__label">read it as</span>
          <span className="rr-x-facets__note">
            You are seeing the full owner view. Apps and clients receive only the fields allowed by their grant;
            withheld fields are listed below when that view is active.
          </span>
        </div>

        {record.error ? (
          <p className="rr-x-warn__msg">{record.error}</p>
        ) : (
          <RecordBody
            blobAffordance={blob ?? undefined}
            data={body}
            declaredTypes={declaredTypes}
            stream={record.stream}
          />
        )}

        {record.bodyJson ? (
          <details className="rr-x-raw">
            <summary>Raw JSON</summary>
            <pre>{record.bodyJson}</pre>
          </details>
        ) : null}

        {blob && <BlobAffordanceView affordance={blob} mimeType={blobMime} />}

        {withheld.length > 0 && (
          <div className="rr-ex-keep">
            <span className="rr-ex-keep__label">Stays with you</span>
            <span className="rr-ex-keep__fields">{withheld.map((field) => field.name).join(" · ")}</span>
            <span className="rr-ex-keep__note">
              {withheld.length} {withheld.length === 1 ? "field" : "fields"} never leave your server under this shared
              view — never sent, not blacked out.
            </span>
          </div>
        )}

        {hasRelationships && (
          <div className="rr-x-rel">
            <span className="rr-ex-keep__label">Connected</span>
            {parentBackLinks.map((link) => (
              <a
                className="rr-x-rel__row rr-x-rel__row--link"
                href={link.href}
                key={`parent:${link.parentStream}:${link.childParentKeyField}`}
              >
                <span className="rr-x-rel__k">{link.parentStream}</span>
                <span className="rr-x-rel__v">{link.childParentKeyField} → parent</span>
              </a>
            ))}
            {relatedLinks.map((link) =>
              link.navigable && link.href ? (
                <a className="rr-x-rel__row rr-x-rel__row--link" href={link.href} key={`rel:${link.relation}`}>
                  <span className="rr-x-rel__k">{link.relation}</span>
                  <span className="rr-x-rel__v">{link.cardinality} →</span>
                </a>
              ) : (
                <div className="rr-x-rel__row rr-x-rel__row--inert" key={`rel:${link.relation}`} title={link.advisory}>
                  <span className="rr-x-rel__k">{link.relation}</span>
                  <span className="rr-x-rel__v">{link.advisory ?? `no related ${link.relation}`}</span>
                </div>
              )
            )}
            {reverseChildListLinks.map((link) => (
              <a
                className="rr-x-rel__row rr-x-rel__row--link"
                href={link.href}
                key={`reverse:${link.childStream}:${link.foreignKey}`}
              >
                <span className="rr-x-rel__k">{link.childStream}</span>
                <span className="rr-x-rel__v">has_many →</span>
              </a>
            ))}
          </div>
        )}
      </SheetBody>
      <SheetFoot>
        {streamRecordsHref ? (
          <a className="rr-x-stream-all" href={streamRecordsHref}>
            Open all records in this stream →
          </a>
        ) : null}
        <div className="rr-x-compiled">
          <span className="rr-x-compiled__label">Record request:</span>
          <CopyMono text={`GET ${record.readUrl}`} />
        </div>
        <span className="rr-x-facets__note">
          {withheld.length > 0
            ? `${visibleCount} of ${totalDeclared} fields included in this shared view · enforced on every read`
            : `${totalDeclared} fields · readable by you`}
        </span>
      </SheetFoot>
    </Sheet>
  );
}
