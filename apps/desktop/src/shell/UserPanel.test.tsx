import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { appStore } from "../api/store";
import { UserPanel } from "./UserPanel";

// useMediaQuery reads window.matchMedia; the server-render snapshot is always "false", so the phone case stubs the hook.
const narrow = vi.hoisted(() => ({ value: false }));
vi.mock("./useMediaQuery", () => ({ useMediaQuery: () => narrow.value }));

describe("UserPanel Inbox button", () => {
  afterEach(() => {
    narrow.value = false;
  });
  const render = () => {
    appStore.setState({ me: { id: "me", username: "sam" } as never });
    return renderToStaticMarkup(<UserPanel />);
  };

  it("is not rendered at desktop width (the title bar has the Inbox)", () => {
    expect(render()).not.toContain('aria-label="Inbox"');
  });

  it("is rendered at phone width", () => {
    narrow.value = true;
    expect(render()).toContain('aria-label="Inbox"');
  });
});
