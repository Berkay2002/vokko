// Shown when the server drops a server from the list while it is open or not (kicked, banned or deleted: the event does not say which).
import { Modal } from "../ui";
import { closeModal } from "./modalStore";

export function GuildGoneModal({ name }: { name: string }) {
  return (
    <Modal
      open
      onClose={closeModal}
      title={`You're no longer in ${name}`}
      footer={
        <button type="button" className="btn btn-primary" autoFocus onClick={closeModal}>
          Okay
        </button>
      }
    >
      <p data-testid="guild-gone">You can't open this server anymore. To get back in, you need a new invite.</p>
    </Modal>
  );
}
