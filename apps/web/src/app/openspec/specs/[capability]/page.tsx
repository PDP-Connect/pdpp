import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Fragment } from "react";
import {
  buildOpenSpecSidebarSections,
  OpenSpecBreadcrumbs,
  OpenSpecMarkdownPage,
  OpenSpecShell,
  OpenSpecSourceLink,
} from "@/components/openspec/index.ts";
import { getOpenSpecSpec, listOpenSpecSpecs } from "@/lib/openspec/index.ts";
import { PLANNING_LABEL, planningPath } from "@/lib/openspec/public.ts";

type PageProps = { params: Promise<{ capability: string }> };

export async function generateStaticParams() {
  const specs = await listOpenSpecSpecs();
  return specs.map((s) => ({ capability: s.capability }));
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { capability } = await params;
  const spec = await getOpenSpecSpec(capability);
  if (!spec) {
    return { title: `Spec not found — ${PLANNING_LABEL} — PDPP` };
  }
  return {
    title: `${spec.title} — ${PLANNING_LABEL} — PDPP`,
    description: spec.excerpt ?? undefined,
  };
}

export default async function CapabilitySpecPage({ params }: PageProps) {
  const { capability } = await params;
  const spec = await getOpenSpecSpec(capability);
  if (!spec) {
    notFound();
  }

  const sections = buildOpenSpecSidebarSections({ kind: "specs", capability });

  return (
    <OpenSpecShell sections={sections}>
      <article className="flex flex-col gap-6">
        <OpenSpecBreadcrumbs
          crumbs={[
            { label: PLANNING_LABEL, href: planningPath() },
            { label: "Specs", href: planningPath("/specs") },
            { label: spec.capability },
          ]}
        />
        <header className="flex flex-col gap-3">
          <h1 className="font-semibold text-[clamp(1.6rem,2.8vw,2.05rem)] leading-tight tracking-tight">
            {spec.title}
          </h1>
          <OpenSpecSourceLink
            repoRelativePath={spec.repoRelativePath}
            createdAt={spec.createdAt}
            lastModified={spec.lastModified}
          />
          {spec.relatedChanges.length > 0 && (
            <div className="pdpp-caption flex flex-wrap items-center gap-2 text-muted-foreground">
              <span>Related changes:</span>
              {spec.relatedChanges.map((name, index) => (
                <Fragment key={name}>
                  {index > 0 && (
                    <span aria-hidden="true" className="opacity-40">
                      ,
                    </span>
                  )}
                  <Link
                    href={planningPath(`/changes/${name}`)}
                    className="font-mono transition-colors hover:text-foreground"
                  >
                    {name}
                  </Link>
                </Fragment>
              ))}
            </div>
          )}
        </header>
        <OpenSpecMarkdownPage markdown={spec.markdown} />
      </article>
    </OpenSpecShell>
  );
}
