// Notifications, sounds and connection banners (client side). `startNotify()` is called once from main.tsx; `NotifyBanners`
// and `Splash` are mounted from App.tsx.
export { startNotify, openMessage } from "./controller";
export { NotifyBanners } from "./Banners";
export { Splash } from "./Splash";
export { SOUND_LABELS, playSound, previewSound, soundEnabled, type NotificationSoundName, type SoundName } from "./sounds";
export { flashTaskbar, notificationAdapter, type NotificationAdapter, type PermissionState } from "./desktop";
export { decide, type NotifyDecision, type NotifyInput } from "./decide";
