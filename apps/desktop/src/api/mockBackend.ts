// The in-memory mock backend (./mock: router, seed data, gateway socket) is loaded on demand, so builds that talk to a real server
// never download it. main.tsx awaits it before bootstrap in mock mode; the gateway needs it synchronously after that.

type MockModule = typeof import("./mock");

let loaded: MockModule | null = null;
let loading: Promise<MockModule> | null = null;

export function loadMockBackend(): Promise<MockModule> {
  loading ??= import("./mock").then(mod => (loaded = mod));
  return loading;
}

/** The backend if it has loaded (always, after main.tsx's startup await), else null. Lets callers skip an extra await. */
export function loadedMockBackend(): MockModule | null {
  return loaded;
}

export function mockBackend(): MockModule {
  if (!loaded) throw new Error("mock backend not loaded yet (main.tsx loads it before bootstrap)");
  return loaded;
}
