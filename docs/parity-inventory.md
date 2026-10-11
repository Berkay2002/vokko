# Parity inventory (Discord web client, captured 2026-10-11)

The target list for "looks the same / works the same". Each row has an id, a one-line acceptance description and a pointer to the private
reference (`.claude/reference/discord-2026-10-11/`, outside git; paths below are relative to it). Track visual and behavioural parity
separately. "REF: none" means the screen/behaviour is known to exist in Discord but has not been captured yet (see `INDEX.md` there).
No usernames, message text or server names appear in this file by design.

Conventions: measurements are CSS px; token names refer to `tokens.md`. UI language of the capture was Swedish (strings are i18n keys for us).

## SHELL: app shell, rail, DM sidebar, title bar
| Id | Acceptance | REF |
|---|---|---|
| SHELL-001 | 32 px title bar with app name centred, inbox and help buttons right | app-shell/spec.md |
| SHELL-002 | Server rail 72 px wide, 48 px pitch, 40x40 squircle server icons, selected icon morphs to a rounder shape | app-shell/spec.md |
| SHELL-003 | Rail pill indicator: selected h40, hover h20, unread h8, hidden when idle; 0.2 s ease-out | app-shell/spec.md |
| SHELL-004 | Rail tooltip on hover (right of icon, name text) | app-shell/02-rail-hover-tooltip.jpg |
| SHELL-005 | Rail separator, add-server and discover buttons, download-apps button | app-shell/11-rail-bottom-dmlist.png |
| SHELL-006 | Rail scrolls independently; folders (collapsible groups, 48 px) | app-shell/10-rail-scrolled-full.jpg |
| SHELL-007 | Home button + unread DM avatars with red mention badge at the top of the rail | REF: none (no unread DMs at capture) |
| SHELL-008 | DM sidebar 302.7 px list with top-left radius 12, search button "find or start a conversation" | app-shell/01-home-friends-online.jpg |
| SHELL-009 | Friends nav row h40 with active/hover states (the other nav rows in that list are paid features, see Out of scope) | app-shell/spec.md |
| SHELL-010 | "Direct Messages" header with + button; DM rows h44 with avatar, presence dot, name, status/subtitle | app-shell/04-dm-row-hover.png |
| SHELL-011 | Group DM row shows member count subtitle; clan tag chips next to names | app-shell/11-rail-bottom-dmlist.png |
| SHELL-012 | Floating user panel (x=8, 358.7 x 57.3, radius 8): avatar+status dot, name, status text, mute / deafen / settings buttons | app-shell/13-userpanel-mute-hover.png |
| SHELL-013 | Mute/deafen buttons with split caret that opens input/output device menus | REF: none (menus not opened) |
| SHELL-014 | User-panel popout: profile card + rows (edit profile, status submenu, switch account, copy user ID) opens above the panel | popouts/02-user-panel-popout.jpg (status submenu not opened) |
| SHELL-015 | Resize handle (4 px) between rail/sidebar and chat; layout behaviour at ~1000 px and minimum width | REF: none (window could not be resized) |

## FRIEND: Friends page
| Id | Acceptance | REF |
|---|---|---|
| FRIEND-001 | Header h49 with Friends icon + title, tabs Online / All / Pending / Blocked + "Add Friend" button, tab pills radius 8 | app-shell/06-friends-all.png |
| FRIEND-002 | Friend rows: avatar, name, status line, hover actions (message, more) | app-shell/05-friends-rows-zoom.png |
| FRIEND-003 | Pending tab with empty state illustration and text | app-shell/07-friends-pending-empty.png |
| FRIEND-004 | Suggestions list | app-shell/08-friends-suggestions.png |
| FRIEND-005 | Add Friend form (username input + send button) | app-shell/09-friends-add.png |
| FRIEND-006 | Active Now column (420 px, activity cards radius 16) | app-shell/spec.md |
| FRIEND-007 | Search bar in the friends list with filter | app-shell/spec.md |

