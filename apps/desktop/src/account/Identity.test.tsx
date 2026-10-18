import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AccountInfo, User } from "../api/types";

// zustand renders its initial state on the server, so the store is swapped for a plain object here
const state: { info: AccountInfo | null; error: string | null } = { info: null, error: null };
vi.mock("./api", async original => ({
  ...(await original<typeof import("./api")>()),
  accountStore: Object.assign((pick: (s: typeof state) => unknown) => pick(state), { getState: () => state }),
}));
const { AccountIdentity } = await import("./Identity");
const accountStore = { setState: (patch: Partial<typeof state>) => Object.assign(state, patch) };

const me = { id: "1", username: "sam", global_name: null, avatar: null } as unknown as User;

describe("AccountIdentity email row", () => {
  beforeEach(() => accountStore.setState({ info: null, error: null }));

  it("says Loading while the account request is out", () => {
    expect(renderToStaticMarkup(<AccountIdentity me={me} />)).toContain("Loading...");
  });

  it("shows an error with Retry when the account request failed", () => {
    accountStore.setState({ error: "Network error" });
    const html = renderToStaticMarkup(<AccountIdentity me={me} />);
    expect(html).toContain("Couldn&#x27;t load your email.");
    expect(html).toContain(">Retry</button>");
    expect(html).not.toContain("Loading...");
  });

  it("shows the masked email once loaded", () => {
    accountStore.setState({ info: { email: "sam@example.test", verified: true, has_password: true } as AccountInfo });
    expect(renderToStaticMarkup(<AccountIdentity me={me} />)).toContain("@example.test");
  });
});
