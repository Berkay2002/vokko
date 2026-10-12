import { create } from "zustand";

/**
 * Below the narrow breakpoint (see styles/responsive.css) the server rail and sidebar are a page of their own (`open`): full width, with
 * the chat as the next page. `details` is the channel / DM details page that opens from the header name.
 */
export const NARROW_QUERY = "(max-width: 767px)";

export const useNavDrawer = create<{ open: boolean; details: boolean; toggle(): void; close(): void; setOpen(open: boolean): void; setDetails(open: boolean): void }>(set => ({
  open: false,
  details: false,
  toggle: () => set(s => ({ open: !s.open, details: false })),
  close: () => set({ open: false }),
  setOpen: open => set({ open }),
  setDetails: details => set({ details }),
}));
