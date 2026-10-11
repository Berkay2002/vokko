import { FollowDialog } from "./FollowModal";
import { ThreadDialogs } from "./ThreadModals";

/** Dialogs of the thread feature (create thread, follow). Mounted once next to the shell's modal host. */
export function ThreadHost() {
  return (
    <>
      <ThreadDialogs />
      <FollowDialog />
    </>
  );
}
