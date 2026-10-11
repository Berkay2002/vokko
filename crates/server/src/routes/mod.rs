use axum::Router;

use crate::state::AppState;

mod auth;
mod channels;
mod guilds;
mod invites;
mod users;

pub fn api() -> Router<AppState> {
    Router::new().merge(auth::routes()).merge(users::routes()).merge(guilds::routes()).merge(channels::routes()).merge(invites::routes())
}
