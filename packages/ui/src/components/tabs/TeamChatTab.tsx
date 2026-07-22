import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import { CalendarClock, CircleStop, CornerUpLeft, File, Flag, MonitorPlay, Paperclip, Search, X } from "lucide-react";
import type { AttachmentDoc, CommentDoc } from "@vayo/types";
import { api, ApiError } from "../../api.js";
import { applyMentionSelection, detectMentionTrigger, type MentionTrigger } from "../../mentions.js";
import { DATE_FILTERS, DATE_FILTER_LABELS, matchesDateFilter, type DateFilter } from "../../chat-filters.js";
import { MessageBody } from "../MessageBody.js";
import type { EndpointSummary } from "../../types.js";
import { useConfig } from "../../contexts/ConfigContext.js";
import { useSocket } from "../../contexts/SocketContext.js";
import { AttachmentPreview, ChatContextMenu, DateJumpPopover, snippet } from "./team-chat-pieces.js";

interface TeamChatTabProps {
  vayoId: string;
  currentMemberId: string;
  canResolve: boolean;
  memberNames: Record<string, string>;
  endpoints: EndpointSummary[];
  /** Jumps to another endpoint entirely — clicking an inline `#tag` in a
   * cross-cutting message, or one of the "also about" chips on one. */
  onJumpToEndpoint: (vayoId: string) => void;
  /** Set when arriving here from a notification click — scrolls to and
   * briefly highlights this exact message once it's loaded, same mechanism
   * as clicking a reply's quoted reference. Null the rest of the time. */
  highlightCommentId?: string | null;
  /** Called once the requested highlight has actually run, so the caller
   * can clear its own state — otherwise leaving and re-entering this tab
   * would keep re-triggering the same highlight. */
  onHighlighted?: () => void;
}

interface ContextMenuState {
  commentId: string;
  x: number;
  y: number;
}

