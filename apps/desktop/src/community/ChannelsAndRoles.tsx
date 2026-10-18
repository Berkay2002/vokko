import { useEffect, useState } from "react";
import { ListFilter } from "lucide-react";
import type { GuildOnboarding, OnboardingResponses, OnboardingCompletion, Snowflake } from "../api/types";
import { closeCommunityModal, useCommunityModal } from "./communityModals";
import { errorText } from "./errors";
import { loadOnboardingConfig, hasChannelsAndRoles, useOnboardingConfigs } from "./onboardingConfig";
import { answerIds, needsOnboarding, toggleAnswer } from "./onboardingLogic";
import { PromptStep, resumeOnboarding } from "./OnboardingFlow";
import { appStore, Modal, request, useStore } from "./shell";

/** The "Channels & Roles" row at the top of the channel list: the member's answers, changed after joining. Members still in the flow go back to it. */
export function ChannelsAndRolesLink({ guildId }: { guildId: Snowflake }) {
  const config = useOnboardingConfigs(s => s[guildId]);
  const flags = useStore(s => (s.me ? s.members[guildId]?.[s.me.id]?.flags : undefined));
  useEffect(() => {
    void loadOnboardingConfig(guildId).catch(() => undefined);
  }, [guildId]);
  if (!hasChannelsAndRoles(config)) return null;
  const open = () => (needsOnboarding({ flags }) ? resumeOnboarding(guildId) : useCommunityModal.getState().open({ type: "channelsAndRoles", guildId }));
  return (
    <button type="button" className="cm-quicklink" aria-haspopup="dialog" onClick={open}>
      <ListFilter size={20} aria-hidden="true" />
      <span className="cm-quicklink-label">Channels &amp; Roles</span>
    </button>
  );
}

/** Every question of the guild with the member's current answers; Save replaces them (roles follow, as in onboarding). */
export function ChannelsAndRolesModal({ guildId }: { guildId: Snowflake }) {
  const [config, setConfig] = useState<GuildOnboarding | null>(null);
  const [answers, setAnswers] = useState<Set<Snowflake>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    Promise.all([loadOnboardingConfig(guildId), request<OnboardingResponses>("GET", `/guilds/${guildId}/onboarding-responses`)])
      .then(([loaded, mine]) => {
        if (!live) return;
        setConfig(loaded);
        setAnswers(new Set(mine.option_ids));
      })
      .catch(e => live && setError(errorText(e)));
    return () => {
      live = false;
    };
  }, [guildId]);

  const prompts = config?.prompts.filter(prompt => prompt.options.length > 0) ?? [];
  const missing = prompts.some(prompt => prompt.required && prompt.in_onboarding && !prompt.options.some(option => answers.has(option.id)));

  const save = async () => {
    if (!config) return;
    setBusy(true);
    setError(null);
    try {
      // A member here has finished onboarding, so the rules (if any) are accepted already.
      const done = await request<OnboardingCompletion>("PUT", `/guilds/${guildId}/onboarding-responses`, {
        option_ids: answerIds(config, answers),
        ...(config.rules ? { rules_accepted: true } : {}),
      });
      const state = appStore.getState();
      const known = state.members[guildId] ?? {};
      appStore.setState({ members: { ...state.members, [guildId]: { ...known, [done.member.user.id]: { ...known[done.member.user.id], ...done.member } } } });
      closeCommunityModal();
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      onClose={closeCommunityModal}
      title="Channels & Roles"
      className="modal-medium cm-modal cm-onboarding"
      footer={
        <>
          <button type="button" className="btn btn-link footer-back" disabled={busy} onClick={closeCommunityModal}>
            Cancel
          </button>
          <button type="button" className="btn" disabled={busy || !config || missing} onClick={() => void save()}>
            Save
          </button>
        </>
      }
    >
      <div className="cm-onboarding-body">
        {!config && !error && <p className="cm-empty">Loading…</p>}
        {prompts.map(prompt => (
          <section key={prompt.id} className="cm-chroles-prompt">
            <h3 className="cm-chroles-title">{prompt.title}</h3>
            <PromptStep prompt={prompt} answers={answers} onToggle={id => setAnswers(current => toggleAnswer(prompt, current, id))} />
          </section>
        ))}
        {error && (
          <p className="field-error" role="alert">
            {error}
          </p>
        )}
      </div>
    </Modal>
  );
}
