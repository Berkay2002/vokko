// The pop-out has no login, so its viewer Room's token comes from the main window: ask over the app events, match the reply by id, give up
// after TOKEN_TIMEOUT_MS (a main window that is gone must not leave the Room's retry loop waiting forever).

import { emit, listen } from "@tauri-apps/api/event";
import { ACTION_EVENT, TOKEN_EVENT, type TokenReply } from "./protocol";

export const TOKEN_TIMEOUT_MS = 10_000;

let counter = 0;

export function requestToken(): Promise<{ url: string; token: string }> {
  const id = (counter += 1);
  return new Promise((resolve, reject) => {
    let settled = false;
    let stop: (() => void) | undefined;
    const finish = (done: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stop?.();
      done();
    };
    const timer = setTimeout(() => finish(() => reject(new Error("The main window did not answer."))), TOKEN_TIMEOUT_MS);
    // Listen first, ask second: the answer can be quicker than the listener's registration.
    listen<TokenReply>(TOKEN_EVENT, event => {
      const reply = event.payload;
      if (reply.id !== id) return;
      finish(() => ("error" in reply ? reject(new Error(reply.error)) : resolve({ url: reply.url, token: reply.token })));
    })
      .then(fn => {
        stop = fn;
        if (settled) fn();
        else void emit(ACTION_EVENT, { type: "token", id });
      })
      .catch((error: unknown) => finish(() => reject(error)));
  });
}
