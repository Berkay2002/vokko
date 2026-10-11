import { useEffect, useState } from "react";
import { Link } from "react-router";
import { useStore } from "../api/store";
import { verifyEmail } from "./api";
import { Frame, fieldErrors, tokenFromHash } from "./ui";

/** `/verify#token=...`, opened from the verification mail. Works signed in or out. */
export function VerifyPage() {
  const signedIn = useStore(s => !!s.token);
  const [state, setState] = useState<{ status: "busy" | "done" | "failed"; message?: string }>({ status: "busy" });

  useEffect(() => {
    const token = tokenFromHash(window.location.hash);
    // keep the token out of history once read
    history.replaceState(null, "", window.location.pathname);
    if (!token) {
      setState({ status: "failed", message: "This link is invalid or has expired." });
      return;
    }
    verifyEmail(token).then(
      () => setState({ status: "done" }),
      error => {
        const errors = fieldErrors(error);
        setState({ status: "failed", message: errors.token ?? errors.email ?? errors._ });
      },
    );
  }, []);

  const next = signedIn ? <Link to="/channels/@me">Continue to Vokko</Link> : <Link to="/login">Log in</Link>;
  if (state.status === "busy") return <Frame title="Verifying your email...">{null}</Frame>;
  if (state.status === "done") {
    return (
      <Frame title="Email verified!" subtitle="Thanks, your email address is confirmed." footer={next}>
        {null}
      </Frame>
    );
  }
  return (
    <Frame title="Verification failed" subtitle={state.message} footer={next}>
      {null}
    </Frame>
  );
}
