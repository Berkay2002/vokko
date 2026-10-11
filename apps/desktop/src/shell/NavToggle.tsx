import { Menu } from "lucide-react";
import { useNavDrawer } from "./navDrawer";

/** Opens the server rail and sidebar drawer. Hidden by CSS above the narrow breakpoint. */
export function NavToggle({ className = "" }: { className?: string }) {
  const open = useNavDrawer(s => s.open);
  return (
    <button type="button" className={`nav-toggle ${className}`.trim()} aria-label={open ? "Hide Channels" : "Show Channels"} aria-expanded={open} onClick={() => useNavDrawer.getState().toggle()}>
      <Menu size={24} />
    </button>
  );
}
