// Uploaded video backgrounds, kept on this device in IndexedDB (database "vokko-video", store "backgrounds") under the caps in
// ./backgrounds.ts. The storage is injectable so the cap behaviour is unit-tested without IndexedDB.

import { create } from "zustand";
import { BACKGROUND_LIMITS, UPLOAD_REFUSAL, fitScale, planUpload, type UploadPlan } from "./backgrounds";

export interface StoredBackground {
  id: string;
  name: string;
  size: number;
  addedAt: number;
  blob: Blob;
}

export interface BackgroundStorage {
  all(): Promise<StoredBackground[]>;
  put(item: StoredBackground): Promise<void>;
  remove(id: string): Promise<void>;
}

const DB_NAME = "vokko-video";
const STORE = "backgrounds";

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: "id" });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export function indexedDbStorage(): BackgroundStorage | null {
  if (typeof indexedDB === "undefined") return null;
  const run = async <T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> => {
    const db = await open();
    try {
      return await request(fn(db.transaction(STORE, mode).objectStore(STORE)));
    } finally {
      db.close();
    }
  };
  return {
    all: async () => ((await run("readonly", s => s.getAll())) as StoredBackground[]).sort((a, b) => a.addedAt - b.addedAt),
    put: async item => void (await run("readwrite", s => s.put(item))),
    remove: async id => void (await run("readwrite", s => s.delete(id))),
  };
}

export interface BackgroundLibrary {
  list(): Promise<StoredBackground[]>;
  add(file: File | Blob, name?: string): Promise<{ plan: UploadPlan; item?: StoredBackground }>;
  remove(id: string): Promise<void>;
  /** Pure cap check, exposed for the picker (disables the upload button when full). */
  check(file: { type: string; size: number }): Promise<UploadPlan>;
}

/** Scales a picked image down to the stored edge length and re-encodes it as JPEG (transparency is flattened); the original is kept when that is not smaller. */
async function downscale(blob: Blob): Promise<Blob> {
  if (typeof createImageBitmap === "undefined" || typeof document === "undefined") return blob;
  try {
    const bitmap = await createImageBitmap(blob);
    const scale = fitScale(bitmap.width, bitmap.height);
    if (scale === 1 && blob.size <= BACKGROUND_LIMITS.maxFileBytes / 2) {
      bitmap.close();
      return blob;
    }
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    canvas.getContext("2d")?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    const out = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, "image/jpeg", 0.88));
    return out && out.size < blob.size ? out : blob;
  } catch {
    return blob;
  }
}

let counter = 0;
const newId = () => `${Date.now().toString(36)}${(counter++).toString(36)}`;

export function createLibrary(storage: BackgroundStorage | null, prepare: (blob: Blob) => Promise<Blob> = downscale): BackgroundLibrary {
  const sizes = async () => (storage ? (await storage.all()).map(({ id, size }) => ({ id, size })) : []);
  return {
    list: async () => (storage ? storage.all() : []),
    check: async file => planUpload(await sizes(), file),
    add: async (file, name) => {
      if (!storage) return { plan: { ok: false, reason: "storage_full" } };
      const first = planUpload(await sizes(), file);
      if (!first.ok) return { plan: first };
      const blob = await prepare(file);
      const plan = planUpload(await sizes(), file, blob.size);
      if (!plan.ok) return { plan };
      const item: StoredBackground = { id: newId(), name: name ?? ("name" in file ? String(file.name) : "Background"), size: blob.size, addedAt: Date.now(), blob };
      await storage.put(item);
      return { plan, item };
    },
    remove: async id => {
      await storage?.remove(id);
    },
  };
}

export const backgroundLibrary: BackgroundLibrary = createLibrary(indexedDbStorage());

// ---- UI state: the list, plus blob URLs that live as long as the item does ----

interface LibraryState {
  items: (StoredBackground & { url: string })[];
  loaded: boolean;
  error: string | null;
  load(): Promise<void>;
  add(file: File): Promise<StoredBackground | null>;
  remove(id: string): Promise<void>;
}

function withUrl(item: StoredBackground): StoredBackground & { url: string } {
  return { ...item, url: URL.createObjectURL(item.blob) };
}

export const useBackgrounds = create<LibraryState>((set, get) => ({
  items: [],
  loaded: false,
  error: null,
  async load() {
    if (get().loaded) return;
    try {
      const list = await backgroundLibrary.list();
      set({ items: list.map(withUrl), loaded: true });
    } catch {
      set({ loaded: true });
    }
  },
  async add(file) {
    const { plan, item } = await backgroundLibrary.add(file);
    if (!plan.ok || !item) {
      set({ error: plan.ok ? "Could not save that image." : UPLOAD_REFUSAL[plan.reason] });
      return null;
    }
    set(state => ({ items: [...state.items, withUrl(item)], error: null }));
    return item;
  },
  async remove(id) {
    await backgroundLibrary.remove(id);
    set(state => {
      const gone = state.items.find(i => i.id === id);
      if (gone) URL.revokeObjectURL(gone.url);
      return { items: state.items.filter(i => i.id !== id) };
    });
  },
}));
