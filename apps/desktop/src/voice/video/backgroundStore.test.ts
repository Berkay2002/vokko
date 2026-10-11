import { describe, expect, it } from "vitest";
import { createLibrary, type BackgroundStorage, type StoredBackground } from "./backgroundStore";

const MiB = 1024 * 1024;

function memoryStorage(): BackgroundStorage & { items: Map<string, StoredBackground> } {
  const items = new Map<string, StoredBackground>();
  return {
    items,
    all: async () => [...items.values()].sort((a, b) => a.addedAt - b.addedAt),
    put: async item => void items.set(item.id, item),
    remove: async id => void items.delete(id),
  };
}

/** A stand-in for File/Blob: the library only reads type, size and (optionally) name. */
const fakeFile = (size: number, name?: string, type = "image/png") => ({ size, type, ...(name ? { name } : {}) }) as unknown as File;
/** `prepare` that keeps the picked file as is. */
const keepSize = async (blob: Blob) => blob;
const shrinkTo = (size: number) => async () => ({ size, type: "image/jpeg" }) as unknown as Blob;

describe("createLibrary", () => {
  it("adds and lists an image", async () => {
    const storage = memoryStorage();
    const lib = createLibrary(storage, keepSize);
    const { plan, item } = await lib.add(fakeFile(1 * MiB, "me.png"));
    expect(plan).toEqual({ ok: true });
    expect(item?.name).toBe("me.png");
    expect(item?.size).toBe(1 * MiB);
    const list = await lib.list();
    expect(list.map(i => i.id)).toEqual([item!.id]);
  });

  it("uses the explicit name, then the file name, then a default", async () => {
    const lib = createLibrary(memoryStorage(), keepSize);
    expect((await lib.add(fakeFile(1, "a.png"), "Given")).item?.name).toBe("Given");
    expect((await lib.add(fakeFile(1, "a.png"))).item?.name).toBe("a.png");
    expect((await lib.add(fakeFile(1))).item?.name).toBe("Background");
  });

  it("stores the prepared (scaled) size", async () => {
    const lib = createLibrary(memoryStorage(), shrinkTo(2 * MiB));
    const { item } = await lib.add(fakeFile(9 * MiB));
    expect(item?.size).toBe(2 * MiB);
  });

  it("gives every item a unique id", async () => {
    const lib = createLibrary(memoryStorage(), keepSize);
    const a = (await lib.add(fakeFile(1))).item!;
    const b = (await lib.add(fakeFile(1))).item!;
    expect(a.id).not.toBe(b.id);
  });

  it("removes an item", async () => {
    const lib = createLibrary(memoryStorage(), keepSize);
    const a = (await lib.add(fakeFile(1))).item!;
    const b = (await lib.add(fakeFile(1))).item!;
    await lib.remove(a.id);
    expect((await lib.list()).map(i => i.id)).toEqual([b.id]);
  });

  it("refuses the 11th upload and stores nothing", async () => {
    const storage = memoryStorage();
    const lib = createLibrary(storage, keepSize);
    for (let i = 0; i < 10; i++) expect((await lib.add(fakeFile(1))).plan.ok).toBe(true);
    const r = await lib.add(fakeFile(1));
    expect(r.plan).toEqual({ ok: false, reason: "limit_reached" });
    expect(r.item).toBeUndefined();
    expect(storage.items.size).toBe(10);
    // removing one makes room again
    await lib.remove([...storage.items.keys()][0]);
    expect((await lib.add(fakeFile(1))).plan.ok).toBe(true);
  });

  it("refuses when the total would pass 40 MiB", async () => {
    const storage = memoryStorage();
    const lib = createLibrary(storage, keepSize);
    for (let i = 0; i < 4; i++) expect((await lib.add(fakeFile(10 * MiB))).plan.ok).toBe(true);
    const r = await lib.add(fakeFile(1));
    expect(r.plan).toEqual({ ok: false, reason: "storage_full" });
    expect(storage.items.size).toBe(4);
  });

  it("re-checks the cap against the prepared size", async () => {
    const storage = memoryStorage();
    const seed = createLibrary(storage, keepSize);
    for (let i = 0; i < 3; i++) await seed.add(fakeFile(10 * MiB));
    await seed.add(fakeFile(9 * MiB));
    const lib = createLibrary(storage, shrinkTo(2 * MiB));
    const r = await lib.add(fakeFile(1));
    expect(r.plan).toEqual({ ok: false, reason: "storage_full" });
    expect(storage.items.size).toBe(4);
  });

  it("refuses oversize files and non-images before preparing", async () => {
    let prepared = 0;
    const lib = createLibrary(memoryStorage(), async b => (prepared++, b));
    expect((await lib.add(fakeFile(10 * MiB + 1))).plan).toEqual({ ok: false, reason: "too_large" });
    expect((await lib.add(fakeFile(1, "x.txt", "text/plain"))).plan).toEqual({ ok: false, reason: "not_image" });
    expect(prepared).toBe(0);
  });

  it("check() reports the plan without storing", async () => {
    const storage = memoryStorage();
    const lib = createLibrary(storage, keepSize);
    expect(await lib.check({ type: "image/png", size: 1 })).toEqual({ ok: true });
    expect(storage.items.size).toBe(0);
  });

  it("without storage: empty list, uploads refused, remove is a no-op", async () => {
    const lib = createLibrary(null, keepSize);
    expect(await lib.list()).toEqual([]);
    expect((await lib.add(fakeFile(1))).plan).toEqual({ ok: false, reason: "storage_full" });
    await expect(lib.remove("x")).resolves.toBeUndefined();
  });
});
