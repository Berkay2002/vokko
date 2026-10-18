import { useEffect, useMemo, useRef, useState } from "react";
import { ImagePlus, MapPin, Mic, Radio, X } from "lucide-react";
import { ChannelType, ScheduledEventEntityType, ScheduledEventStatus, type CreateScheduledEventRequest, type EditScheduledEventRequest, type GuildScheduledEvent, type Snowflake } from "../api/types";
import { closeCommunityModal, openEventDetail, openEvents } from "./communityModals";
import { errorText } from "./errors";
import {
  DESCRIPTION_MAX,
  LOCATION_MAX,
  NAME_MAX,
  REPEAT_LABELS,
  formatEventRange,
  fromInputs,
  hasErrors,
  nextHour,
  repeatToRule,
  ruleToRepeat,
  toDateInput,
  toTimeInput,
  validateEventForm,
  type EventForm,
  type RepeatChoice,
} from "./eventUtil";
import { Modal, request, resolveUrl, uploadAttachment, useChatLocale, useStore } from "./shell";
import { createEvent, editEvent } from "./store";
import { pickUploadChannel } from "./uploadChannel";
import type { Attachment } from "../api/types";

type Step = 0 | 1 | 2;
const STEPS = ["Location", "Event Info", "Review"] as const;
const IMAGE_TYPES = "image/png,image/jpeg,image/gif,image/webp";

function initialForm(event: GuildScheduledEvent | undefined, firstVoice: string): EventForm {
  if (!event) {
    const start = nextHour();
    const end = new Date(start.getTime() + 60 * 60 * 1000);
    return {
      name: "",
      description: "",
      entityType: ScheduledEventEntityType.Voice,
      channelId: firstVoice,
      location: "",
      startDate: toDateInput(start),
      startTime: toTimeInput(start),
      endDate: toDateInput(end),
      endTime: toTimeInput(end),
      repeat: "none",
    };
  }
  const start = new Date(event.scheduled_start_time);
  const end = event.scheduled_end_time ? new Date(event.scheduled_end_time) : null;
  return {
    name: event.name,
    description: event.description ?? "",
    entityType: event.entity_type,
    channelId: event.channel_id ?? "",
    location: event.entity_metadata?.location ?? "",
    startDate: toDateInput(start),
    startTime: toTimeInput(start),
    endDate: end ? toDateInput(end) : "",
    endTime: end ? toTimeInput(end) : "",
    repeat: ruleToRepeat(event.recurrence_rule) ?? "keep",
  };
}

const LOCATIONS: { type: ScheduledEventEntityType; label: string; hint: string; icon: typeof Mic }[] = [
  { type: ScheduledEventEntityType.StageInstance, label: "Stage Channel", hint: "Host a talk or Q&A with your community.", icon: Radio },
  { type: ScheduledEventEntityType.Voice, label: "Voice Channel", hint: "Hang out together with voice.", icon: Mic },
  { type: ScheduledEventEntityType.External, label: "Somewhere Else", hint: "Text channel, external link or in-person location.", icon: MapPin },
];

