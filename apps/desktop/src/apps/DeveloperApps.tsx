// User Settings > Developer: your applications. Create one (its bot token is shown once), reset the token (shown once again),
// copy the invite URL, make the bot private, delete it.
import { useCallback, useEffect, useRef, useState } from "react";
import { Copy, KeyRound, Link2, Plus, Trash2 } from "lucide-react";
import { ApiRequestError } from "../api/errors";
import type { Application } from "../api/types";
import { Modal } from "../ui";
import { Category, SwitchRow } from "../shell/settings/controls";
import { createApplication, deleteApplication, editApplication, inviteUrl, listApplications, resetBotToken } from "./api";
import { AppIcon } from "./AppIcon";
import "./apps.css";

function errorText(error: unknown): string {
  return error instanceof ApiRequestError ? error.message : "Something went wrong. Try again.";
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  return (
    <button
      type="button"
      className="btn btn-secondary btn-sm"
      onClick={() => {
        void navigator.clipboard?.writeText(text);
        setCopied(true);
        window.clearTimeout(timer.current);
        timer.current = window.setTimeout(() => setCopied(false), 1500);
      }}
    >
      {label.startsWith("Copy Invite") ? <Link2 size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />} {copied ? "Copied!" : label}
    </button>
  );
}

/** The bot token, once: it cannot be read again later, only reset. */
function TokenDialog({ token, onClose }: { token: string | null; onClose(): void }) {
  return (
    <Modal
      open={!!token}
      onClose={onClose}
      persistent
      title="Your bot token"
      footer={
        <button type="button" className="btn" onClick={onClose}>
          Done
        </button>
      }
    >
      <p>Copy it now: for your security it will not be shown again. Anyone with this token can act as your bot; reset it if it leaks.</p>
      <div className="apps-token">
        <code data-testid="bot-token">{token}</code>
        {token && <CopyButton text={token} label="Copy" />}
      </div>
    </Modal>
  );
}

function AppCard({ app, onChanged, onToken }: { app: Application; onChanged(): void; onToken(token: string): void }) {
  const [confirm, setConfirm] = useState<"reset" | "delete" | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      setConfirm(null);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <li className="apps-card open" data-application-id={app.id}>
      <div className="apps-card-head static">
        <AppIcon name={app.name} icon={app.icon} size={40} />
        <span className="apps-card-title">
          <span className="apps-card-name">
            {app.name} <span className="chat-bot-tag apps-tag">APP</span>
          </span>
          <span className="apps-card-sub">
            @{app.bot.username} · ID {app.id}
          </span>
        </span>
      </div>
      <div className="apps-card-body">
        <SwitchRow
          label="Public Bot"
          note="Anyone with the invite link can add it to servers they manage. Off: only you can."
          checked={app.bot_public}
          disabled={busy}
          onChange={next => void run(async () => { await editApplication(app.id, { bot_public: next }); onChanged(); })}
        />
        {error && <p className="field-error">{error}</p>}
        <div className="apps-card-actions">
          <CopyButton text={inviteUrl(app)} label="Copy Invite URL" />
          <CopyButton text={app.id} label="Copy Application ID" />
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => setConfirm("reset")}>
            <KeyRound size={14} aria-hidden="true" /> Reset Token
          </button>
          <button type="button" className="btn-link apps-danger-link" onClick={() => setConfirm("delete")}>
            <Trash2 size={14} aria-hidden="true" /> Delete App
          </button>
        </div>
      </div>
      <Modal
        open={confirm !== null}
        onClose={() => setConfirm(null)}
        title={confirm === "reset" ? "Reset bot token?" : `Delete ${app.name}?`}
        footer={
          <>
            <button type="button" className="btn btn-secondary" onClick={() => setConfirm(null)}>
              Cancel
            </button>
            <button
              type="button"
              className="btn btn-danger"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  if (confirm === "reset") onToken((await resetBotToken(app.id)).token);
                  else await deleteApplication(app.id);
                  onChanged();
                })
              }
            >
              {confirm === "reset" ? "Yes, reset" : "Delete"}
            </button>
          </>
        }
      >
        <p>{confirm === "reset" ? "The current token stops working at once and the bot is disconnected until it uses the new one." : "The bot leaves every server and its commands and token are deleted. Its old messages stay."}</p>
      </Modal>
    </li>
  );
}

export function DeveloperApps() {
  const [apps, setApps] = useState<Application[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [token, setToken] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setApps(await listApplications());
      setError(null);
    } catch (e) {
      setError(errorText(e));
      setApps(current => current ?? []);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const created = await createApplication(name.trim());
      setCreating(false);
      setName("");
      setToken(created.token);
      await load();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Category title="Applications">
      <p className="settings-todo">Apps own a bot user. Bots answer slash commands and can be added to servers with their invite link.</p>
      <div className="apps-toolbar">
        <button type="button" className="btn btn-sm" onClick={() => setCreating(true)}>
          <Plus size={14} aria-hidden="true" /> New Application
        </button>
      </div>
      {error && !creating && <p className="field-error">{error}</p>}
      {apps === null && <p className="settings-todo">Loading…</p>}
      {apps !== null && apps.length === 0 && <p className="settings-todo">You have no applications yet.</p>}
      {apps !== null && apps.length > 0 && (
        <ul className="apps-card-list" aria-label="Your applications">
          {apps.map(app => (
            <AppCard key={app.id} app={app} onChanged={() => void load()} onToken={setToken} />
          ))}
        </ul>
      )}
      <Modal
        open={creating}
        onClose={() => setCreating(false)}
        title="Create an application"
        footer={
          <>
            <button type="button" className="btn btn-secondary" onClick={() => setCreating(false)}>
              Cancel
            </button>
            <button type="button" className="btn" disabled={busy || name.trim().length < 2} onClick={() => void create()}>
              Create
            </button>
          </>
        }
      >
        <label className="field-label" htmlFor="new-app-name">
          Name
        </label>
        <input
          id="new-app-name"
          className="input"
          value={name}
          maxLength={32}
          autoFocus
          onChange={e => setName(e.target.value)}
          onKeyDown={e => {
            if (e.key === "Enter" && name.trim().length >= 2) void create();
          }}
        />
        {error && <p className="field-error">{error}</p>}
      </Modal>
      <TokenDialog token={token} onClose={() => setToken(null)} />
    </Category>
  );
}
