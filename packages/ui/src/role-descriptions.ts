// @vayo/ui — one sentence per role, shown wherever a role is picked or
// displayed (TeamModal's invite/role-change pickers, AcceptInviteScreen's
// confirmation). The 3-role model itself is intentionally not more granular
// than this (docs/05-security.md §4): every server route's role check maps
// cleanly onto "can view + discuss" / "can also maintain the docs" / "can
// also manage the team," with no natural seam to split further. The gap
// this closes is discoverability, not capability — a bare "editor" in a
// dropdown doesn't say what that actually grants.

import type { TeamRole } from "@vayo/types";

export const ROLE_DESCRIPTIONS: Record<TeamRole, string> = {
  viewer: "Can view every endpoint and take part in Team Chat. Can't edit docs or manage the team.",
  editor: "Everything a viewer can do, plus editing schemas, notes, folders, environments, Flows, and API versions.",
  owner: "Everything an editor can do, plus inviting people and changing anyone's role.",
};
