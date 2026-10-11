import { describe, expect, it } from "vitest";
import { isDeviceFailure, resolveDeviceId, withDeviceFallback } from "./devices";

const devices = [
  { deviceId: "default", label: "Default" },
  { deviceId: "id-usb", label: "Headset Microphone (USB)" },
  { deviceId: "id-builtin", label: "Built-in Microphone" },
];

const domError = (name: string) => Object.assign(new Error(name), { name });

describe("audio device resolution", () => {
  it("keeps the default and known device ids", () => {
    expect(resolveDeviceId("default", devices)).toBe("default");
    expect(resolveDeviceId("", devices)).toBe("default");
    expect(resolveDeviceId(undefined, devices)).toBe("default");
    expect(resolveDeviceId("id-usb", devices)).toBe("id-usb");
  });

  it("maps a label stored by older prefs to its device id (exact, then case-insensitive)", () => {
    expect(resolveDeviceId("Headset Microphone (USB)", devices)).toBe("id-usb");
    expect(resolveDeviceId("built-in microphone", devices)).toBe("id-builtin");
  });

  it("falls back to the default device when the stored id or label matches nothing", () => {
    expect(resolveDeviceId("Unplugged Mic", devices)).toBe("default");
    expect(resolveDeviceId("id-gone", devices)).toBe("default");
  });

  it("passes the stored value through when nothing is enumerable yet (no permission: blank ids)", () => {
    expect(resolveDeviceId("id-usb", [{ deviceId: "", label: "" }])).toBe("id-usb");
  });

  it("retries with the default device when the chosen one fails with a device error, and only then", async () => {
    const tried: string[] = [];
    const flaky = async (id: string) => {
      tried.push(id);
      if (id !== "default") throw domError("OverconstrainedError");
      return "track";
    };
    await expect(withDeviceFallback("id-usb", flaky)).resolves.toEqual({ deviceId: "default", result: "track" });
    expect(tried).toEqual(["id-usb", "default"]);

    const notFound = async (id: string) => {
      if (id !== "default") throw domError("NotFoundError");
      return id;
    };
    await expect(withDeviceFallback("id-x", notFound)).resolves.toMatchObject({ deviceId: "default" });

    const denied = async () => {
      throw domError("NotAllowedError");
    };
    await expect(withDeviceFallback("id-usb", denied)).rejects.toMatchObject({ name: "NotAllowedError" });
    // The default device failing is final.
    let calls = 0;
    const broken = async () => {
      calls += 1;
      throw domError("NotFoundError");
    };
    await expect(withDeviceFallback("default", broken)).rejects.toMatchObject({ name: "NotFoundError" });
    expect(calls).toBe(1);
    expect(isDeviceFailure(domError("OverconstrainedError"))).toBe(true);
    expect(isDeviceFailure(domError("NotAllowedError"))).toBe(false);
  });
});
