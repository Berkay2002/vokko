// An application's icon, or its initials on the brand colour when it has none.
import { resolveUrl } from "../api/rest";

export function AppIcon({ name, icon, size }: { name: string; icon: string | null; size: number }) {
  if (icon) return <img className="apps-icon" src={resolveUrl(icon)} alt="" width={size} height={size} style={{ width: size, height: size }} />;
  const initials = name.split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0]?.toUpperCase() ?? "").join("") || "?";
  return (
    <span className="apps-icon initials" aria-hidden="true" style={{ width: size, height: size, fontSize: Math.max(8, Math.round(size * 0.42)) }}>
      {initials}
    </span>
  );
}
