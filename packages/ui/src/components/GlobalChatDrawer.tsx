// @vayo/ui — the header's cross-endpoint chat: a side drawer (not a page you
// navigate to, not a blocking modal) so asking "how do these APIs relate"
// never means losing your place on whatever tab you're already on. Scoped
// to messages tagging 2+ endpoints specifically — a focused "questions that
// span APIs" feed, not a firehose of every single-endpoint chat message in
// the project (that stays in each endpoint's own Team Chat tab).

import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import { X } from "lucide-react";
import type { CommentDoc } from "@vayo/types";
import { api, ApiError } from "../api.js";
import { applyMentionSelection, detectMentionTrigger, formatEndpointTagToken, type MentionTrigger } from "../mentions.js";
import { MessageBody } from "./MessageBody.js";
import type { EndpointSummary } from "../types.js";
import { useEscapeKey } from "../hooks/useDismiss.js";
import { useConfig } from "../contexts/ConfigContext.js";
import { useSocket } from "../contexts/SocketContext.js";

interface GlobalChatDrawerProps {
  endpoints: EndpointSummary[];
  memberNames: Record<string, string>;
  currentMemberId: string;
  /** The endpoint open behind the drawer, if any — pre-fills the compose
   * box with a tag for it, since a cross-cutting question almost always
   * starts from wherever the asker already is. */
  currentVayoId: string | null;
  onJumpToEndpoint: (vayoId: string) => void;
  onClose: () => void;
}

function authorLabel(authorId: string, currentMemberId: string, memberNames: Record<string, string>): string {
  return authorId === currentMemberId ? "You" : (memberNames[authorId] ?? "Former member");
}

const TAGGED_VAYOID_PATTERN = /#\[[^\]]+\]\(([^)]+)\)/g;

export function GlobalChatDrawer({
  endpoints,
  memberNames,
  currentMemberId,
  currentVayoId,
  onJumpToEndpoint,
  onClose,
}: GlobalChatDrawerProps): JSX.Element {
  const config = useConfig();
  const socket = useSocket();
  const [comments, setComments] = useState<CommentDoc[]>([]);
  const [loading, setLoading] = useState(true);
  const [body, setBody] = useState(() => {
    const current = currentVayoId ? endpoints.find((e) => e.vayoId === currentVayoId) : undefined;
    return current ? `${formatEndpointTagToken(current.path, current.vayoId)} ` : "";
  });
  const [mentionTrigger, setMentionTrigger] = useState<MentionTrigger | null>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  useEscapeKey(onClose);

  useEffect(() => {
    api
      .listCrossCuttingComments(config)
      .then((result) => setComments(result.slice().reverse())) // server returns newest-first; a chat reads oldest-first
      .catch(() => setComments([]))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config.baseUrl, config.token]);

  useEffect(() => {
    if (!socket) return;
    // The server only broadcasts comment:new to the shared "project" room
    // when a comment is actually cross-cutting (2+ vayoIds) — the length
    // check here is just belt-and-suspenders, not load-bearing filtering.
    const onNew = (comment: CommentDoc) => {
      if (comment.vayoIds.length < 2) return;
      setComments((prev) => (prev.some((c) => c._id === comment._id) ? prev : [...prev, comment]));
    };
    socket.on("comment:new", onNew);
    return () => {
      socket.off("comment:new", onNew);
    };
  }, [socket]);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [comments.length]);

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

  // Unlike the per-endpoint Team Chat tab (which always has an implicit
  // anchor endpoint), the drawer isn't anchored to anything — every vayoId
  // this comment ends up "about" has to come from an explicit #tag typed
  // right here.
  const taggedVayoIds = [...new Set([...body.matchAll(TAGGED_VAYOID_PATTERN)].map((m) => m[1]!))];

  async function submit(e: FormEvent) {
    e.preventDefault();
    const trimmed = body.trim();
    if (!trimmed || taggedVayoIds.length === 0) return;
    setSending(true);
    setError(null);
    try {
      const comment = await api.postComment(config, taggedVayoIds[0]!, trimmed, false, null);
      setComments((prev) => (prev.some((c) => c._id === comment._id) ? prev : [...prev, comment]));
      setBody("");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not send that.");
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="global-chat-drawer">
      <div className="global-chat-drawer__header">
        <h3>Cross-endpoint chat</h3>
        <button type="button" className="icon-button" onClick={onClose} title="Close">
          <X size={16} />
        </button>
      </div>
      <p className="muted global-chat-drawer__hint">
        Questions that span multiple APIs — tag two or more endpoints with # below. Each one also shows up in that endpoint's own Team Chat
        tab.
      </p>
      <div className="global-chat-drawer__list" ref={listRef}>
        {loading ? (
          <p className="muted">Loading…</p>
        ) : comments.length === 0 ? (
          <p className="muted global-chat-drawer__empty">No cross-endpoint questions yet. Tag two or more endpoints below to start one.</p>
        ) : (
          comments.map((comment) => (
            <div key={comment._id} className="global-chat-drawer__message">
              <div className="chat-message__meta">
                <span>{authorLabel(comment.authorId, currentMemberId, memberNames)}</span>
                <span className="muted">{new Date(comment.createdAt).toLocaleString()}</span>
              </div>
              <div className="global-chat-drawer__message-tags">
                {comment.vayoIds.map((v) => {
                  const endpoint = endpoints.find((e) => e.vayoId === v);
                  return (
                    <button
                      key={v}
                      type="button"
                      className="chat-endpoint-tag"
                      disabled={!endpoint}
                      title={endpoint ? "Jump to this endpoint" : "This endpoint no longer exists"}
                      onClick={() => onJumpToEndpoint(v)}
                    >
                      {endpoint ? endpoint.path : "deleted endpoint"}
                    </button>
                  );
                })}
              </div>
              <div className="chat-message__body">
                <MessageBody body={comment.body} endpoints={endpoints} onJumpToEndpoint={onJumpToEndpoint} />
              </div>
            </div>
          ))
        )}
      </div>
      {error && <div className="banner banner--error">{error}</div>}
      <form className="global-chat-drawer__compose" onSubmit={submit}>
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
            placeholder="# to tag an endpoint, then ask your question…"
          />
        </div>
        <button type="submit" className="button button--primary" disabled={sending || !body.trim() || taggedVayoIds.length === 0}>
          Send
        </button>
      </form>
    </div>
  );
}
