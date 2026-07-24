// @vayo/ui — the whole active API version as one continuously scrollable
// page (docs/08-packages-and-repo-structure.md), the same "read the whole
// reference top to bottom" pattern Postman's own collection documentation
// view, Redoc, and Swagger UI all converge on. An alternative to — not a
// replacement for — the normal one-endpoint-at-a-time workspace: Flowmap,
// History, Team Chat, and Try It Now are all inherently interactive and
// don't make sense stacked in a continuous scroll, so this only ever
// renders each endpoint's Details tab content, reused as-is rather than
// duplicated, with the sidebar acting as this view's own "jump to" nav
// (DocsApp.tsx makes clicking an endpoint here scroll to it instead of
// switching the selected endpoint, while this mode is active).
import { useEffect, useMemo, useRef } from "react";
import type { EnvironmentDoc, FolderDoc, SettingsDoc } from "@vayo/types";
import { flattenTree, type TreeNode } from "../types.js";
import { EndpointHeader } from "./EndpointHeader.js";
import { DetailsTab } from "./tabs/DetailsTab.js";

interface FullDocViewProps {
  tree: TreeNode[];
  allFolders: FolderDoc[];
  apiOrigin: string;
  environment: EnvironmentDoc | null;
  environments: EnvironmentDoc[];
  activeEnvironmentId: string | null;
  onSelectEnvironment: (id: string | null) => void;
  onManageEnvironments: () => void;
  canEdit: boolean;
  /** Project Settings' title/description — shown once at the top of this
   * page, the same "info block above the operation list" every third-party
   * OpenAPI renderer (Redoc, Swagger UI) already does with the identical
   * `info.title`/`info.description` fields. This is the only place in the
   * docs UI a saved description is ever actually rendered — until now it
   * only ever reached the exported spec's JSON, with no visible surface at
   * all in the app itself. */
  settings: SettingsDoc | null;
  /** Jumps to that endpoint in the normal (interactive) workspace, on its
   * Try It Now tab — leaving this read-only view, since sending a real
   * request isn't something a static reference page can do in place. */
  onTryIt: (vayoId: string) => void;
  /** Scroll-spy: fired with whichever endpoint section is currently
   * topmost in the scrolled viewport, so the sidebar's own highlight
   * (driven by `selectedVayoId` in DocsApp.tsx) tracks free scrolling —
   * not just the clicks that jump here in the first place. */
  onSectionInView: (vayoId: string) => void;
}

