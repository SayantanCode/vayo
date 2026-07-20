// @vayo/ui — breadcrumb trail above the endpoint header, showing the
// folder chain the selected endpoint currently lives in (Postman-parity
// redesign: makes deep nesting scannable without expanding the sidebar).

import type { FolderDoc } from "@vayo/types";

interface FolderBreadcrumbProps {
  folders: FolderDoc[];
  folderId: string | null;
}

export function FolderBreadcrumb({ folders, folderId }: FolderBreadcrumbProps): JSX.Element | null {
  if (!folderId) return null;

  const byId = new Map(folders.map((f) => [f._id, f]));
  const chain: FolderDoc[] = [];
  let current = byId.get(folderId);
  while (current) {
    chain.unshift(current);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  if (chain.length === 0) return null;

  return (
    <div className="folder-breadcrumb">
      {chain.map((folder, i) => (
        <span key={folder._id} style={{ display: "contents" }}>
          {i > 0 && <span className="folder-breadcrumb__sep">/</span>}
          <span className="folder-breadcrumb__crumb">{folder.name}</span>
        </span>
      ))}
    </div>
  );
}
