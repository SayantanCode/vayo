// @vayo/ui — small, self-contained pieces used by TeamChatTab, extracted
// out of that file since none of them need its state: a right-click message
// context menu, the date/time jump popover, an attachment renderer, and the
// snippet-truncation helper shared by reply-quote previews.
import { useRef, useState } from "react";
import { Copy, CornerUpLeft, Download, File, Flag } from "lucide-react";
import type { AttachmentDoc } from "@vayo/types";
import { useDismiss } from "../../hooks/useDismiss.js";

export function snippet(body: string, max: number): string {
  return body.length > max ? `${body.slice(0, max)}…` : body;
}

/** Right-click menu for one message — Reply / Flag toggle / Copy text.
 * Closes on an outside click or Escape, same as any native context menu. */
export function ChatContextMenu({
  x,
  y,
  flagged,
  onReply,
  onToggleFlag,
  onCopy,
  onClose,
}: {
  x: number;
  y: number;
  flagged: boolean;
  onReply: () => void;
  onToggleFlag: () => void;
  onCopy: () => void;
  onClose: () => void;
}): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(ref, onClose);

  const left = Math.min(x, window.innerWidth - 180);
  const top = Math.min(y, window.innerHeight - 140);

  return (
    <div ref={ref} className="chat-context-menu" style={{ left, top }}>
      <button
        type="button"
        onClick={() => {
          onReply();
          onClose();
        }}
      >
        <CornerUpLeft size={13} />
        Reply
      </button>
      <button
        type="button"
        onClick={() => {
          onToggleFlag();
          onClose();
        }}
      >
        <Flag size={13} />
        {flagged ? "Unflag" : "Flag as question/issue"}
      </button>
      <button
        type="button"
        onClick={() => {
          onCopy();
          onClose();
        }}
      >
        <Copy size={13} />
        Copy text
      </button>
    </div>
  );
}

/** Popover for jumping to an arbitrary point in the conversation — pick a
 * date and (optionally) a time, and the nearest message to that moment gets
 * scrolled to and highlighted, the same way a reply-quote jump does. This is
 * deliberately two native date/time inputs rather than a full custom
 * calendar grid: far less to build and maintain, and still themeable enough
 * (border, radius, colors) to sit comfortably next to the rest of the app —
 * only the browser's own popup calendar/clock affordance stays native.
 * Closes on an outside click or Escape, same as the context menu above. */
export function DateJumpPopover({ onJump, onClose }: { onJump: (date: string, time: string) => void; onClose: () => void }): JSX.Element {
  const [date, setDate] = useState("");
  const [time, setTime] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(ref, onClose);

  return (
    <div ref={ref} className="chat-date-jump">
      <label className="chat-date-jump__field">
        Date
        <input type="date" value={date} onChange={(e) => setDate(e.target.value)} autoFocus />
      </label>
      <label className="chat-date-jump__field">
        Time
        <input type="time" value={time} onChange={(e) => setTime(e.target.value)} />
      </label>
      <button type="button" className="button button--primary chat-date-jump__submit" disabled={!date} onClick={() => onJump(date, time)}>
        Jump
      </button>
    </div>
  );
}

export function AttachmentPreview({ attachment, url }: { attachment: AttachmentDoc; url: string }): JSX.Element {
  if (attachment.mimeType.startsWith("image/")) {
    return (
      <a href={url} target="_blank" rel="noreferrer" className="chat-attachment chat-attachment--image">
        <img src={url} alt={attachment.filename} />
      </a>
    );
  }
  if (attachment.mimeType.startsWith("video/")) {
    return (
      <video src={url} controls className="chat-attachment chat-attachment--video">
        <track kind="captions" />
      </video>
    );
  }
  return (
    <a href={url} download={attachment.filename} className="chat-attachment chat-attachment--file">
      <File size={14} />
      <span>{attachment.filename}</span>
      <Download size={12} />
    </a>
  );
}
