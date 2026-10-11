import { BrowserRouter, Navigate, Route, Routes } from "react-router";
import { useStore } from "./api/store";
import { ContextMenuHost } from "./ui";
import { AppShell } from "./shell/AppShell";
import { LoginPage, RegisterPage } from "./shell/AuthPages";

function Splash() {
  return (
    <div className="splash" role="status" aria-label="Loading">
      <div className="splash-dots">
        <span />
        <span />
        <span />
      </div>
    </div>
  );
}

function Protected() {
  const token = useStore(s => s.token);
  const ready = useStore(s => s.ready);
  if (!token) return <Navigate to="/login" replace />;
  if (!ready) return <Splash />;
  return <AppShell />;
}

function Guest({ children }: { children: React.ReactNode }) {
  const token = useStore(s => s.token);
  if (token) return <Navigate to="/channels/@me" replace />;
  return <>{children}</>;
}

export function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<Guest><LoginPage /></Guest>} />
        <Route path="/register" element={<Guest><RegisterPage /></Guest>} />
        <Route path="/channels/:guildId" element={<Protected />} />
        <Route path="/channels/:guildId/:channelId" element={<Protected />} />
        <Route path="*" element={<Navigate to="/channels/@me" replace />} />
      </Routes>
      <ContextMenuHost />
    </BrowserRouter>
  );
}
