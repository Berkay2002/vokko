import { create } from "zustand";

/** Below the narrow breakpoint (see styles/responsive.css) the server rail and sidebar become a drawer over the chat. */
export const NARROW_QUERY = "(max-width: 767px)";

export const useNavDrawer = create<{ open: boolean; toggle(): void; close(): void }>(set => ({
  open: false,
  toggle: () => set(s => ({ open: !s.open })),
  close: () => set({ open: false }),
}));
