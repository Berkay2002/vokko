use axum::Router;

use crate::state::AppState;

mod applications;
mod attachments;
pub mod auth;
mod channels;
mod emojis;
mod follows;
mod forums;
mod gifs;
pub mod guild_layout;
pub mod guild_privacy;
mod guilds;
mod interactions;
pub mod invites;
pub mod join_requests;
mod member_search;
pub mod messages;
pub mod moderation;
mod onboarding;
mod overwrites;
mod polls;
mod reactions;
pub mod relationships;
mod reports;
mod saved;
pub mod scheduled_events;
mod search;
pub mod settings;
mod soundboard;
mod stickers;
mod suggestions;
mod threads;
pub mod users;
mod webhooks;

pub fn api(max_upload_bytes: usize) -> Router<AppState> {
    Router::new()
        .merge(auth::routes())
        .merge(crate::account::routes())
        .merge(users::routes())
        .merge(guild_layout::routes())
        .merge(guilds::routes())
        .merge(guild_privacy::routes())
        .merge(moderation::routes())
        .merge(member_search::routes())
        .merge(channels::routes())
        .merge(overwrites::routes())
        .merge(invites::routes())
        .merge(join_requests::routes())
        .merge(relationships::routes())
        .merge(messages::routes())
        .merge(reactions::routes())
        .merge(emojis::routes())
        .merge(polls::routes())
        .merge(search::routes())
        .merge(scheduled_events::routes())
        .merge(onboarding::routes())
        .merge(suggestions::routes())
        .merge(reports::routes())
        .merge(saved::routes())
        .merge(settings::routes())
        .merge(gifs::routes())
        .merge(stickers::routes())
        .merge(soundboard::routes())
        .merge(crate::voice::status::routes())
        .merge(crate::voice::calls::routes())
        .merge(crate::voice::stage::routes())
        .merge(crate::voice::watch::routes())
        .merge(crate::voice::stremio::routes())
        .merge(crate::stremio::routes())
        .merge(threads::routes())
        .merge(forums::routes())
        .merge(follows::routes())
        .merge(applications::routes())
        .merge(interactions::routes())
        .merge(webhooks::routes())
        .merge(crate::audit::routes())
        .merge(crate::safety::routes())
        .merge(attachments::routes(max_upload_bytes))
}
