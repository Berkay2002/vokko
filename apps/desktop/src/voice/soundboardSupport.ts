// Soundboard feature check. The server routes (cloud task `cloud-soundboard`, docs/cloud/soundboard.md) are not on main
// yet, so the entrance-sound picker in User Settings > Voice & Video shows "Coming soon". Flip this when
// `/guilds/{id}/soundboard-sounds` and the entrance-sound setting exist in src/api and the picker can be wired to them.

export const SOUNDBOARD_ROUTES_AVAILABLE = false;
