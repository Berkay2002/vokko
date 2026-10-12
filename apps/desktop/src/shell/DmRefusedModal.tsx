// Shown when opening a DM is refused (403, code 50007): the recipient does not accept DMs from you.
import { DM_REFUSED_REASON } from "../api/errors";
import { Modal } from "../ui";
import { closeModal } from "./modalStore";

export function DmRefusedModal() {
  return (
    <Modal
      open
      onClose={closeModal}
      title="You can't message this person"
      footer={
        <button type="button" className="btn btn-primary" autoFocus onClick={closeModal}>
          Okay
        </button>
      }
    >
      <p data-testid="dm-refused">{DM_REFUSED_REASON}</p>
    </Modal>
  );
}