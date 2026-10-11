/**
 * Create-server templates. A new guild already has the "Text Channels" and "Voice Channels" categories with #general and
 * "General"; a template adds channels on top of that (names follow Discord's starter templates).
 */
export interface ServerTemplate {
  id: string;
  label: string;
  /** Extra text channels, created under "Text Channels". */
  text: string[];
  /** Extra voice channels, created under "Voice Channels". */
  voice: string[];
  /** Extra categories with their text channels (created first). */
  categories?: { name: string; text: string[] }[];
}

export const SERVER_TEMPLATES: ServerTemplate[] = [
  { id: "gaming", label: "Gaming", text: ["clips-and-highlights"], voice: ["Lobby", "Gaming"] },
  { id: "school-club", label: "School Club", text: ["announcements", "meeting-plans", "events"], voice: ["Meeting Room 1", "Meeting Room 2"] },
  {
    id: "study-group",
    label: "Study Group",
    text: ["homework-help", "session-planning", "off-topic"],
    voice: ["Study Room 1", "Study Room 2"],
    categories: [{ name: "Information", text: ["welcome-and-rules", "notes-resources"] }],
  },
  { id: "friends", label: "Friends", text: ["games", "music"], voice: ["Lounge", "Stream Room"] },
  { id: "creators", label: "Artists & Creators", text: ["announcements", "events", "ideas-and-feedback"], voice: ["Community Hangout"] },
  { id: "community", label: "Local Community", text: ["announcements", "resources", "events"], voice: ["Lounge"] },
];
