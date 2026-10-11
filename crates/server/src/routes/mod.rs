use axum::Router;

use crate::state::AppState;

mod auth;
mod users;

pub fn api() -> Router<AppState> {
    Router::new().merge(auth::routes()).merge(users::routes())
}
