import { useEffect, useRef, useState } from "react";
import { Check, Copy, RefreshCw, X } from "lucide-react";
import { useStore } from "../api/store";
import type { GuildTemplate } from "../api/types";
import { templatePath } from "../desktop";
import { closeModal } from "../shell/modalStore";
import { go } from "../shell/nav";
import { Modal } from "../ui";
import { Category, Field, Page, Unavailable } from "../shell/settings/controls";
import { SaveBar } from "../shell/settings/SaveBar";
import { errorText } from "../shell/settings/shared";
import { createTemplate, deleteTemplate, guildTemplates, syncTemplate, templateLink, updateTemplate } from "./api";
import "./templates.css";

const COPIES = ["Channels and channel topics", "Roles and permissions", "Default server settings"];
const SKIPS = ["Messages or any content", "Members or bots", "Your server icon, emoji or stickers"];

/** Server Settings > Server Template: Discord's generate / copy / sync / preview / delete page for the guild's one template. */
export function TemplateSettingsPage({ guildId, canEdit }: { guildId: string; canEdit: boolean }) {
  const [template, setTemplate] = useState<GuildTemplate | null | undefined>(undefined);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const templateRef = useRef(template);
  templateRef.current = template;

  const show = (next: GuildTemplate | null) => {
    setTemplate(next);
    setName(next?.name ?? "");
    setDescription(next?.description ?? "");
  };

  // Reloaded when the guild or its channels change, so "unsynced changes" shows up while the page is open.
  const guild = useStore(s => s.guilds[guildId]);
  const channels = useStore(s => s.channels);
  useEffect(() => {
    let live = true;
    guildTemplates(guildId).then(
      list => {
        if (!live) return;
        const next = list[0] ?? null;
        setTemplate(next);
        if (!next) return;
        // Keep a title or description being edited.
        setName(name => (templateRef.current && name !== templateRef.current.name ? name : next.name));
        setDescription(text => (templateRef.current && text !== (templateRef.current.description ?? "") ? text : (next.description ?? "")));
      },
      failure => live && (setError(errorText(failure)), setTemplate(null)),
    );
    return () => {
      live = false;
    };
  }, [guildId, guild, channels]);

  const run = async (action: () => Promise<GuildTemplate | null>) => {
    setBusy(true);
    setError(null);
    try {
      show(await action());
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setBusy(false);
    }
  };

  const dirtyForm = !!template && (name !== template.name || description !== (template.description ?? ""));
  const link = template ? templateLink(template.code) : "";

  return (
    <Page title="Server Template">
      {!canEdit && <Unavailable>You need the Manage Server permission to manage the server template.</Unavailable>}
      <p className="tpl-intro">
        Templates are an easy way to share your server setup and help anyone create a server instantly. When someone uses your server template link, they create a new server pre-filled with the same channels, roles, permissions and settings as yours.
      </p>
      <div className="tpl-copies">
        <div>
          <div className="tpl-copies-title">Templates will copy:</div>
          <ul>
            {COPIES.map(item => (
              <li key={item}>
                <Check size={16} className="tpl-yes" aria-hidden="true" />
                {item}
              </li>
            ))}
          </ul>
        </div>
        <div>
          <div className="tpl-copies-title">Templates will not copy:</div>
          <ul>
            {SKIPS.map(item => (
              <li key={item}>
                <X size={16} className="tpl-no" aria-hidden="true" />
                {item}
              </li>
            ))}
          </ul>
        </div>
      </div>
      {template === undefined ? (
        <div className="tpl-loading" aria-busy="true" />
      ) : (
        <Category title={template ? "Template Settings" : "Create Template"}>
          <Field label="Template Title">
            <input className="input" aria-label="Template Title" value={name} maxLength={100} disabled={!canEdit || busy} placeholder="Who is this server for? E.g. School Club, Artists' Community" onChange={e => setName(e.target.value)} />
          </Field>
          <Field label="Template Description">
            <textarea className="input tpl-description" aria-label="Template Description" value={description} maxLength={120} rows={3} disabled={!canEdit || busy} placeholder="What can people do in this server?" onChange={e => setDescription(e.target.value)} />
          </Field>
          {!template && (
            <>
              {error && <p className="field-error">{error}</p>}
              <button type="button" className="btn btn-primary" disabled={!canEdit || busy || !name.trim()} onClick={() => void run(() => createTemplate(guildId, name.trim(), description.trim()))}>
                Generate Template
              </button>
            </>
          )}
          {template && (
            <>
              <Field label="Template Link">
                <div className="copy-field">
                  <input className="input" readOnly aria-label="Template link" value={link} onFocus={e => e.currentTarget.select()} />
                  <button
                    type="button"
                    className={`btn ${copied ? "btn-success" : "btn-primary"}`}
                    onClick={() => {
                      void navigator.clipboard?.writeText(link);
                      setCopied(true);
                      setTimeout(() => setCopied(false), 1500);
                    }}
                  >
                    {copied ? <Check size={16} /> : <Copy size={16} />} {copied ? "Copied" : "Copy"}
                  </button>
                </div>
              </Field>
              {template.is_dirty && (
                <div className="tpl-unsynced" role="status">
                  <span>
                    <strong>This template has unsynced changes.</strong> Changes made to the server since the template was last synced are not part of it yet.
                  </span>
                  <button type="button" className="btn btn-primary btn-sm" disabled={!canEdit || busy} onClick={() => void run(() => syncTemplate(guildId, template.code))}>
                    <RefreshCw size={14} aria-hidden="true" /> Sync Template
                  </button>
                </div>
              )}
              <p className="settings-field-note">
                Used {template.usage_count} {template.usage_count === 1 ? "time" : "times"}. Last synced {new Date(template.updated_at).toLocaleString()}.
              </p>
              {error && !dirtyForm && <p className="field-error">{error}</p>}
              <div className="tpl-actions">
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => {
                    closeModal();
                    go(templatePath(template.code));
                  }}
                >
                  Preview Template
                </button>
                <button type="button" className="btn btn-danger" disabled={!canEdit || busy} onClick={() => setConfirmDelete(true)}>
                  Delete Template
                </button>
              </div>
            </>
          )}
        </Category>
      )}
      <SaveBar
        visible={canEdit && dirtyForm}
        busy={busy}
        error={dirtyForm ? error : null}
        saveDisabled={!name.trim()}
        onReset={() => template && show(template)}
        onSave={() => template && void run(() => updateTemplate(guildId, template.code, name.trim(), description.trim()))}
      />
      <Modal
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        title="Delete Template"
        footer={
          <>
            <button type="button" className="btn btn-link" onClick={() => setConfirmDelete(false)}>
              Cancel
            </button>
            <button
              type="button"
              className="btn btn-danger"
              disabled={busy}
              onClick={() => {
                setConfirmDelete(false);
                if (template) void run(() => deleteTemplate(guildId, template.code).then(() => null));
              }}
            >
              Delete Template
            </button>
          </>
        }
      >
        <p className="modal-text">Are you sure you want to delete this template? The link will stop working for everyone. This can't be undone.</p>
      </Modal>
    </Page>
  );
}
