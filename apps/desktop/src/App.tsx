import { useEffect } from "react";
import { BrowserRouter, Navigate, Route, Routes, useNavigate } from "react-router";
import { useStore } from "./api/store";
import { ContextMenuHost } from "./ui";
import { AppShell } from "./shell/AppShell";
import { LoginPage, OAuthCallbackPage, RegisterPage, ResetPage, VerifyPage } from "./shell/AuthPages";
import { NotifyBanners, Splash } from "./notify";
import { invitePath, onDeepLink } from "./desktop";
import { InvitePage } from "./shell/InvitePage";
import { pendingInvite } from "./shell/pendingInvite";
import { WindowFrame } from "./shell/WindowControls";

function Protected() {
  const token = useStore(s => s.token);
  const ready = useStore(s => s.ready);
  if (!token) return <Navigate to="/login" replace />;
  if (!ready) return <Splash />;
  return <AppShell />;
}

function Guest({ children }: { children: React.ReactNode }) {
  const token = useStore(s => s.token);
  if (token) {
    const invite = pendingInvite.get();
    return <Navigate to={invite ? `/invite/${invite}` : "/channels/@me"} replace />;
  }
  return <>{children}</>;
}

/** `vokko://invite/<code>` links from the desktop shell open the invite page. Auth links stay queued for the sign-in code. */
function DeepLinks() {
  const navigate = useNavigate();
  useEffect(
    () =>
      onDeepLink(
        link => {
          if (link.kind === "invite") void navigate(invitePath(link.code));
        },
        { kinds: ["invite"] },
      ),
    [navigate],
  );
  return null;
}

export function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<Guest><LoginPage /></Guest>} />
        <Route path="/register" element={<Guest><RegisterPage /></Guest>} />
        <Route path="/verify" element={<VerifyPage />} />
        <Route path="/reset" element={<ResetPage />} />
        <Route path="/oauth/callback" element={<OAuthCallbackPage />} />
        <Route path="/invite/:code" element={<InvitePage />} />
        <Route path="/channels/:guildId" element={<Protected />} />
        <Route path="/channels/:guildId/:channelId" element={<Protected />} />
        <Route path="*" element={<Navigate to="/channels/@me" replace />} />
      </Routes>
      <ContextMenuHost />
      <WindowFrame />
      <NotifyBanners />
      <DeepLinks />
    </BrowserRouter>
  );
}
