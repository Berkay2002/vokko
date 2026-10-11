// English app strings (the source catalog). Other languages copy these keys; a missing key falls back to English.
export const en = {
  "settings.title": "User Settings",
  "settings.myAccount": "My Account",
  "settings.dataPrivacy": "Data & Privacy",
  "settings.contentSocial": "Content & Social",
  "settings.notifications": "Notifications",
  "settings.voiceVideo": "Voice & Video",
  "settings.appearance": "Appearance",
  "settings.accessibility": "Accessibility",
  "settings.chat": "Chat",
  "settings.keybinds": "Keybinds",
  "settings.languageTime": "Language & Time",
  "settings.streamerMode": "Streamer Mode",
  "settings.advanced": "Advanced",
  "settings.windows": "Windows Settings",
  "settings.activityPrivacy": "Activity Privacy",
  "settings.connectedApps": "Connected Apps",
  "settings.logOut": "Log Out",
  "settings.search": "Search",
  "language.select": "Select a Language",
  "language.device": "Same as this device",
  "language.note": "Choose the language you want Vokko to show. It also sets how dates are written.",
  "language.timeFormat": "Time format",
  "language.auto": "Automatic",
  "language.12h": "12-hour",
  "language.24h": "24-hour",
  "language.preview": "Timestamps look like this:",
} as const;

export type StringKey = keyof typeof en;
export type Catalog = Partial<Record<StringKey, string>>;
