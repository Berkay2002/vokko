// Community features: scheduled events, new-server checklist, member onboarding, pin confirmation and friend suggestions.
// The shell and the chat mount the pieces listed here; `main.tsx` imports this module once so the gateway wiring runs.
import "./community.css";
import { wireCommunityToGateway } from "./store";

wireCommunityToGateway();

export { CommunityHost } from "./CommunityHost";
export { EventsQuickLink } from "./EventsQuickLink";
export { FriendSuggestionsTab } from "./FriendSuggestions";
export { OnboardingSettings } from "./OnboardingSettings";
export { WelcomeChecklist } from "./WelcomeChecklist";
export { openCreateEvent, openEvents } from "./communityModals";
