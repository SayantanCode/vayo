// @vayo/ui — team roster + invites. Viewable by everyone (viewer+); only an
// owner can invite, change another member's role, remove a member, or
// revoke a pending invite (docs/05-security.md §4, enforced server-side
// regardless of what this UI shows or hides). Any member can rename
// themselves — the invitee is the one who picks their own name at
// accept-invite time in the first place, so there's no "owner edits
// someone else's name" path, only self-service.
//
// Clicking a name is the one direct-edit entry point for both of the
// following, chosen deliberately so it reads the same gesture either way:
//  - Your OWN name -> edits your real, global display name (unchanged
//    self-service rename, just triggered by clicking the name itself now
//    instead of hunting for a separate field below).
//  - Anyone else's name -> sets YOUR OWN private nickname for them — the
//    same idea as a chat app's per-contact nickname (you might know a
//    colleague as "Team Lead" while someone else still sees their real
//    name). Stored on the caller's own doc, visible only to the caller;
//    the other member's actual account name never changes.

import { useRef, useState } from "react";
import { Pencil } from "lucide-react";
import type { TeamRole } from "@vayo/types";
import { Modal } from "./Modal.js";
import { Avatar } from "./Avatar.js";
import { api, ApiError } from "../api.js";
import { ROLE_DESCRIPTIONS } from "../role-descriptions.js";
import { timeAgo } from "../time-format.js";
import { useConfig } from "../contexts/ConfigContext.js";
import { usePresence } from "../hooks/usePresence.js";
import type { InviteResult, PendingInvite, TeamMember } from "../types.js";

function parseInviteEmails(raw: string): string[] {
  return [...new Set(raw.split(/[\n,]+/).map((s) => s.trim()).filter(Boolean))];
}

function inviteShareText(role: TeamRole, link: string): string {
  return `You're invited to our API docs (${role} access): ${link}`;
}

interface TeamModalProps {
  members: TeamMember[];
  currentMemberId: string;
  isOwner: boolean;
  /** The current member's own private nickname book (targetMemberId ->
   * nickname) — never anyone else's; see this file's own top comment. */
  myNicknames: Record<string, string>;
  /** Which roster row to land on when the modal opens — e.g. the caller's
   * own id, when this was opened by clicking their name/avatar in the
   * header rather than the "Team" button. `null` keeps today's default
   * (the invite panel). */
  initialMemberId: string | null;
  onMembersChanged: () => void;
  /** Fired after a successful self-rename so the header's own display of
   * "you" updates immediately, not just the roster list. */
  onMyNameChanged: (name: string) => void;
  /** Same idea as `onMyNameChanged`, for the header's own avatar. */
  onMyAvatarChanged: (avatarUrl: string | null) => void;
  /** Fired after setting/clearing a nickname for someone else, with the
   * caller's WHOLE updated nickname book (not just the one changed entry)
   * so DocsApp can replace its local copy in one step. */
  onNicknamesChanged: (nicknames: Record<string, string>) => void;
  onClose: () => void;
}

type Panel = { type: "member"; memberId: string } | { type: "invite" } | { type: "pending" } | { type: "audit-export" };