## DM: DM channel frame
| Id | Acceptance | REF |
|---|---|---|
| DM-001 | Header h49: avatar, name, call / video / pins / add-to-DM / profile-toggle buttons (32x32, pitch 40), search box 244x32 | dm-chat/spec.md |
| DM-002 | Header icon tooltips below the button | dm-chat/16b-pins-tooltip.png |
| DM-003 | Start-of-DM block: 80 px avatar, name h3 32/40 w700, username 24/30, description, mutual-servers row, friend/block buttons | dm-chat/01-dm-view.png |
| DM-004 | Day divider: centred 12 px label on a 0.67 px line, margins 24/8 | dm-chat/spec.md |
| DM-005 | Right profile aside 320 px (banner 105 high, avatar 80, member-since, "view full profile"), toggled from header | dm-chat/01-dm-view.png |
| DM-006 | Pinned messages popout 420x371 with empty state + tip footer | dm-chat/16-pins-popout.jpg |
| DM-007 | In-DM search results panel | REF: none |
| DM-008 | Call UI (start voice/video call, incoming call screen) | REF: none (not triggered) |
| DM-009 | Typing indicator under the composer ("X is typing…") | REF: none |
| DM-010 | New-messages divider and "mark as read" bar at the top; jump-to-present bar at the bottom | REF: none |

## MSG: message list and message actions
| Id | Acceptance | REF |
|---|---|---|
| MSG-001 | Cozy layout: avatar 40 at left, name 16/22 w500, timestamp 12/22, content 16/22, row padding 2/24/2/72 | dm-chat/spec.md |
| MSG-002 | Group start has 17 px top margin; follow-ups within the window collapse the header and show the time on hover in a 56 px gutter | dm-chat/21-grouped-and-mention-highlight.jpg |
| MSG-003 | Row hover background rgba(151,151,159,0.12) | dm-chat/10-message-hover-toolbar.png |
| MSG-004 | Hover toolbar: quick reactions, add reaction, edit (own), reply/forward, more; 28x28 buttons, radius 8 pill, offset -16 / right 14 | dm-chat/10-message-hover-toolbar.png |
| MSG-005 | Context menu with quick reactions, reaction submenu, edit, reply, forward, (guild: create thread), copy text, pin, bookmark, remind, apps, mark unread, copy link, TTS, delete, copy ID | dm-chat/11-message-context-menu.jpg, guild/06-message-context-menu.jpg |
| MSG-006 | Context-menu item hover/focus state; destructive item in danger colour | dm-chat/12-context-menu-item-hover.png |
| MSG-007 | Reply flow: bar above composer ("Replying to NAME", close), target row highlighted with 2 px brand bar + 16% tint, Escape cancels | dm-chat/13-reply-bar.png |
| MSG-008 | Reply reference line above a message that replies (avatar 16, name, snippet, curved connector, click jumps to target) | dm-chat/26-reply-reference-line.jpg |
| MSG-009 | Inline edit: textarea in place, "escape cancels • enter saves" hint, emoji button | dm-chat/14-inline-edit.png |
| MSG-010 | "(edited)" marker after edited content, 10/10 muted | dm-chat/24-edited-marker.jpg |
| MSG-011 | Delete confirmation modal with message preview | REF: none (not opened) |
| MSG-012 | Reactions: pills under message (emoji + count, own highlighted), + button on hover, tooltip with reactors | dm-chat/20-reaction-pill.jpg (reactor tooltip not measured) |
| MSG-013 | Reaction picker from the hover bar: emoji picker anchored left of the button, search focused | dm-chat/15-reaction-picker.jpg |
| MSG-014 | Pin from the menu: confirm modal, then a system row "X pinned a message" with pin icon in the gutter | dm-chat/22-pin-system-message.jpg, modals/05-pin-confirm.jpg |
| MSG-015 | Forward modal (pick destination, optional note) | REF: none |
| MSG-016 | Bookmark / reminder submenu | REF: none |
| MSG-017 | Markdown rendering: bold, italic, underline, strike, spoiler, inline code, code block, headings 1-3, subtext, lists, block quote, masked link, auto link, timestamps, emoji shortcodes | dm-chat/17-rendered-markdown.jpg, dm-chat/19-spoiler-revealed.png, dm-chat/spec.md "Rendered message" |
| MSG-018 | Link embeds (invite embed incl. expired state, URL previews, image/video embeds) | dm-chat/01-dm-view.png (expired invite only) |
| MSG-019 | Attachments: images grid with lightbox, files with download, video/audio players, spoiler attachments | REF: none |
| MSG-020 | Stickers and GIFs in messages | REF: none |
| MSG-021 | Message selection / long-press mobile gestures | out of scope (desktop web) |
| MSG-022 | Mentions render as chips (user captured; role and channel chips not) and the row gets a mention highlight with a 2 px bar | dm-chat/21-grouped-and-mention-highlight.jpg, guild/05-mention-autocomplete.jpg |
| MSG-023 | Slash-command output and application messages (bot badge, ephemeral "only you can see this") | REF: none |
| MSG-024 | System messages with icon and muted style (pin captured; join, call not) | dm-chat/22-pin-system-message.jpg |
| MSG-025 | Message length limit 2000 with character counter and block | REF: none |

