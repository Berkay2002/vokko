// Discord's "verify your email" notice bar under the title bar: an unverified account on an instance that sends mail.
import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { useStore } from "../api/store";
import { fetchInstance } from "../auth/api";
import { accountStore, loadAccount, resendVerification } from "./api";

/** Dismissed for this page load only, as in Discord. */
let dismissed = false;

export function shouldShowVerifyNotice(o: { mail: boolean; verified: boolean | undefined; dismissed: boolean }): boolean {
  return o.mail && o.verified === false && !o.dismissed;
}

export function VerifyEmailNotice() {
  const token = useStore(s => s.token);
  const info = accountStore(s => s.info);
  const [mail, setMail] = useState(false);
  const [hidden, setHidden] = useState(dismissed);
  const [sent, setSent] = useState<"idle" | "sent" | "failed">("idle");

  useEffect(() => {
    if (!token) return;
    let live = true;
    fetchInstance().then(i => live && setMail(i.email_verification), () => undefined);
    if (!accountStore.getState().info) void loadAccount();
    return () => {
      live = false;
    };
  }, [token]);

  const show = shouldShowVerifyNotice({ mail, verified: info?.verified, dismissed: hidden });
  // The link opens in another tab: coming back here re-checks, so the bar goes away once the address is verified.
  useEffect(() => {
    if (!show) return;
    const recheck = () => void loadAccount();
    window.addEventListener("focus", recheck);
    return () => window.removeEventListener("focus", recheck);
  }, [show]);

  if (!show) return null;
  return (
    <div className="app-notice brand" role="status">
      <span>Please check your email and follow the instructions to verify your account. If you did not receive an email or if it expired,</span>
      {sent === "sent" ? (
        <span>we sent a new one.</span>
      ) : (
        <button type="button" className="app-notice-button" onClick={() => resendVerification().then(() => setSent("sent"), () => setSent("failed"))}>
          {sent === "failed" ? "Couldn't send, try again" : "Resend"}
        </button>
      )}
      <button
        type="button"
        className="app-notice-close"
        aria-label="Dismiss"
        onClick={() => {
          dismissed = true;
          setHidden(true);
        }}
      >
        <X size={18} aria-hidden="true" />
      </button>
    </div>
  );
}
