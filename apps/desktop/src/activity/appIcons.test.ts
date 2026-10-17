import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunningProcess } from "../desktop/games";

const mocks = vi.hoisted(() => ({ info: vi.fn(), upload: vi.fn() }));

vi.mock("../desktop", () => ({ isDesktop: () => true }));
vi.mock("../desktop/games", async importOriginal => ({ ...(await importOriginal<typeof import("../desktop/games")>()), readAppInfo: mocks.info }));
vi.mock("../api/appIcons", () => ({ uploadAppIcon: mocks.upload, appIconSrc: () => null }));
vi.mock("../shell/actions", () => ({ resendOwnStatus: vi.fn() }));

import { activitiesFor, addRegisteredGame, iconOf, resetAppIconCache, shareAppIcon, useActivity } from "./index";

const ICON = "iVBORw0KGgo=";
const ASSET = `app:${"ab".repeat(32)}`;
const chrome: RunningProcess = { name: "chrome.exe", startedAt: 1000, system: false };
/** Lets the promise chains of learnApp / shareAppIcon settle. */
const settle = () => new Promise(resolve => setTimeout(resolve, 0));

beforeEach(() => {
  resetAppIconCache();
  mocks.info.mockReset();
  mocks.upload.mockReset();
  mocks.info.mockResolvedValue({ name: "Google Chrome", icon: ICON });
  mocks.upload.mockResolvedValue(ASSET);
  useActivity.setState({ share: true, registered: [], running: [chrome], detected: null, icons: {}, assets: {} });
});

afterEach(() => vi.useRealTimers());

describe("app names and icons", () => {
  it("renames an added app from its file name to the real name and keeps the icon", async () => {
    addRegisteredGame(chrome);
    expect(useActivity.getState().registered[0]?.name).toBe("chrome");
    await settle();
    expect(useActivity.getState().registered[0]).toMatchObject({ name: "Google Chrome", icon: ICON });
    expect(useActivity.getState().detected?.name).toBe("Google Chrome");
    expect(iconOf("Chrome.EXE")).toBe(ICON);
  });

  it("does not rename an entry whose name the user already had", async () => {
    addRegisteredGame(chrome, "My browser");
    await settle();
    expect(useActivity.getState().registered[0]).toMatchObject({ name: "My browser", icon: ICON });
  });

  it("asks the shell once per executable", async () => {
    addRegisteredGame(chrome);
    await settle();
    await shareAppIcon();
    expect(mocks.info).toHaveBeenCalledTimes(1);
  });

  it("uploads the icon of the detected app while sharing and then sends it with the activity", async () => {
    addRegisteredGame(chrome);
    await settle();
    expect(mocks.upload).toHaveBeenCalledTimes(1);
    expect(mocks.upload).toHaveBeenCalledWith(ICON);
    const { detected, assets } = useActivity.getState();
    expect(activitiesFor({ share: true, detected, assets })).toEqual([{ name: "Google Chrome", type: 0, timestamps: { start: 1000 }, assets: { large_image: ASSET }, app: true }]);
    await shareAppIcon();
    expect(mocks.upload).toHaveBeenCalledTimes(1);
  });

  it("uploads nothing while sharing is off, and sends no asset before the upload succeeded", async () => {
    useActivity.setState({ share: false });
    addRegisteredGame(chrome);
    await settle();
    expect(mocks.upload).not.toHaveBeenCalled();
    expect(activitiesFor({ share: true, detected: useActivity.getState().detected, assets: {} })[0]?.assets).toBeUndefined();
    useActivity.setState({ share: true });
    await shareAppIcon();
    expect(mocks.upload).toHaveBeenCalledTimes(1);
  });

  it("retries a failed upload only after five minutes", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    mocks.upload.mockRejectedValueOnce(new Error("down"));
    addRegisteredGame(chrome);
    await settle();
    expect(mocks.upload).toHaveBeenCalledTimes(1);
    expect(useActivity.getState().assets).toEqual({});
    await shareAppIcon();
    expect(mocks.upload).toHaveBeenCalledTimes(1);
    vi.setSystemTime(Date.now() + 5 * 60_000 + 1);
    await shareAppIcon();
    expect(mocks.upload).toHaveBeenCalledTimes(2);
    expect(useActivity.getState().assets).toEqual({ chrome: ASSET });
  });

  it("drops icon data that is not base64", async () => {
    mocks.info.mockResolvedValue({ name: "Evil", icon: '"><script>' });
    addRegisteredGame(chrome);
    await settle();
    expect(useActivity.getState().registered[0]?.icon).toBeUndefined();
    expect(mocks.upload).not.toHaveBeenCalled();
  });
});