## CMP: composer
| Id | Acceptance | REF |
|---|---|---|
| CMP-001 | Composer wrapper h57.3 radius 8, border 0.67 px, grows with lines up to ~50% of viewport then scrolls | dm-chat/01-dm-view.png, dm-chat/09-composer-markdown-live.png |
| CMP-002 | Attach "+" button opens menu: upload a file, create poll, use apps (182x125) | dm-chat/02-attach-menu.png |
| CMP-003 | Right buttons: gift, GIF, sticker, emoji, apps (32x32) | dm-chat/01-dm-view.png |
| CMP-004 | Emoji picker 498x486 with Emoji/GIF/Stickers tabs, search, categories rail, 48 px cells, preview footer | dm-chat/03-emoji-picker.png |
| CMP-005 | GIF picker with search + categories + trending | dm-chat/04-gif-picker.png |
| CMP-006 | Sticker picker | dm-chat/05-sticker-picker.png |
| CMP-007 | `@` autocomplete panel (members, roles) with keyboard selection; Tab inserts a chip | dm-chat/06-mention-autocomplete.png, guild/05-mention-autocomplete.jpg |
| CMP-008 | `:` emoji autocomplete with preview | dm-chat/07-emoji-autocomplete.png |
| CMP-009 | `/` slash-command panel with app rail | dm-chat/08-slash-commands.png |
| CMP-010 | `#` channel autocomplete (guild only) | REF: none |
| CMP-011 | Live markdown styling in the editor (syntax characters dimmed) | dm-chat/09-composer-markdown-live.png |
| CMP-012 | Shift+Enter newline, Enter send, Escape clears reply, Up arrow edits last own message | dm-chat/spec.md (partly behaviour notes) |
| CMP-013 | Paste/drag-drop file upload preview with remove/spoiler/alt-text | REF: none |
| CMP-014 | Slowmode / locked channel / no-permission composer states | REF: none |

## GLD: guild frame
| Id | Acceptance | REF |
|---|---|---|
| GLD-001 | Server header h49 with name, chevron flip, invite shortcut; banner variant | guild/spec.md |
| GLD-002 | Server dropdown: invite, settings, create channel/category/event, app directory, notification + privacy settings, edit server profile, hide muted, copy ID | guild/03-server-dropdown.jpg |
| GLD-003 | Event quick link under the header | guild/01-welcome-new-server.jpg |
| GLD-004 | Category header with collapse chevron and + button | guild/02-channel-rows-hover.png |
| GLD-005 | Channel row 286x32 radius 8, icon 20, name 16/24; selected 12% bg + w500; hover actions (invite, settings, open chat) | guild/02-channel-rows-hover.png |
| GLD-006 | Channel states: unread (white text + dot), mention (red badge), muted (dim), locked/private icon | REF: none |
| GLD-007 | Voice channel with connected users listed below; join on click | REF: none |
| GLD-008 | Channel header h49 with name, topic, toolbar: threads, notifications, pins, member list; search 244x32 | guild/spec.md |
| GLD-009 | Start-of-channel header (68 px tile, "Welcome to #name", edit-channel button) | guild/02-channel-start.jpg |
| GLD-010 | New-server welcome checklist | guild/01-welcome-new-server.jpg |
| GLD-011 | Member list (role groups, online/offline, presence dots, activity line, role colours), toggled from header; 264 wide, rows 248x42 | guild/04-member-list.jpg (single member only; groups/offline/activity not captured) |
| GLD-012 | Channel / category / server-icon right-click context menus | guild/07-channel-context-menu.jpg, guild/08-category-context-menu.jpg, guild/09-server-icon-context-menu.jpg |
| GLD-013 | Threads: thread list popout, thread view side panel, thread starter message | REF: none |
| GLD-014 | Forum channel: post list, tags, create-post flow | REF: none |
| GLD-015 | Announcement channel (publish button) and stage channel | REF: none |
| GLD-016 | Server folder, server context menu in rail | REF: none |
| GLD-017 | Member-list profile popout on click | popouts/01-member-profile.jpg |
| GLD-018 | Invite modal (link, copy, expiry settings, friends list) | REF: none |

