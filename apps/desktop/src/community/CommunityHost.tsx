import { ChannelsAndRolesModal } from "./ChannelsAndRoles";
import { EventDetail } from "./EventDetail";
import { EventsModal } from "./EventsModal";
import { EventWizard } from "./EventWizard";
import { OnboardingGate } from "./OnboardingFlow";
import { useCommunityModal } from "./communityModals";

/** Mounted once by the app shell: the community dialogs (events, event wizard, details) and the new-member onboarding flow. */
export function CommunityHost() {
  const modal = useCommunityModal(s => s.modal);
  return (
    <>
      {modal?.type === "events" && <EventsModal key={`events-${modal.guildId}`} guildId={modal.guildId} />}
      {modal?.type === "wizard" && <EventWizard key={`wizard-${modal.guildId}-${modal.eventId ?? "new"}`} guildId={modal.guildId} eventId={modal.eventId} from={modal.from} />}
      {modal?.type === "detail" && <EventDetail key={`detail-${modal.eventId}`} guildId={modal.guildId} eventId={modal.eventId} from={modal.from} />}
      {modal?.type === "channelsAndRoles" && <ChannelsAndRolesModal key={`chroles-${modal.guildId}`} guildId={modal.guildId} />}
      <OnboardingGate />
    </>
  );
}