export function TeamChatTab({
  vayoId,
  currentMemberId,
  canResolve,
  memberNames,
  endpoints,
  onJumpToEndpoint,
  highlightCommentId,
  onHighlighted,
}: TeamChatTabProps): JSX.Element {
  const config = useConfig();
  const socket = useSocket();
  const [comments, setComments] = useState<CommentDoc[]>([]);
  const [attachments, setAttachments] = useState<AttachmentDoc[]>([]);
  const [pendingAttachments, setPendingAttachments] = useState<AttachmentDoc[]>([]);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);
  const [body, setBody] = useState("");
  const [flagNext, setFlagNext] = useState(false);
  const [replyingTo, setReplyingTo] = useState<CommentDoc | null>(null);
  const [sending, setSending] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [dateFilter, setDateFilter] = useState<DateFilter>("all");
  const [showDateJump, setShowDateJump] = useState(false);
  // Set by jumpToDateTime() below, then consumed by the effect right after
  // jumpToMessage — resetting the filters and picking the target message
  // both happen in the same batch, but the DOM ref for that message isn't
  // attached until the now-unfiltered list actually re-renders.
  const [pendingJumpId, setPendingJumpId] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [mentionTrigger, setMentionTrigger] = useState<MentionTrigger | null>(null);
  // Powers the "R" quick-reply shortcut — only while a message is actually
  // moused over, and only when focus isn't already in a text field (so
  // typing the letter "r" in a message never gets hijacked).
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  // Powers "reply quote → jump to and briefly highlight the original
  // message" — a lightweight stand-in for a real thread view that fits how
  // Team Chat is framed: one flat conversation per endpoint, not nested
  // sub-threads (docs/06-realtime-collaboration.md's "Naming note").
  const messageRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const [highlightedId, setHighlightedId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .listComments(config, vayoId)
      .then((result) => {
        if (!cancelled) setComments(result);
      })
      .catch(() => {
        if (!cancelled) setComments([]);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config.baseUrl, config.token, vayoId]);

  useEffect(() => {
    let cancelled = false;
    api
      .listAttachments(config, vayoId)
      .then((result) => {
        if (!cancelled) setAttachments(result);
      })
      .catch(() => {
        if (!cancelled) setAttachments([]);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config.baseUrl, config.token, vayoId]);

  useEffect(() => {
    if (!socket) return;
    const onNew = (comment: CommentDoc) => {
      if (!comment.vayoIds.includes(vayoId)) return;
      setComments((prev) => (prev.some((c) => c._id === comment._id) ? prev : [...prev, comment]));
      // A comment with attachments came in from elsewhere — refresh so
      // this client can render them without a full reload.
      api.listAttachments(config, vayoId).then(setAttachments).catch(() => {});
    };
    const onResolved = ({ commentId }: { commentId: string }) => {
      setComments((prev) => prev.map((c) => (c._id === commentId ? { ...c, resolved: true } : c)));
    };
    const onFlagged = ({ commentId, flagged }: { commentId: string; flagged: boolean }) => {
      setComments((prev) => prev.map((c) => (c._id === commentId ? { ...c, flagged } : c)));
    };
    socket.on("comment:new", onNew);
    socket.on("comment:resolved", onResolved);
    socket.on("comment:flagged", onFlagged);
    return () => {
      socket.off("comment:new", onNew);
      socket.off("comment:resolved", onResolved);
      socket.off("comment:flagged", onFlagged);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [socket, vayoId]);

  function startReply(comment: CommentDoc) {
    setReplyingTo(comment);
    inputRef.current?.focus();
  }

  // "R" while hovering a message replies to it, matching the shortcut
  // conventions of Gmail/Superhuman rather than requiring a modifier key —
  // guarded to skip entirely whenever focus is already in a text field, so
  // it can never swallow the letter while someone's actually typing.
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      const active = document.activeElement;
      const isTyping = active instanceof HTMLElement && (active.tagName === "INPUT" || active.tagName === "TEXTAREA");
      if (isTyping) return;
      if (e.key.toLowerCase() === "r" && hoveredId) {
        const comment = comments.find((c) => c._id === hoveredId);
        if (comment) {
          e.preventDefault();
          startReply(comment);
        }
      }
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [hoveredId, comments]);

  async function uploadBlob(blob: Blob, filename: string, kind: "file" | "screen-recording") {
    setUploading(true);
    setUploadError(null);
    try {
      const attachment = await api.uploadAttachment(config, vayoId, blob, filename, kind);
      setPendingAttachments((prev) => [...prev, attachment]);
    } catch (err) {
      setUploadError(err instanceof ApiError ? err.message : "Upload failed");
    } finally {
      setUploading(false);
    }
  }

  function handleFilesSelected(fileList: FileList | null) {
    if (!fileList) return;
    for (const file of Array.from(fileList)) void uploadBlob(file, file.name, "file");
  }

  async function removePendingAttachment(id: string) {
    setPendingAttachments((prev) => prev.filter((a) => a._id !== id));
    await api.deleteAttachment(config, id).catch(() => {});
  }

  async function startScreenRecording() {
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
      const chunks: BlobPart[] = [];
      const recorder = new MediaRecorder(stream);
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunks.push(e.data);
      };
      recorder.onstop = () => {
        stream.getTracks().forEach((track) => track.stop());
        setRecording(false);
        const blob = new Blob(chunks, { type: recorder.mimeType || "video/webm" });
        void uploadBlob(blob, `screen-recording-${Date.now()}.webm`, "screen-recording");
      };
      // The browser's own "Stop sharing" control ends the stream directly —
      // this catches that path too, not just our own Stop button.
      stream.getVideoTracks()[0]?.addEventListener("ended", () => {
        if (recorder.state !== "inactive") recorder.stop();
      });
      mediaRecorderRef.current = recorder;
      recorder.start();
      setRecording(true);
    } catch {
      // User dismissed the screen-share picker, or the browser/context
      // doesn't support getDisplayMedia — nothing to surface as an error.
    }
  }

  function stopScreenRecording() {
    mediaRecorderRef.current?.stop();
  }

  function handleBodyChange(e: ChangeEvent<HTMLInputElement>) {
    const value = e.target.value;
    setBody(value);
    setMentionTrigger(detectMentionTrigger(value, e.target.selectionStart ?? value.length));
  }

  function selectReference(id: string, displayText: string) {
    if (!mentionTrigger) return;
    const result = applyMentionSelection(body, mentionTrigger, displayText, id);
    setBody(result.text);
    setMentionTrigger(null);
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.setSelectionRange(result.cursorIndex, result.cursorIndex);
    });
  }

  const mentionCandidates =
    mentionTrigger?.kind === "mention"
      ? Object.entries(memberNames)
          .filter(([, name]) => name.toLowerCase().includes(mentionTrigger.query.toLowerCase()))
          .slice(0, 6)
      : [];

  const endpointTagCandidates =
    mentionTrigger?.kind === "endpoint"
      ? endpoints.filter((e) => e.path.toLowerCase().includes(mentionTrigger.query.toLowerCase())).slice(0, 6)
      : [];

  async function submit(e: FormEvent) {
    e.preventDefault();
    const trimmed = body.trim();
    if (!trimmed && pendingAttachments.length === 0) return;
    setSending(true);
    try {
      const attachmentIds = pendingAttachments.map((a) => a._id);
      const finalBody = trimmed || (attachmentIds.length === 1 ? "Sent a file" : "Sent files");
      const comment = await api.postComment(config, vayoId, finalBody, flagNext, replyingTo?._id ?? null, attachmentIds);
      setComments((prev) => (prev.some((c) => c._id === comment._id) ? prev : [...prev, comment]));
      if (attachmentIds.length > 0) {
        setAttachments(await api.listAttachments(config, vayoId));
      }
      setBody("");
      setFlagNext(false);
      setReplyingTo(null);
      setPendingAttachments([]);
    } finally {
      setSending(false);
    }
  }

  async function resolve(commentId: string) {
    await api.resolveComment(config, commentId);
    setComments((prev) => prev.map((c) => (c._id === commentId ? { ...c, resolved: true } : c)));
  }

  async function toggleFlag(commentId: string, flagged: boolean) {
    await api.setCommentFlagged(config, commentId, flagged);
    setComments((prev) => prev.map((c) => (c._id === commentId ? { ...c, flagged } : c)));
  }

  function jumpToMessage(id: string) {
    messageRefs.current[id]?.scrollIntoView({ behavior: "smooth", block: "center" });
    setHighlightedId(id);
    window.setTimeout(() => setHighlightedId((current) => (current === id ? null : current)), 1500);
  }

  // Arriving here from a notification click — wait until the target message
  // has actually loaded (comments fetch and this prop can arrive in either
  // order) before jumping, then tell the caller it's done so it can clear
  // its own state and this doesn't re-fire on every re-render.
  useEffect(() => {
    if (!highlightCommentId) return;
    if (!comments.some((c) => c._id === highlightCommentId)) return;
    jumpToMessage(highlightCommentId);
    onHighlighted?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [highlightCommentId, comments]);

  // Mirrors the effect above for a "jump to date/time" pick: jumpToDateTime
  // clears both filters and queues a target id in the same batch, so by the
  // time this runs the (now fully visible) list already contains it.
  useEffect(() => {
    if (!pendingJumpId) return;
    if (!comments.some((c) => c._id === pendingJumpId)) return;
    jumpToMessage(pendingJumpId);
    setPendingJumpId(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingJumpId, comments]);

  /** Finds whichever message sits closest in time to the picked date/time
   * (no exact-match requirement — an arbitrary moment picked by a human
   * almost never lines up with a real message's timestamp) and queues a
   * jump to it, first clearing both filters so it's guaranteed visible. */
  function jumpToDateTime(date: string, time: string) {
    if (!date) return;
    const target = new Date(`${date}T${time || "00:00"}`).getTime();
    if (Number.isNaN(target)) return;
    let nearest: CommentDoc | null = null;
    let nearestDiff = Infinity;
    for (const c of comments) {
      const diff = Math.abs(new Date(c.createdAt).getTime() - target);
      if (diff < nearestDiff) {
        nearest = c;
        nearestDiff = diff;
      }
    }
    if (!nearest) return;
    setSearchQuery("");
    setDateFilter("all");
    setShowDateJump(false);
    setPendingJumpId(nearest._id);
  }

  function authorLabel(authorId: string): string {
    return authorId === currentMemberId ? "You" : (memberNames[authorId] ?? "Former member");
  }

  const query = searchQuery.trim().toLowerCase();
  const hasActiveFilter = Boolean(query) || dateFilter !== "all";
  const visibleComments = comments.filter(
    (c) => (!query || c.body.toLowerCase().includes(query)) && matchesDateFilter(c.createdAt, dateFilter),
  );
  const contextComment = contextMenu ? (comments.find((c) => c._id === contextMenu.commentId) ?? null) : null;
  const attachmentsByComment: Record<string, AttachmentDoc[]> = {};
  for (const attachment of attachments) {
    if (!attachment.commentId) continue;
    (attachmentsByComment[attachment.commentId] ??= []).push(attachment);
  }

  return (
    <div className="tab-panel">
      <div className="chat-search">
        <div className="chat-search__row">
          <Search size={14} />
          <input
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search this conversation…"
          />
          {hasActiveFilter && (
            <span className="muted">
              {visibleComments.length} match{visibleComments.length === 1 ? "" : "es"}
            </span>
          )}
        </div>
        <div className="chat-date-filter">
          {DATE_FILTERS.map((f) => (
            <button
              key={f}
              type="button"
              className={`chat-date-filter__chip ${dateFilter === f ? "chat-date-filter__chip--active" : ""}`}
              onClick={() => setDateFilter(f)}
            >
              {DATE_FILTER_LABELS[f]}
            </button>
          ))}
          <div className="chat-date-jump-anchor">
            <button
              type="button"
              className="chat-date-filter__chip chat-date-filter__chip--jump"
              onClick={() => setShowDateJump((v) => !v)}
              title="Jump to a specific date and time"
            >
              <CalendarClock size={12} />
              Jump to…
            </button>
            {showDateJump && <DateJumpPopover onJump={jumpToDateTime} onClose={() => setShowDateJump(false)} />}
          </div>
        </div>
      </div>
      <div
        className="team-chat"
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          handleFilesSelected(e.dataTransfer.files);
        }}
      >
        {comments.length === 0 && <p className="muted">No messages yet — start the conversation.</p>}
        {comments.length > 0 && hasActiveFilter && visibleComments.length === 0 && (
          <p className="muted">Nothing matches these filters.</p>
        )}
        {visibleComments.map((comment) => {
          const repliedTo = comment.replyToId ? (comments.find((c) => c._id === comment.replyToId) ?? null) : null;
          const commentAttachments = attachmentsByComment[comment._id] ?? [];
          return (
            <div
              key={comment._id}
              ref={(el) => {
                messageRefs.current[comment._id] = el;
              }}
              className={`chat-message ${comment.flagged ? "chat-message--flagged" : ""} ${comment.resolved ? "chat-message--resolved" : ""} ${highlightedId === comment._id ? "chat-message--highlighted" : ""}`}
              onMouseEnter={() => setHoveredId(comment._id)}
              onMouseLeave={() => setHoveredId((current) => (current === comment._id ? null : current))}
              onContextMenu={(e) => {
                e.preventDefault();
                setContextMenu({ commentId: comment._id, x: e.clientX, y: e.clientY });
              }}
            >
              {comment.replyToId && (
                <button type="button" className="chat-message__reply-quote" onClick={() => jumpToMessage(comment.replyToId!)}>
                  <CornerUpLeft size={11} />
                  {repliedTo ? (
                    <>
                      <span className="chat-message__reply-quote-author">{authorLabel(repliedTo.authorId)}</span>
                      <span className="chat-message__reply-quote-body">{snippet(repliedTo.body, 60)}</span>
                    </>
                  ) : (
                    <span>original message</span>
                  )}
                </button>
              )}
              <div className="chat-message__meta">
                <span>{authorLabel(comment.authorId)}</span>
                <span className="muted">{new Date(comment.createdAt).toLocaleString()}</span>
                {comment.flagged && (
                  <span className={`badge ${comment.resolved ? "badge--resolved" : "badge--flagged"}`}>
                    {comment.resolved ? "resolved" : "needs an answer"}
                  </span>
                )}
                <button
                  type="button"
                  className="chat-message__icon-action"
                  title="Reply to this message (or press R while hovering it)"
                  onClick={() => startReply(comment)}
                >
                  <CornerUpLeft size={13} />
                </button>
                <button
                  type="button"
                  className={`chat-message__flag-toggle ${comment.flagged ? "chat-message__flag-toggle--active" : ""}`}
                  title={comment.flagged ? "Unflag — this doesn't need resolving" : "Flag as a question/issue that needs resolving"}
                  onClick={() => toggleFlag(comment._id, !comment.flagged)}
                >
                  <Flag size={13} />
                </button>
              </div>
              <div className="chat-message__body">
                <MessageBody body={comment.body} endpoints={endpoints} onJumpToEndpoint={onJumpToEndpoint} />
              </div>
              {comment.vayoIds.length > 1 && (
                <div className="chat-message__also-about">
                  also about:{" "}
                  {comment.vayoIds
                    .filter((v) => v !== vayoId)
                    .map((v) => {
                      const other = endpoints.find((e) => e.vayoId === v);
                      return (
                        <button key={v} type="button" className="chat-endpoint-tag" onClick={() => onJumpToEndpoint(v)}>
                          {other ? other.path : "a deleted endpoint"}
                        </button>
                      );
                    })}
                </div>
              )}
              {commentAttachments.length > 0 && (
                <div className="chat-message__attachments">
                  {commentAttachments.map((attachment) => (
                    <AttachmentPreview key={attachment._id} attachment={attachment} url={api.attachmentDownloadUrl(config, attachment._id)} />
                  ))}
                </div>
              )}
              {comment.flagged && !comment.resolved && canResolve && (
                <button type="button" className="link-button" onClick={() => resolve(comment._id)}>
                  Mark resolved
                </button>
              )}
            </div>
          );
        })}
      </div>
      {contextMenu && contextComment && (
        <ChatContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          flagged={contextComment.flagged}
          onReply={() => startReply(contextComment)}
          onToggleFlag={() => toggleFlag(contextComment._id, !contextComment.flagged)}
          onCopy={() => void navigator.clipboard.writeText(contextComment.body)}
          onClose={() => setContextMenu(null)}
        />
      )}
      <form className="chat-input" onSubmit={submit}>
        {uploadError && (
          <div className="banner banner--error">
            {uploadError}
            <button type="button" className="icon-button" onClick={() => setUploadError(null)}>
              <X size={13} />
            </button>
          </div>
        )}
        {pendingAttachments.length > 0 && (
          <div className="chat-input__pending-attachments">
            {pendingAttachments.map((attachment) => (
              <div key={attachment._id} className="chat-input__pending-attachment">
                {attachment.kind === "screen-recording" ? <MonitorPlay size={13} /> : <File size={13} />}
                <span>{attachment.filename}</span>
                <button type="button" className="icon-button" title="Remove" onClick={() => removePendingAttachment(attachment._id)}>
                  <X size={13} />
                </button>
              </div>
            ))}
          </div>
        )}
        {replyingTo && (
          <div className="chat-input__replying-to">
            <CornerUpLeft size={12} />
            <span className="chat-input__replying-to-author">{authorLabel(replyingTo.authorId)}</span>
            <span className="chat-input__replying-to-body">{snippet(replyingTo.body, 80)}</span>
            <button type="button" className="icon-button" title="Cancel reply" onClick={() => setReplyingTo(null)}>
              <X size={13} />
            </button>
          </div>
        )}
        <div className="chat-input__row">
          <div className="chat-input__field-wrapper">
            {mentionTrigger?.kind === "mention" && mentionCandidates.length > 0 && (
              <div className="chat-mention-menu">
                {mentionCandidates.map(([id, name]) => (
                  <button key={id} type="button" onClick={() => selectReference(id, name)}>
                    {name}
                  </button>
                ))}
              </div>
            )}
            {mentionTrigger?.kind === "endpoint" && endpointTagCandidates.length > 0 && (
              <div className="chat-mention-menu">
                {endpointTagCandidates.map((endpoint) => (
                  <button key={endpoint.vayoId} type="button" onClick={() => selectReference(endpoint.vayoId, endpoint.path)}>
                    <span className={`method-badge method-badge--${endpoint.method.toLowerCase()}`}>{endpoint.method}</span> {endpoint.path}
                  </button>
                ))}
              </div>
            )}
            <input
              ref={inputRef}
              name="message"
              value={body}
              onChange={handleBodyChange}
              onKeyDown={(e) => {
                if (e.key === "Escape" && replyingTo) setReplyingTo(null);
              }}
              placeholder={replyingTo ? "Write a reply…" : "Write a message… (@ to mention, # to tag another endpoint, hover + R to reply)"}
            />
          </div>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="chat-input__file-picker"
            onChange={(e) => {
              handleFilesSelected(e.target.files);
              e.target.value = "";
            }}
          />
          <button
            type="button"
            className="chat-input__icon-button"
            title="Attach files"
            disabled={uploading}
            onClick={() => fileInputRef.current?.click()}
          >
            <Paperclip size={14} />
          </button>
          <button
            type="button"
            className={`chat-input__icon-button ${recording ? "chat-input__icon-button--active" : ""}`}
            title={recording ? "Stop recording" : "Record your screen"}
            disabled={uploading && !recording}
            onClick={recording ? stopScreenRecording : startScreenRecording}
          >
            {recording ? <CircleStop size={14} /> : <MonitorPlay size={14} />}
          </button>
          <button
            type="button"
            className={`chat-input__flag-toggle ${flagNext ? "chat-input__flag-toggle--active" : ""}`}
            title="Flag this as a question/issue that needs an answer"
            onClick={() => setFlagNext((v) => !v)}
          >
            <Flag size={14} />
            <span>Flag</span>
          </button>
          <button type="submit" className="button button--primary" disabled={sending || uploading || (!body.trim() && pendingAttachments.length === 0)}>
            Send
          </button>
        </div>
      </form>
    </div>
  );
}
