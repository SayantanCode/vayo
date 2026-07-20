// @vayo/ui — shared avatar: a member's uploaded picture if they have one,
// else a deterministic initials-in-a-circle fallback (same visual slot
// either way, so callers never need to branch on whether an avatar exists).
// Optionally overlays a presence dot — omitted entirely when `online` isn't
// passed, since not every place an avatar appears cares about presence.

const INITIALS_PALETTE = [
  "#f97066", // coral
  "#f79009", // amber
  "#84cc16", // lime
  "#12b76a", // green
  "#0ea5e9", // sky
  "#6366f1", // indigo
  "#a855f7", // violet
  "#ec4899", // pink
];

function getInitials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  const first = words[0]!.charAt(0);
  const last = words.length > 1 ? words[words.length - 1]!.charAt(0) : "";
  return (first + last).toUpperCase();
}

/** Same name always maps to the same color, without persisting anything —
 * a simple char-code sum keeps two similar names (e.g. "Alex"/"Alice")
 * from usually landing on the same swatch. */
function colorForName(name: string): string {
  let sum = 0;
  for (let i = 0; i < name.length; i++) sum += name.charCodeAt(i);
  return INITIALS_PALETTE[sum % INITIALS_PALETTE.length]!;
}

interface AvatarProps {
  name: string;
  avatarUrl: string | null;
  /** Pixel size (both dimensions — always rendered as a circle). */
  size?: number;
  /** Omit to render no presence indicator at all; pass `true`/`false` to
   * show the online/offline dot. */
  online?: boolean;
}

export function Avatar({ name, avatarUrl, size = 28, online }: AvatarProps): JSX.Element {
  return (
    <span className="avatar" style={{ width: size, height: size }} title={name}>
      {avatarUrl ? (
        <img src={avatarUrl} alt="" className="avatar__image" />
      ) : (
        <span className="avatar__initials" style={{ background: colorForName(name), fontSize: size * 0.4 }}>
          {getInitials(name)}
        </span>
      )}
      {online !== undefined && (
        <span
          className={`avatar__presence-dot ${online ? "avatar__presence-dot--online" : "avatar__presence-dot--offline"}`}
          aria-label={online ? "Online" : "Offline"}
        />
      )}
    </span>
  );
}