/** Create-event wizard (location, info, review); with `eventId` it edits that event instead. */
export function EventWizard({ guildId, eventId, from }: { guildId: Snowflake; eventId?: Snowflake; from?: "events" | "detail" }) {
  const existing = useStore(s => s.channels);
  // Voice events take voice channels, stage events stage channels (the server checks the same).
  const rooms = useMemo(() => {
    const of = (type: ChannelType) =>
      Object.values(existing)
        .filter(c => c.guild_id === guildId && c.type === type)
        .sort((a, b) => a.position - b.position)
        .map(c => c.id);
    return { voice: of(ChannelType.GuildVoice), stage: of(ChannelType.GuildStage) };
  }, [existing, guildId]);
  const guild = useStore(s => s.guilds[guildId]);
  const meId = useStore(s => s.me?.id);
  const myMember = useStore(s => (meId ? s.members[guildId]?.[meId] : undefined));
  const uploadChannel = useMemo(
    () => (guild && meId ? pickUploadChannel(guild, { id: meId, roles: myMember?.roles ?? [], communication_disabled_until: myMember?.communication_disabled_until }, Object.values(existing)) : undefined),
    [guild, meId, myMember, existing],
  );
  const [event, setEvent] = useState<GuildScheduledEvent | undefined>(undefined);
  const [ready, setReady] = useState(!eventId);
  useEffect(() => {
    if (!eventId) return;
    let live = true;
    request<GuildScheduledEvent>("GET", `/guilds/${guildId}/scheduled-events/${eventId}`)
      .then(loaded => {
        if (!live) return;
        setEvent(loaded);
        setReady(true);
      })
      .catch(() => live && closeCommunityModal());
    return () => {
      live = false;
    };
  }, [guildId, eventId]);
  if (!ready) return <Modal open onClose={closeCommunityModal} title="Edit Event"><p className="cm-empty">Loading…</p></Modal>;
  return <WizardBody key={event?.id ?? "new"} guildId={guildId} event={event} rooms={rooms} uploadChannel={uploadChannel} from={from} />;
}

