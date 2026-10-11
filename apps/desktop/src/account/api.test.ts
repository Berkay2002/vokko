import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AccountInfo } from "../api/types";

const pending: Array<(info: AccountInfo) => void> = [];
vi.mock("../api/rest", () => ({ request: () => new Promise((resolve) => pending.push(resolve)) }));

const { accountStore, loadAccount } = await import("./api");
const { appStore } = await import("../api/store");

const info = (email: string) => ({ email }) as unknown as AccountInfo;

describe("loadAccount", () => {
  beforeEach(() => {
    pending.length = 0;
    appStore.setState({ token: "a" });
    accountStore.setState({ info: null, error: null });
  });

  it("drops an answer that arrives after the session changed", async () => {
    const load = loadAccount();
    appStore.setState({ token: "b" });
    pending[0]?.(info("a@example.test"));
    await load;
    expect(accountStore.getState().info).toBeNull();
  });

  it("keeps only the latest load", async () => {
    const older = loadAccount();
    const newer = loadAccount();
    pending[1]?.(info("new@example.test"));
    await newer;
    pending[0]?.(info("old@example.test"));
    await older;
    expect(accountStore.getState().info?.email).toBe("new@example.test");
  });
});
