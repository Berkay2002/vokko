// The Friends page's open tab, in a store so other places (Create DM with no friends) can send people to Add Friend.
import { create } from "zustand";
import { go } from "./nav";
import { useNavDrawer } from "./navDrawer";

export type FriendsTab = "online" | "all" | "pending" | "suggestions" | "blocked" | "add";

export const useFriendsTab = create<{ tab: FriendsTab; setTab(tab: FriendsTab): void }>(set => ({
  tab: "online",
  setTab: tab => set({ tab }),
}));

/** Friends > Add Friend, from anywhere. */
export function openAddFriend(): void {
  useFriendsTab.getState().setTab("add");
  if (window.location.pathname !== "/channels/@me") go("/channels/@me");
  // Phone: show the Friends page over the Home list, after the route effect that opens the list on Home.
  setTimeout(() => useNavDrawer.getState().setOpen(false));
}
