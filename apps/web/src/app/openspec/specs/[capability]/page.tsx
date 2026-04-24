import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Fragment } from "react";
import { PageHeader } from "@/app/dashboard/components/primitives.tsx";
import { DocsLayout } from "@/components/docs/docs-layout.tsx";
import { ProsePage } from "@/components/docs/prose-page.tsx";
import { SourceLink } from "@/components/docs/source-link.tsx";
import { buildPlanningSidebarSections } from "@/components/planning/sidebar-sections.ts";
import { getOpenSpecSpec, listOpenSpecSpecs } from "@/lib/openspec/index.ts";
import { PLANNING_LABEL, planningPath } from "@/lib/openspec/public.ts";

interface PageProps {
  params: Promise<{ capability: string }>;
}

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

  const sections = buildPlanningSidebarSections({ kind: "specs", capability });

  return (
    <DocsLayout sections={sections}>
      <article className="flex flex-col gap-6">
        <PageHeader
          breadcrumbs={[
            { href: planningPath(), label: PLANNING_LABEL },
            { href: planningPath("/specs"), label: "Specs" },
            { label: spec.capability },
          ]}
          meta={
            <>
              <SourceLink
                createdAt={spec.createdAt}
                lastModified={spec.lastModified}
                repoRelativePath={spec.repoRelativePath}
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
                        className="font-mono transition-colors hover:text-foreground"
                        href={planningPath(`/changes/${name}`)}
                      >
                        {name}
                      </Link>
                    </Fragment>
                  ))}
                </div>
              )}
            </>
          }
          title={spec.title}
        />
        <ProsePage markdown={spec.markdown} />
      </article>
    </DocsLayout>
  );
}