function WizardBody({ guildId, event, rooms, uploadChannel, from }: { guildId: Snowflake; event: GuildScheduledEvent | undefined; rooms: { voice: Snowflake[]; stage: Snowflake[] }; uploadChannel: Snowflake | undefined; from?: "events" | "detail" }) {
  const editing = !!event;
  const active = event?.status === ScheduledEventStatus.Active;
  const channels = useStore(s => s.channels);
  const [form, setForm] = useState<EventForm>(() => initialForm(event, rooms.voice[0] ?? ""));
  const stage = form.entityType === ScheduledEventEntityType.StageInstance;
  const channelIds = stage ? rooms.stage : rooms.voice;
  const [step, setStep] = useState<Step>(editing ? 1 : 0);
  // A running event keeps its place: the location step is only for events that have not started.
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cover, setCover] = useState<{ file: File; preview: string } | null>(null);
  const [removeCover, setRemoveCover] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  useEffect(() => () => void (cover && URL.revokeObjectURL(cover.preview)), [cover]);

  const patch = (change: Partial<EventForm>) => setForm(f => ({ ...f, ...change }));
  // An event whose voice channel was deleted can be edited as it is; picking another entity or channel is what needs a channel.
  const orphaned = !!event && event.entity_type !== ScheduledEventEntityType.External && !event.channel_id && form.entityType === event.entity_type;
  const errors = validateEventForm(form, new Date(), editing, orphaned);
  const external = form.entityType === ScheduledEventEntityType.External;
  const coverUrl = cover?.preview ?? (!removeCover && event?.image ? resolveUrl(event.image) : null);
  const back = () => {
    if (from === "detail" && event) openEventDetail(guildId, event.id);
    else if (from === "events") openEvents(guildId);
    else closeCommunityModal();
  };

  // Which step shows a problem: the first step with an error is where Next stops.
  const stepErrors = (s: Step): boolean => {
    if (s === 0) return !!(errors.channelId || errors.location);
    if (s === 1) return !!(errors.name || errors.description || errors.start || errors.end);
    return false;
  };
  const next = () => {
    setTouched(true);
    if (stepErrors(step)) return;
    setTouched(false);
    setStep(s => Math.min(2, s + 1) as Step);
  };

  const submit = async () => {
    setTouched(true);
    if (hasErrors(errors)) {
      setStep(stepErrors(0) ? 0 : 1);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      let imageId: string | null | undefined;
      if (cover) {
        if (!uploadChannel) throw new Error("There's no channel you may upload files in, so the cover can't be added.");
        const attachment: Attachment = await uploadAttachment(uploadChannel, cover.file);
        imageId = attachment.id;
      } else if (removeCover && event?.image) {
        imageId = null;
      }
      const start = fromInputs(form.startDate, form.startTime)!;
      const end = fromInputs(form.endDate, form.endTime);
      const rule = form.repeat === "keep" ? event?.recurrence_rule ?? null : repeatToRule(form.repeat as RepeatChoice, start);
      const common = {
        name: form.name.trim(),
        description: form.description.trim() === "" ? null : form.description.trim(),
        scheduled_end_time: end ? end.toISOString() : null,
        ...(imageId !== undefined ? { image_attachment_id: imageId } : {}),
      };
      let saved: GuildScheduledEvent;
      if (event) {
        const entityChanged = form.entityType !== event.entity_type || (!external && form.channelId !== (event.channel_id ?? ""));
        const body: EditScheduledEventRequest = active
          ? common
          : {
              ...common,
              // Only what changed: sending the entity again would count as picking one.
              ...(entityChanged ? { entity_type: form.entityType, channel_id: external ? null : form.channelId, entity_metadata: external ? { location: form.location.trim() } : null } : {}),
              ...(external && !entityChanged && form.location.trim() !== (event.entity_metadata?.location ?? "") ? { entity_metadata: { location: form.location.trim() } } : {}),
              ...(start.getTime() !== Date.parse(event.scheduled_start_time) ? { scheduled_start_time: start.toISOString() } : {}),
              ...(form.repeat !== "keep" && JSON.stringify(rule) !== JSON.stringify(event.recurrence_rule) ? { recurrence_rule: rule } : {}),
            };
        saved = await editEvent(guildId, event.id, body);
      } else {
        const body: CreateScheduledEventRequest = {
          name: common.name,
          description: common.description,
          entity_type: form.entityType,
          scheduled_start_time: start.toISOString(),
          ...(external ? { entity_metadata: { location: form.location.trim() } } : { channel_id: form.channelId }),
          ...(end ? { scheduled_end_time: end.toISOString() } : {}),
          ...(imageId ? { image_attachment_id: imageId } : {}),
          ...(rule ? { recurrence_rule: rule } : {}),
        };
        saved = await createEvent(guildId, body);
      }
      openEventDetail(guildId, saved.id, from === "events" ? "events" : undefined);
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  };

  const channelName = (id: string) => channels[id]?.name ?? "voice channel";
  const locale = useChatLocale();
  const preview = useMemo(() => {
    const start = fromInputs(form.startDate, form.startTime);
    const end = fromInputs(form.endDate, form.endTime);
    return start ? formatEventRange({ scheduled_start_time: start.toISOString(), scheduled_end_time: end?.toISOString() ?? null }, undefined, locale) : "";
  }, [form.startDate, form.startTime, form.endDate, form.endTime, locale]);

  const title = editing ? "Edit Event" : "Create Event";
  const show = (key: keyof typeof errors) => (touched ? errors[key] : undefined);

  return (
    <Modal
      open
      onClose={back}
      title={title}
      className="modal-medium cm-modal cm-wizard"
      footer={
        <>
          {step > 0 && !(active && step === 1) ? (
            <button type="button" className="btn btn-link footer-back" disabled={busy} onClick={() => (setTouched(false), setStep(s => (s - 1) as Step))}>
              Back
            </button>
          ) : (
            <button type="button" className="btn btn-link footer-back" disabled={busy} onClick={back}>
              Cancel
            </button>
          )}
          {step < 2 ? (
            <button type="button" className="btn" onClick={next}>
              Next
            </button>
          ) : (
            <button type="button" className="btn" disabled={busy} onClick={() => void submit()}>
              {editing ? "Save Changes" : "Create Event"}
            </button>
          )}
        </>
      }
    >
      <ol className="cm-steps" aria-label="Steps">
        {STEPS.map((label, index) => (
          <li key={label} className={index === step ? "current" : index < step ? "done" : ""} aria-current={index === step ? "step" : undefined}>
            <span className="cm-step-number">{index + 1}</span>
            {label}
          </li>
        ))}
      </ol>

      {step === 0 && (
        <div className="cm-step">
          <h3 className="cm-step-title">Where is your event?</h3>
          <p className="cm-muted">So people know where to show up.</p>
          <div className="cm-choices" role="radiogroup" aria-label="Event location">
            {LOCATIONS.map(option => {
              const Icon = option.icon;
              const selected = form.entityType === option.type;
              return (
                <button
                  key={option.type}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  className={`cm-choice${selected ? " selected" : ""}`}
                  onClick={() => {
                    const ids = option.type === ScheduledEventEntityType.StageInstance ? rooms.stage : rooms.voice;
                    patch({ entityType: option.type, ...(ids.includes(form.channelId) ? {} : { channelId: (event?.entity_type === option.type ? event.channel_id : null) ?? ids[0] ?? "" }) });
                  }}
                >
                  <Icon size={24} aria-hidden="true" />
                  <span>
                    <span className="cm-choice-label">{option.label}</span>
                    <span className="cm-choice-hint">{option.hint}</span>
                  </span>
                </button>
              );
            })}
          </div>
          {external ? (
            <div className="cm-field">
              <label className="field-label" htmlFor="cm-location">
                Where is it? <span className="required">*</span>
              </label>
              <input id="cm-location" className="input" maxLength={LOCATION_MAX} placeholder="Add a link, a text channel or a place" value={form.location} onChange={e => patch({ location: e.target.value })} />
              {show("location") && <p className="field-error">{show("location")}</p>}
            </div>
          ) : (
            <div className="cm-field">
              <label className="field-label" htmlFor="cm-channel">
                {stage ? "Stage channel" : "Voice channel"} <span className="required">*</span>
              </label>
              {channelIds.length === 0 ? (
                <p className="cm-muted">This server has no {stage ? "stage" : "voice"} channel yet. Create one first, or pick &ldquo;Somewhere Else&rdquo;.</p>
              ) : (
                <select id="cm-channel" className="input" value={form.channelId} onChange={e => patch({ channelId: e.target.value })}>
                  {form.channelId === "" && <option value="">Channel was deleted: pick another</option>}
                  {channelIds.map(id => (
                    <option key={id} value={id}>
                      {channelName(id)}
                    </option>
                  ))}
                </select>
              )}
              {show("channelId") && <p className="field-error">{show("channelId")}</p>}
            </div>
          )}
        </div>
      )}

      {step === 1 && (
        <div className="cm-step">
          <div className="cm-field">
            <label className="field-label" htmlFor="cm-name">
              Event topic <span className="required">*</span>
            </label>
            <input id="cm-name" className="input" maxLength={NAME_MAX} placeholder="What's your event?" value={form.name} autoFocus onChange={e => patch({ name: e.target.value })} />
            {show("name") && <p className="field-error">{show("name")}</p>}
          </div>
          <div className="cm-row">
            <div className="cm-field">
              <label className="field-label" htmlFor="cm-start-date">
                Start date <span className="required">*</span>
              </label>
              <input id="cm-start-date" className="input" type="date" value={form.startDate} disabled={active} onChange={e => patch({ startDate: e.target.value })} />
            </div>
            <div className="cm-field">
              <label className="field-label" htmlFor="cm-start-time">
                Start time <span className="required">*</span>
              </label>
              <input id="cm-start-time" className="input" type="time" value={form.startTime} disabled={active} onChange={e => patch({ startTime: e.target.value })} />
            </div>
          </div>
          {show("start") && <p className="field-error">{show("start")}</p>}
          <div className="cm-row">
            <div className="cm-field">
              <label className="field-label" htmlFor="cm-end-date">
                End date {external && <span className="required">*</span>}
              </label>
              <input id="cm-end-date" className="input" type="date" value={form.endDate} onChange={e => patch({ endDate: e.target.value })} />
            </div>
            <div className="cm-field">
              <label className="field-label" htmlFor="cm-end-time">
                End time {external && <span className="required">*</span>}
              </label>
              <input id="cm-end-time" className="input" type="time" value={form.endTime} onChange={e => patch({ endTime: e.target.value })} />
            </div>
          </div>
          {show("end") && <p className="field-error">{show("end")}</p>}
          {!active && (
            <div className="cm-field">
              <label className="field-label" htmlFor="cm-repeat">
                Repeat
              </label>
              <select id="cm-repeat" className="input" value={form.repeat} onChange={e => patch({ repeat: e.target.value as EventForm["repeat"] })}>
                {(Object.keys(REPEAT_LABELS) as RepeatChoice[]).map(choice => (
                  <option key={choice} value={choice}>
                    {REPEAT_LABELS[choice]}
                  </option>
                ))}
                {form.repeat === "keep" && <option value="keep">Keep the current schedule</option>}
              </select>
              {form.repeat !== "none" && <p className="cm-muted">The schedule is saved and shown on the event. Vokko doesn&apos;t create the follow-up events by itself yet.</p>}
            </div>
          )}
          <div className="cm-field">
            <label className="field-label" htmlFor="cm-description">
              Description
            </label>
            <textarea id="cm-description" className="input cm-textarea" rows={4} maxLength={DESCRIPTION_MAX} placeholder="Tell people a little more about your event. Markdown isn't supported." value={form.description} onChange={e => patch({ description: e.target.value })} />
            {show("description") && <p className="field-error">{show("description")}</p>}
          </div>
          <div className="cm-field">
            <span className="field-label">Cover image</span>
            {coverUrl ? (
              <div className="cm-cover-preview">
                <img src={coverUrl} alt="Cover preview" />
                <button
                  type="button"
                  className="icon-button"
                  aria-label="Remove cover image"
                  onClick={() => {
                    setCover(null);
                    setRemoveCover(true);
                  }}
                >
                  <X size={18} />
                </button>
              </div>
            ) : (
              <button type="button" className="btn btn-secondary btn-sm" onClick={() => fileInput.current?.click()}>
                <ImagePlus size={16} aria-hidden="true" />
                Upload cover image
              </button>
            )}
            <input
              ref={fileInput}
              type="file"
              accept={IMAGE_TYPES}
              hidden
              aria-label="Cover image file"
              onChange={e => {
                const file = e.target.files?.[0];
                e.target.value = "";
                if (!file) return;
                setCover({ file, preview: URL.createObjectURL(file) });
                setRemoveCover(false);
              }}
            />
          </div>
        </div>
      )}

      {step === 2 && (
        <div className="cm-step">
          <h3 className="cm-step-title">{editing ? "Review your changes" : "Looks good?"}</h3>
          <div className="cm-review" aria-label="Event preview">
            {coverUrl && <img className="cm-detail-cover" src={coverUrl} alt="" />}
            <div className="cm-review-body">
              <div className="cm-event-when">{preview}</div>
              <h4 className="cm-review-name">{form.name.trim() || "Untitled event"}</h4>
              <div className="cm-event-place">
                {external ? <MapPin size={16} aria-hidden="true" /> : <Mic size={16} aria-hidden="true" />}
                <span>{external ? form.location.trim() : channelName(form.channelId)}</span>
              </div>
              {form.description.trim() && <p className="cm-detail-description">{form.description.trim()}</p>}
              {form.repeat !== "none" && form.repeat !== "keep" && <p className="cm-muted">{REPEAT_LABELS[form.repeat]}</p>}
            </div>
          </div>
          {!editing && <p className="cm-muted">Everyone in the server can see this event and mark themselves as interested.</p>}
          {error && (
            <p className="field-error" role="alert">
              {error}
            </p>
          )}
        </div>
      )}
    </Modal>
  );
}