## POP: popouts and menus
| Id | Acceptance | REF |
|---|---|---|
| POP-001 | User profile popout 300x379 (banner, avatar, status bubble, name, badges, roles, primary button) | popouts/01-member-profile.jpg |
| POP-002 | Full profile modal (tabs: activity, mutual servers, mutual friends) | REF: none |
| POP-003 | Tooltips: dark pill, 14/18 w500, arrow | dm-chat/16b-pins-tooltip.png |
| POP-004 | Notification-settings popout and mute submenu | REF: none |
| POP-005 | Inbox popout ~600x565 (tabs: unread, mentions, bookmarks, reminders) | rest/01-inbox-popout.jpg |
| POP-006 | Emoji/GIF/sticker pickers as popouts (see CMP-004..006) | dm-chat/03..05 |

## MOD: modals
| Id | Acceptance | REF |
|---|---|---|
| MOD-001 | Create-server step 1: templates + join with invite, 443x560 | modals/02-create-server-1-start.jpg |
| MOD-002 | Create-server step 2: purpose question (friends vs community) with skip | modals/03-create-server-2-purpose.jpg |
| MOD-003 | Create-server step 3: icon uploader, name input, guidelines link, Back/Create | modals/04-create-server-3-customize.jpg |
| MOD-004 | Create-channel modal: type radios, name with prefix, private switch, buttons 211x39 | modals/01-create-channel.jpg |
| MOD-005 | Quick switcher (Ctrl+K): input, recent channels list, tips footer | modals/06-quick-switcher.jpg |
| MOD-006 | Keyboard shortcuts dialog (Ctrl+/): sections, key-cap cards | modals/07-keyboard-shortcuts.jpg |
| MOD-007 | Confirmation modals (delete message, leave server, unsaved changes bar in settings) | REF: none |
| MOD-008 | Image lightbox (zoom, open original, download) | REF: none |
| MOD-009 | Report / block / remove-friend confirmations | REF: none |
| MOD-010 | Join-server-with-invite modal and invite landing screen | REF: none |
| MOD-011 | Pin confirmation modal ~479x298 with message preview and Cancel / primary buttons | modals/05-pin-confirm.jpg |

## SET: settings
| Id | Acceptance | REF |
|---|---|---|
| SET-001 | User settings opens as a large centred modal (~1400x665 in the web build): left nav 253 px with search and section labels, content column with title strip, close button + Esc | settings/01-appearance.jpg, settings/spec.md |
| SET-002 | My Account page: info rows with Change buttons, password and security rows (other pages not opened) | settings/02-account.jpg (contains masked account data) |
| SET-003 | Appearance page: theme toggle, default theme swatches (light/dark/darker/onyx/sync); other sub-pages not opened | settings/01-appearance.jpg |
| SET-004 | Accessibility, Voice & Video, Chat, Notifications, Keybinds, Language, Streamer mode, Advanced | REF: none |
| SET-005 | Server settings: Overview, Roles, Emoji, Stickers, Soundboard, Integrations, Moderation, Audit log, Safety setup, Bans, Invites, Onboarding, Community | REF: none |
| SET-006 | Channel settings: Overview, Permissions, Invites, Integrations | REF: none |
| SET-007 | Unsaved-changes bar (shake animation, reset/save) | REF: none |

## REST: remaining
| Id | Acceptance | REF |
|---|---|---|
| REST-001 | Server-wide message search with filters (from, in, has, mentions, date) and results panel | REF: none |
| REST-002 | Login, register, password reset, MFA screens | REF: none (session must not be logged out) |
| REST-003 | Onboarding flow for new members (questions, channels) | REF: none |
| REST-004 | Loading screen, connection-lost banner, update/maintenance banners | REF: none |
| REST-005 | Notification sounds and desktop notifications (web: Notification API) | REF: none |
| REST-006 | Responsive layouts at ~1000 px and minimum width (sidebar collapse, member list hide) | REF: none |

## Out of scope (decided, no ids)
Vokko is free: Nitro and subscriptions, billing and payment settings, the Shop, Quests, Orbs, server boosts (boost button, boost perks, boost-locked features), gift inventory
and every paid upsell (locked profile effects/decorations, locked colour themes, locked emoji/sticker/soundboard slots). Not captured and not to be built. Rows above that touched them were reduced to the free part.

## DESK: desktop-only (not available from web capture)
Voice/video call overlay, game overlay, tray icon + close-to-tray, push-to-talk global keybinds, rich presence/game detection, run on startup,
native window controls, auto-update UX. Reference needs desktop capture (see INDEX.md "Desktop-only").
