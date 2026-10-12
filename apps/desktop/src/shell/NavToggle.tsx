import { ArrowLeft } from "lucide-react";
import { useNavDrawer } from "./navDrawer";

/** The back arrow of the chat page on a phone: returns to the server rail and sidebar page. Hidden by CSS above the narrow breakpoint. */
export function NavToggle({ className = "" }: { className?: string }) {
  const open = useNavDrawer(s => s.open);
  return (
    <button type="button" className={`nav-toggle ${className}`.trim()} aria-label={open ? "Hide Channels" : "Show Channels"} aria-expanded={open} onClick={() => useNavDrawer.getState().toggle()}>
      <ArrowLeft size={24} />
    </button>
  );
}