export function FullDocView({
  tree,
  allFolders,
  apiOrigin,
  environment,
  environments,
  activeEnvironmentId,
  onSelectEnvironment,
  onManageEnvironments,
  canEdit,
  onTryIt,
  onSectionInView,
  settings,
}: FullDocViewProps): JSX.Element {
  // Every folder "expanded" — this view is a linear printout of the whole
  // tree, not a collapsible one; collapsing belongs to the sidebar's own
  // browsing mode, not to reading the reference start to finish.
  const allFolderIds = useMemo(() => new Set(allFolders.map((f) => f._id)), [allFolders]);
  const rows = useMemo(() => flattenTree(tree, allFolderIds), [tree, allFolderIds]);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const root = containerRef.current?.closest(".docs-app__main");
    const sections = containerRef.current?.querySelectorAll<HTMLElement>(".full-doc__endpoint[id]");
    if (!root || !sections || sections.length === 0) return;

    const lastSectionId = sections[sections.length - 1]!.id;
    // True once scrolled to (or within a couple px of) the true bottom —
    // checked fresh every time, from both places below, rather than a
    // one-shot flag: the trigger line and the "at bottom" scroll listener
    // both react to the same scroll action with no guaranteed firing
    // order, so whichever runs LAST must still re-derive the same answer,
    // or it silently overwrites the other with a stale one.
    function isAtBottom(): boolean {
      return root!.scrollTop + root!.clientHeight >= root!.scrollHeight - 2;
    }

    // A thin trigger LINE ~15% down the scroll container, not a thick band
    // — a large top+bottom rootMargin pinches the observed region down to
    // a sliver. A thick band (e.g. just a big negative bottom margin) lets
    // the section scrolling OUT (its top already far above the viewport,
    // a large negative number) and the one scrolling IN (top near 0) both
    // intersect at once, and "whichever has the smaller top" picks the
    // wrong one — it favors the section that's MORE scrolled-past, not the
    // one actually at the reading line. A near-zero-height band sidesteps
    // that ambiguity: only one section spans a sliver at a time, barring
    // the single instant a boundary crosses it exactly. The one case it
    // still can't handle: a last section short enough to never reach the
    // line at all, since there's no more room to scroll it up that far —
    // isAtBottom() catches that case first, ahead of the line-based result.
    const observer = new IntersectionObserver(
      (entries) => {
        if (isAtBottom()) {
          onSectionInView(lastSectionId);
          return;
        }
        const entry = entries.find((e) => e.isIntersecting);
        if (entry) onSectionInView(entry.target.id);
      },
      { root, rootMargin: "-15% 0px -84% 0px", threshold: 0 },
    );
    sections.forEach((section) => observer.observe(section));

    function handleScroll() {
      if (isAtBottom()) onSectionInView(lastSectionId);
    }
    root.addEventListener("scroll", handleScroll, { passive: true });

    return () => {
      observer.disconnect();
      root.removeEventListener("scroll", handleScroll);
    };
  }, [rows, onSectionInView]);

  if (rows.length === 0) {
    return (
      <div className="empty-state">
        No endpoints captured yet — hit some routes on your API, or create one manually, and they&apos;ll show up here.
      </div>
    );
  }

  return (
    <div className="full-doc" ref={containerRef}>
      {settings?.description && (
        <div className="full-doc__intro">
          <h1>{settings.title}</h1>
          <p>{settings.description}</p>
          {(settings.termsOfService || settings.contactName || settings.contactEmail || settings.licenseName) && (
            <p className="full-doc__intro-meta muted">
              {settings.licenseName &&
                (settings.licenseUrl ? (
                  <a href={settings.licenseUrl} target="_blank" rel="noreferrer">
                    {settings.licenseName}
                  </a>
                ) : (
                  settings.licenseName
                ))}
              {settings.licenseName && (settings.contactName || settings.contactEmail || settings.termsOfService) && " · "}
              {(settings.contactName || settings.contactEmail) && (
                <>
                  Contact:{" "}
                  {settings.contactEmail ? (
                    <a href={`mailto:${settings.contactEmail}`}>{settings.contactName || settings.contactEmail}</a>
                  ) : (
                    settings.contactName
                  )}
                </>
              )}
              {(settings.contactName || settings.contactEmail) && settings.termsOfService && " · "}
              {settings.termsOfService && (
                <a href={settings.termsOfService} target="_blank" rel="noreferrer">
                  Terms of Service
                </a>
              )}
            </p>
          )}
        </div>
      )}
      {rows.map((row) => {
        if (row.node.type === "folder") {
          return (
            <h2
              key={row.id}
              id={`folder:${row.node.folder._id}`}
              className="full-doc__folder-heading"
              style={{ marginLeft: row.depth * 20 }}
            >
              {row.node.folder.name}
            </h2>
          );
        }
        // Narrowed into a plain local, not re-read off `row.node` inside the
        // onTryIt closure below — TS's control-flow narrowing of a union
        // property doesn't persist into a nested function body.
        const endpoint = row.node.endpoint;
        return (
          <section key={row.id} id={endpoint.vayoId} className="full-doc__endpoint" style={{ marginLeft: row.depth * 20 }}>
            <EndpointHeader endpoint={endpoint} />
            <DetailsTab
              endpoint={endpoint}
              apiOrigin={apiOrigin}
              environment={environment}
              environments={environments}
              activeEnvironmentId={activeEnvironmentId}
              onSelectEnvironment={onSelectEnvironment}
              onManageEnvironments={onManageEnvironments}
              onTryIt={() => onTryIt(endpoint.vayoId)}
              canEdit={canEdit}
            />
          </section>
        );
      })}
    </div>
  );
}
