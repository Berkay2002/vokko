import { useState } from "react";
import { Gamepad2 } from "lucide-react";
import { appIconUrl } from "../activity/format";
import type { Activity } from "../api/types";

/**
 * The app icon of a Playing activity (or a local `data:` URL for the user's own apps), else the pad. `size` is the pad's size and
 * the icon's when it is not `fill`; `fill` makes the icon cover its tile, which already has the size.
 */
export function ActivityIcon({ activity, src, size, fill }: { activity?: Activity | null; src?: string | null; size: number; fill?: boolean }) {
  const url = src ?? (activity ? appIconUrl(activity) : null);
  const [failed, setFailed] = useState<string | null>(null);
  if (url && failed !== url) {
    const side = fill ? "100%" : size;
    return <img className="activity-app-icon" data-testid="activity-app-icon" src={url} alt="" width={side} height={side} draggable={false} referrerPolicy="no-referrer" onError={() => setFailed(url)} />;
  }
  return <Gamepad2 size={size} />;
}
