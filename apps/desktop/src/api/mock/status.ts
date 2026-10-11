// `GET /status`: the optional server status / maintenance notice (a proposal, see docs/api.md "Proposed"). Public, like a health page.
import { route } from "./router";

export interface MockMaintenance {
  message: string;
  starts_at: string | null;
}

let maintenance: MockMaintenance | null = null;

export function setMockMaintenance(next: MockMaintenance | null): void {
  maintenance = next;
}

route("GET", "/status", () => ({ maintenance }));
