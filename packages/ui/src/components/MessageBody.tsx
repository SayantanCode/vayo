// @vayo/ui — renders a Team Chat message body, turning `@[Name](memberId)`
// and `#[path](vayoId)` tokens into a highlighted mention or a clickable
// endpoint-tag respectively, instead of the raw stored syntax. Shared by
// the per-endpoint Team Chat tab and the cross-endpoint chat drawer so a
// tag jumps to the right place identically from either surface.

import { parseMentions } from "../mentions.js";
import type { EndpointSummary } from "../types.js";

interface MessageBodyProps {
  body: string;
  endpoints: EndpointSummary[];
  onJumpToEndpoint: (vayoId: string) => void;
}

export function MessageBody({ body, endpoints, onJumpToEndpoint }: MessageBodyProps): JSX.Element {
  return (
    <>
      {parseMentions(body).map((segment, i) => {
        if (segment.type === "mention") {
          return (
            <span key={i} className="chat-mention">
              @{segment.content}
            </span>
          );
        }
        if (segment.type === "endpoint") {
          // A tagged endpoint can have since been deleted (manual endpoint
          // removed, etc.) — the tag still renders (historical text, same
          // as a mention for a former member), just not clickable.
          const exists = segment.vayoId ? endpoints.some((e) => e.vayoId === segment.vayoId) : false;
          return (
            <button
              key={i}
              type="button"
              className="chat-endpoint-tag"
              disabled={!exists}
              title={exists ? "Jump to this endpoint" : "This endpoint no longer exists"}
              onClick={() => segment.vayoId && onJumpToEndpoint(segment.vayoId)}
            >
              #{segment.content}
            </button>
          );
        }
        return <span key={i}>{segment.content}</span>;
      })}
    </>
  );
}
