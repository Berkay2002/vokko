// An invite code opened while signed out, kept for the length of the tab so login/register can send the user back to it.

const KEY = "vokko.pendingInvite";

export const pendingInvite = {
  get(): string | null {
    try {
      return sessionStorage.getItem(KEY);
    } catch {
      return null;
    }
  },
  set(code: string): void {
    try {
      sessionStorage.setItem(KEY, code);
    } catch {
      /* private mode: the link has to be opened again after signing in */
    }
  },
  clear(): void {
    try {
      sessionStorage.removeItem(KEY);
    } catch {
      /* nothing stored */
    }
  },
};