export function TeamModal({
  members,
  currentMemberId,
  isOwner,
  myNicknames,
  initialMemberId,
  onMembersChanged,
  onMyNameChanged,
  onMyAvatarChanged,
  onNicknamesChanged,
  onClose,
}: TeamModalProps): JSX.Element {
  const config = useConfig();
  const presence = usePresence();
  const [panel, setPanel] = useState<Panel>(
    initialMemberId ? { type: "member", memberId: initialMemberId } : { type: "invite" },
  );
  const [inviteEmails, setInviteEmails] = useState("");
  const [inviteRole, setInviteRole] = useState<Exclude<TeamRole, "owner">>("viewer");
  const [inviteResults, setInviteResults] = useState<InviteResult[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Non-null while the current member is actively editing their own name —
  // null the rest of the time, including right after a successful save.
  const [nameDraft, setNameDraft] = useState<string | null>(null);
  // Same idea as nameDraft, for editing a NICKNAME for someone else instead.
  const [nicknameDraft, setNicknameDraft] = useState<string | null>(null);
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const [pendingInvites, setPendingInvites] = useState<PendingInvite[] | null>(null);
  const avatarFileInputRef = useRef<HTMLInputElement>(null);

  const selectedMember = panel.type === "member" ? (members.find((m) => m._id === panel.memberId) ?? null) : null;
  const isSelf = selectedMember?._id === currentMemberId;

  function selectMember(memberId: string) {
    setPanel({ type: "member", memberId });
    setNameDraft(null);
    setNicknameDraft(null);
    setConfirmingRemove(false);
    setError(null);
  }

  async function handleInvite() {
    const emails = parseInviteEmails(inviteEmails);
    if (emails.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const results = await api.createInvitesBulk(config, emails, inviteRole);
      setInviteResults(
        results.map((r) => ({
          email: r.email,
          role: r.role,
          expiresAt: r.expiresAt,
          link: `${window.location.origin}${window.location.pathname}?invite=${r.token}`,
        })),
      );
      setInviteEmails("");
      onMembersChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not send the invites.");
    } finally {
      setBusy(false);
    }
  }

  function handleCopyAll() {
    if (!inviteResults || inviteResults.length === 0) return;
    const text = inviteResults.map((r) => `${r.email} (${r.role}): ${r.link}`).join("\n");
    navigator.clipboard.writeText(text);
  }

  function handleShareInvite(result: InviteResult) {
    const text = inviteShareText(result.role, result.link);
    if (typeof navigator.share === "function") {
      navigator.share({ title: "Vayo API docs invite", text, url: result.link }).catch(() => {
        // User dismissed the native share sheet, or it failed silently —
        // the link is still on-screen with its own Copy button as a fallback.
      });
    }
  }

  async function handleRoleChange(memberId: string, role: TeamRole) {
    setBusy(true);
    setError(null);
    try {
      await api.updateTeamMemberRole(config, memberId, role);
      onMembersChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not update the role.");
    } finally {
      setBusy(false);
    }
  }

  async function handleNameSave() {
    if (nameDraft === null || !nameDraft.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const updated = await api.updateMyName(config, nameDraft.trim());
      onMyNameChanged(updated.name);
      onMembersChanged();
      setNameDraft(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not update your name.");
    } finally {
      setBusy(false);
    }
  }

  async function handleNicknameSave() {
    if (nicknameDraft === null || !selectedMember) return;
    // Unlike a name, an empty nickname is a valid save — it's how clearing
    // one back to "show their real name" is expressed.
    const trimmed = nicknameDraft.trim();
    setBusy(true);
    setError(null);
    try {
      const result = await api.setNicknameFor(config, selectedMember._id, trimmed || null);
      onNicknamesChanged(result.nicknames);
      setNicknameDraft(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not update the nickname.");
    } finally {
      setBusy(false);
    }
  }

  async function handleAvatarFileChosen(file: File | undefined) {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const updated = await api.uploadMyAvatar(config, file);
      onMyAvatarChanged(updated.avatarUrl);
      onMembersChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not upload that image.");
    } finally {
      setBusy(false);
      if (avatarFileInputRef.current) avatarFileInputRef.current.value = "";
    }
  }

  async function handleAvatarRemove() {
    setBusy(true);
    setError(null);
    try {
      const updated = await api.removeMyAvatar(config);
      onMyAvatarChanged(updated.avatarUrl);
      onMembersChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not remove your avatar.");
    } finally {
      setBusy(false);
    }
  }

  async function handleRemove(memberId: string) {
    setBusy(true);
    setError(null);
    try {
      await api.removeTeamMember(config, memberId);
      setConfirmingRemove(false);
      setPanel({ type: "invite" });
      onMembersChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not remove this member.");
      setConfirmingRemove(false);
    } finally {
      setBusy(false);
    }
  }

  async function openPendingInvites() {
    setPanel({ type: "pending" });
    setError(null);
    if (pendingInvites !== null) return;
    try {
      setPendingInvites(await api.listPendingInvites(config));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load pending invites.");
      setPendingInvites([]);
    }
  }

  async function handleRevokeInvite(inviteId: string) {
    setBusy(true);
    setError(null);
    try {
      await api.revokeInvite(config, inviteId);
      setPendingInvites((prev) => prev?.filter((i) => i._id !== inviteId) ?? null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not revoke this invite.");
    } finally {
      setBusy(false);
    }
  }

  async function handleExportAuditLog(format: "json" | "csv") {
    setBusy(true);
    setError(null);
    try {
      const blob = await api.exportAuditLog(config, format);
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `vayo-audit-log.${format}`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not export the audit log.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal onClose={onClose} className="env-modal">
      <h3>Team</h3>
        <div className="env-modal__body">
          <div className="env-modal__list modal__list">
            {members.map((member) => {
              const nickname = member._id !== currentMemberId ? myNicknames[member._id] : undefined;
              return (
                <button
                  key={member._id}
                  type="button"
                  className={`modal__option team-modal__roster-row ${
                    panel.type === "member" && panel.memberId === member._id ? "modal__option--current" : ""
                  }`}
                  title={nickname ? `Real name: ${member.name}` : undefined}
                  onClick={() => selectMember(member._id)}
                >
                  <Avatar name={member.name} avatarUrl={member.avatarUrl} size={22} online={presence.isOnline(member._id)} />
                  {nickname ?? member.name} <span className="muted">({member.role})</span>
                  {member._id === currentMemberId && <span className="badge">you</span>}
                  {member.status === "invited" && <span className="badge">invited</span>}
                </button>
              );
            })}
            {isOwner && (
              <button
                type="button"
                className={`modal__option ${panel.type === "invite" ? "modal__option--current" : ""}`}
                onClick={() => {
                  setPanel({ type: "invite" });
                  setError(null);
                }}
              >
                + Invite someone
              </button>
            )}
            {isOwner && (
              <button
                type="button"
                className={`modal__option ${panel.type === "pending" ? "modal__option--current" : ""}`}
                onClick={openPendingInvites}
              >
                Pending invites
              </button>
            )}
            {isOwner && (
              <button
                type="button"
                className={`modal__option ${panel.type === "audit-export" ? "modal__option--current" : ""}`}
                onClick={() => {
                  setPanel({ type: "audit-export" });
                  setError(null);
                }}
              >
                Export audit log
              </button>
            )}
          </div>

          <div className="env-modal__editor">
            {error && <div className="banner banner--error">{error}</div>}

            {selectedMember && (
              <>
                <div className="team-modal__profile-header">
                  <Avatar
                    name={selectedMember.name}
                    avatarUrl={selectedMember.avatarUrl}
                    size={56}
                    online={presence.isOnline(selectedMember._id)}
                  />
                  <div>
                    <p className="team-modal__name-row">
                      {isSelf ? (
                        nameDraft !== null ? (
                          <input
                            autoFocus
                            className="team-modal__inline-name-input"
                            value={nameDraft}
                            disabled={busy}
                            onChange={(e) => setNameDraft(e.target.value)}
                            onBlur={handleNameSave}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                              if (e.key === "Escape") setNameDraft(null);
                            }}
                          />
                        ) : (
                          <button
                            type="button"
                            className="team-modal__inline-name-trigger"
                            disabled={busy}
                            onClick={() => setNameDraft(selectedMember.name)}
                            title="Click to edit your display name"
                          >
                            <strong>{selectedMember.name}</strong>
                            <Pencil size={12} />
                          </button>
                        )
                      ) : nicknameDraft !== null ? (
                        <input
                          autoFocus
                          className="team-modal__inline-name-input"
                          value={nicknameDraft}
                          disabled={busy}
                          placeholder={selectedMember.name}
                          onChange={(e) => setNicknameDraft(e.target.value)}
                          onBlur={handleNicknameSave}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                            if (e.key === "Escape") setNicknameDraft(null);
                          }}
                        />
                      ) : (
                        <button
                          type="button"
                          className="team-modal__inline-name-trigger"
                          disabled={busy}
                          onClick={() => setNicknameDraft(myNicknames[selectedMember._id] ?? "")}
                          title="Click to set your own private nickname for them — visible only to you"
                        >
                          <strong>{myNicknames[selectedMember._id] ?? selectedMember.name}</strong>
                          <Pencil size={12} />
                        </button>
                      )}{" "}
                      <span className="muted">{selectedMember.email}</span>
                    </p>
                    {!isSelf && myNicknames[selectedMember._id] && (
                      <p className="muted team-modal__real-name-hint">Real name: {selectedMember.name}</p>
                    )}
                    <p className="muted">
                      {presence.isOnline(selectedMember._id)
                        ? "Online now"
                        : (presence.lastSeenOverride(selectedMember._id) ?? selectedMember.lastSeenAt)
                          ? `Last seen ${timeAgo(presence.lastSeenOverride(selectedMember._id) ?? selectedMember.lastSeenAt!)}`
                          : "Never connected yet"}
                    </p>
                  </div>
                </div>
                <p className="muted">Status: {selectedMember.status}</p>
                {!isSelf && (
                  <p className="muted team-modal__nickname-hint">
                    A nickname you set is private — {selectedMember.name} and everyone else still sees their own name.
                  </p>
                )}

                {isSelf && (
                  <div className="team-modal__avatar-controls">
                    <input
                      ref={avatarFileInputRef}
                      type="file"
                      accept="image/png,image/jpeg,image/webp,image/gif"
                      className="visually-hidden"
                      onChange={(e) => handleAvatarFileChosen(e.target.files?.[0])}
                    />
                    <button type="button" className="button" disabled={busy} onClick={() => avatarFileInputRef.current?.click()}>
                      Change avatar
                    </button>
                    {selectedMember.avatarUrl && (
                      <button type="button" className="button" disabled={busy} onClick={handleAvatarRemove}>
                        Remove avatar
                      </button>
                    )}
                  </div>
                )}

                {isOwner && !isSelf ? (
                  <label className="field">
                    <span>Role</span>
                    <select
                      value={selectedMember.role}
                      disabled={busy}
                      onChange={(e) => handleRoleChange(selectedMember._id, e.target.value as TeamRole)}
                    >
                      <option value="viewer">viewer</option>
                      <option value="editor">editor</option>
                      <option value="owner">owner</option>
                    </select>
                    <span className="field__hint">{ROLE_DESCRIPTIONS[selectedMember.role]}</span>
                  </label>
                ) : (
                  !isSelf && <p className="muted">Role: {selectedMember.role}</p>
                )}
                {isSelf && <p className="muted">You can't change your own role here.</p>}

                {isOwner && !isSelf && (
                  <div className="team-modal__danger-zone">
                    {confirmingRemove ? (
                      <>
                        <p className="muted">Remove {selectedMember.name} from the team? They lose access immediately.</p>
                        <div className="team-modal__confirm-row">
                          <button type="button" className="button" disabled={busy} onClick={() => setConfirmingRemove(false)}>
                            Cancel
                          </button>
                          <button
                            type="button"
                            className="button button--danger"
                            disabled={busy}
                            onClick={() => handleRemove(selectedMember._id)}
                          >
                            Remove from team
                          </button>
                        </div>
                      </>
                    ) : (
                      <button type="button" className="button button--danger" disabled={busy} onClick={() => setConfirmingRemove(true)}>
                        Remove from team
                      </button>
                    )}
                  </div>
                )}
              </>
            )}

            {panel.type === "invite" && isOwner && (
              <>
                <label className="field">
                  <span>Emails</span>
                  <textarea
                    className="team-modal__invite-emails"
                    rows={3}
                    value={inviteEmails}
                    onChange={(e) => setInviteEmails(e.target.value)}
                    placeholder={"one per line, or comma-separated\nalex@company.com\njamie@company.com"}
                  />
                  <span className="field__hint">Everyone here gets the same role — invite as many people as you like in one go.</span>
                </label>
                <label className="field">
                  <span>Role</span>
                  <select value={inviteRole} onChange={(e) => setInviteRole(e.target.value as Exclude<TeamRole, "owner">)}>
                    <option value="viewer">viewer</option>
                    <option value="editor">editor</option>
                  </select>
                  <span className="field__hint">{ROLE_DESCRIPTIONS[inviteRole]}</span>
                </label>
                <button
                  type="button"
                  className="button button--primary"
                  disabled={busy || parseInviteEmails(inviteEmails).length === 0}
                  onClick={handleInvite}
                >
                  {parseInviteEmails(inviteEmails).length > 1
                    ? `Send ${parseInviteEmails(inviteEmails).length} invites`
                    : "Send invite"}
                </button>

                {inviteResults && inviteResults.length > 0 && (
                  <div className="banner">
                    <p>
                      {inviteResults.length === 1 ? "Invite" : `${inviteResults.length} invites`} created — share each link
                      yourself (email, Slack, WhatsApp, whatever you already use). Shown <strong>once</strong>; Vayo can't
                      regenerate a lost link, only send a new invite.
                    </p>
                    {inviteResults.length > 1 && (
                      <button type="button" className="button" onClick={handleCopyAll}>
                        Copy all as one message
                      </button>
                    )}
                    <div className="team-modal__invite-results">
                      {inviteResults.map((result) => (
                        <div key={result.link} className="team-modal__invite-result">
                          <div className="team-modal__invite-result-info">
                            <strong>{result.email}</strong> <span className="muted">({result.role})</span>
                            <code className="invite-link">{result.link}</code>
                          </div>
                          <div className="team-modal__invite-result-actions">
                            <button type="button" className="button" onClick={() => navigator.clipboard.writeText(result.link)}>
                              Copy link
                            </button>
                            {typeof navigator.share === "function" && (
                              <button type="button" className="button" onClick={() => handleShareInvite(result)}>
                                Share…
                              </button>
                            )}
                            <a
                              className="button"
                              target="_blank"
                              rel="noopener noreferrer"
                              href={`https://wa.me/?text=${encodeURIComponent(inviteShareText(result.role, result.link))}`}
                            >
                              WhatsApp
                            </a>
                            <a
                              className="button"
                              href={`mailto:${encodeURIComponent(result.email)}?subject=${encodeURIComponent(
                                "You're invited to our API docs",
                              )}&body=${encodeURIComponent(inviteShareText(result.role, result.link))}`}
                            >
                              Email
                            </a>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </>
            )}

            {panel.type === "pending" && isOwner && (
              <>
                <p className="muted">Invited but not yet accepted. Revoke one if it went to the wrong address.</p>
                {pendingInvites === null ? (
                  <p className="muted">Loading…</p>
                ) : pendingInvites.length === 0 ? (
                  <p className="muted">No outstanding invites.</p>
                ) : (
                  <div className="team-modal__pending-list">
                    {pendingInvites.map((invite) => (
                      <div key={invite._id} className="team-modal__pending-row">
                        <div>
                          <strong>{invite.email}</strong> <span className="muted">({invite.role})</span>
                          <div className="muted team-modal__pending-expiry">Expires {new Date(invite.expiresAt).toLocaleDateString()}</div>
                        </div>
                        <button type="button" className="button button--danger" disabled={busy} onClick={() => handleRevokeInvite(invite._id)}>
                          Revoke
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}

            {panel.type === "audit-export" && isOwner && (
              <>
                <p className="muted">
                  Every override, comment, invite, role change, and member removal across the whole project — not just
                  one endpoint's own History tab — as a downloadable file for a compliance or security review.
                </p>
                <div className="team-modal__confirm-row">
                  <button type="button" className="button button--primary" disabled={busy} onClick={() => handleExportAuditLog("json")}>
                    Download JSON
                  </button>
                  <button type="button" className="button" disabled={busy} onClick={() => handleExportAuditLog("csv")}>
                    Download CSV
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
        <div className="modal__actions">
          <button type="button" className="button" onClick={onClose}>
            Close
          </button>
        </div>
    </Modal>
  );
}
