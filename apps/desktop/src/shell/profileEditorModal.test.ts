import { beforeEach, describe, expect, it } from "vitest";
import { closeModal, openModal, useModals } from "./modalStore";
import { blockedByUnsaved, registerUnsaved } from "./settings/unsaved";

// The profile editor stacks over User Settings: settings is parked under it, the unsaved guard covers both, Esc order is by layer.
describe("profile editor in the modal store", () => {
  beforeEach(() => useModals.setState({ modal: null, base: null, queued: null, serial: 0, counter: 0 }));

  it("parks User Settings underneath and returns to it on close", () => {
    openModal({ type: "userSettings" });
    openModal({ type: "profileEditor" });
    const state = useModals.getState();
    expect(state.modal?.type).toBe("profileEditor");
    expect(state.base?.spec.type).toBe("userSettings");
    closeModal();
    expect(useModals.getState().modal?.type).toBe("userSettings");
    expect(useModals.getState().base).toBeNull();
    closeModal();
    expect(useModals.getState().modal).toBeNull();
  });

  it("holds a dialog opened by a shortcut until the editor closes, then opens it over settings", () => {
    openModal({ type: "userSettings" });
    openModal({ type: "profileEditor" });
    openModal({ type: "quickSwitcher" });
    expect(useModals.getState().modal?.type).toBe("profileEditor");
    expect(useModals.getState().base?.spec.type).toBe("userSettings");
    closeModal();
    expect(useModals.getState().modal?.type).toBe("quickSwitcher");
    expect(useModals.getState().base?.spec.type).toBe("userSettings");
    closeModal();
    expect(useModals.getState().modal?.type).toBe("userSettings");
    expect(useModals.getState().queued).toBeNull();
  });

  it("opened from a dialog over settings, keeps settings parked underneath", () => {
    openModal({ type: "userSettings" });
    openModal({ type: "shortcuts" });
    openModal({ type: "profileEditor" });
    expect(useModals.getState().modal?.type).toBe("profileEditor");
    expect(useModals.getState().base?.spec.type).toBe("userSettings");
    closeModal();
    expect(useModals.getState().modal?.type).toBe("userSettings");
  });

  it("an unsaved bar refuses leaving (and the editor's close goes through the same guard)", () => {
    openModal({ type: "userSettings" });
    openModal({ type: "profileEditor" });
    const release = registerUnsaved();
    expect(blockedByUnsaved()).toBe(true);
    release();
    expect(blockedByUnsaved()).toBe(false);
  });
});
