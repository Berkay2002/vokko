//! The measured scenarios. Every one paces itself below the server's documented abuse limits (docs/api.md "Limits and
//! abuse controls"), so a 429 or a 4008 close is reported as a limit hit, never absorbed as a latency result.
use std::time::{Duration, Instant};

use rand::Rng;
use reqwest::Method;
use serde_json::{Value, json};
use tokio::task::JoinSet;

use crate::Args;
use crate::gateway::Cmd;
use crate::world::{Guild, World};

/// REST: 10 requests/s per route and user (burst 30). Stay well under it.
pub const MAX_SEND_RATE: f64 = 5.0;
/// Gateway op 3: 5 per minute and session. Stay under it.
pub const PRESENCE_PER_SESSION: usize = 4;
const DRAIN: Duration = Duration::from_secs(3);

fn pick(items: &[String]) -> &str {
    items.get(rand::rng().random_range(0..items.len().max(1))).map(String::as_str).unwrap_or("")
}

/// The first `fraction` of every guild's members (at least one).
fn leaders(world: &World, fraction: f64) -> Vec<(usize, usize)> {
    let mut picked = Vec::new();
    for (number, guild) in world.guilds.iter().enumerate() {
        let take = ((guild.members.len() as f64 * fraction).ceil() as usize).clamp(1, guild.members.len());
        picked.extend(guild.members.iter().take(take).map(|member| (number, *member)));
    }
    picked
}

/// Message sends with fan-out: each sender posts `rate` messages per second into random channels of its guild. The content
/// carries the send time, so every receiver measures its own delivery latency.
pub async fn send(world: &World, fraction: f64, rate: f64, duration: Duration) {
    let rate = rate.clamp(0.05, MAX_SEND_RATE);
    let metrics = world.shared.m();
    let mut senders = JoinSet::new();
    let end = tokio::time::Instant::now() + duration;
    for (number, member) in leaders(world, fraction) {
        let guild: &Guild = &world.guilds[number];
        let (api, shared, user, channels) = (world.api.clone(), world.shared.clone(), world.users[member].clone(), guild.channels.clone());
        let audience = world.connected(guild) as u64;
        senders.spawn(async move {
            let period = Duration::from_secs_f64(1.0 / rate);
            tokio::time::sleep(period.mul_f64(rand::random::<f64>())).await;
            let mut ticker = tokio::time::interval(period);
            ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Burst);
            let mut requests = JoinSet::new();
            while tokio::time::Instant::now() < end {
                ticker.tick().await;
                let (api, user, shared) = (api.clone(), user.clone(), shared.clone());
                let path = format!("/channels/{}/messages", pick(&channels));
                requests.spawn(async move {
                    let content = format!("lt {} {}", shared.now_us(), user.index);
                    if api.call("send_message", Method::POST, &path, Some(&user), Some(json!({"content": content}))).await.is_ok() {
                        shared.m().add("sent:message", 1);
                        shared.m().add("expected:message", audience);
                    }
                });
            }
            while requests.join_next().await.is_some() {}
        });
    }
    while senders.join_next().await.is_some() {}
    tokio::time::sleep(DRAIN).await;
    metrics.add("senders", leaders(world, fraction).len() as u64);
}

/// Synchronized typing bursts: every typer fires one `POST /channels/{id}/typing` per second, all at the same instant.
pub async fn typing(world: &World, fraction: f64, duration: Duration) {
    let typers: Vec<(usize, usize)> = leaders(world, fraction);
    let end = tokio::time::Instant::now() + duration;
    let mut ticker = tokio::time::interval(Duration::from_secs(1));
    let mut requests = JoinSet::new();
    while tokio::time::Instant::now() < end {
        ticker.tick().await;
        for (number, member) in &typers {
            let guild = &world.guilds[*number];
            let (api, shared, user) = (world.api.clone(), world.shared.clone(), world.users[*member].clone());
            let path = format!("/channels/{}/typing", guild.channels[0]);
            let audience = world.connected(guild).saturating_sub(1) as u64;
            requests.spawn(async move {
                if api.call("typing", Method::POST, &path, Some(&user), None).await.is_ok() {
                    shared.m().add("expected:typing", audience);
                }
            });
        }
    }
    while requests.join_next().await.is_some() {}
    tokio::time::sleep(DRAIN).await;
    world.shared.m().add("typers", typers.len() as u64);
}

/// Op 3 presence changes, `PRESENCE_PER_SESSION` per connection in total (the last one clears the stamp). `custom_status` carries the send time.
pub async fn presence(world: &World, fraction: f64, duration: Duration) {
    let users = leaders(world, fraction);
    // one slot of the allowance is kept for clearing the stamped custom status afterwards
    let updates = (PRESENCE_PER_SESSION - 1).min((duration.as_secs() as usize).max(1));
    let mut tasks = JoinSet::new();
    for (number, member) in &users {
        let Some(conn) = world.conns[*member].as_ref() else { continue };
        let (tx, shared) = (conn.tx.clone(), world.shared.clone());
        let audience = world.connected(&world.guilds[*number]) as u64;
        tasks.spawn(async move {
            // Cycles idle → dnd → online → idle, so every update is a real change (the user starts online).
            let statuses = ["idle", "dnd", "online", "idle"];
            let slot = duration.div_f64(updates as f64);
            for step in 0..updates {
                tokio::time::sleep(slot.mul_f64(if step == 0 { rand::random::<f64>() } else { 0.5 + rand::random::<f64>() / 2.0 })).await;
                let command = Cmd::Presence { status: statuses[step % statuses.len()], custom_status: Some(format!("lt:{}", shared.now_us())) };
                if tx.send(command).is_ok() {
                    shared.m().add("sent:presence", 1);
                    // PRESENCE_UPDATE goes to everyone sharing a guild, the sender included.
                    shared.m().add("expected:presence", audience);
                }
            }
            // A stale stamp would otherwise ride on every later PRESENCE_UPDATE of this user (the server keeps custom_status).
            tokio::time::sleep(DRAIN).await;
            let _ = tx.send(Cmd::Presence { status: "online", custom_status: None });
        });
    }
    let started = Instant::now();
    while tasks.join_next().await.is_some() {}
    let rest = duration.saturating_sub(started.elapsed());
    tokio::time::sleep(rest + DRAIN).await;
}

/// History pagination: readers walk a channel backwards in pages of 100.
pub async fn history(world: &World, fraction: f64, pages: usize) {
    let readers = leaders(world, fraction);
    let mut tasks = JoinSet::new();
    for (number, member) in &readers {
        let guild = &world.guilds[*number];
        let (api, shared, user) = (world.api.clone(), world.shared.clone(), world.users[*member].clone());
        let channel = guild.channels[member % guild.channels.len().max(1)].clone();
        tasks.spawn(async move {
            let mut before: Option<String> = None;
            for _ in 0..pages {
                let path = match &before {
                    Some(id) => format!("/channels/{channel}/messages?limit=100&before={id}"),
                    None => format!("/channels/{channel}/messages?limit=100"),
                };
                let Ok(page) = api.call("history_page", Method::GET, &path, Some(&user), None).await else { break };
                let items = page.as_array().map(Vec::as_slice).unwrap_or(&[]);
                shared.m().add("history:pages", 1);
                shared.m().add("history:messages", items.len() as u64);
                before = items.last().and_then(|message| message.get("id")).and_then(Value::as_str).map(str::to_owned);
                if items.len() < 100 || before.is_none() {
                    break;
                }
                // ≤ ~6 requests/s per reader, under the 10/s per-route limit
                tokio::time::sleep(Duration::from_millis(150)).await;
            }
        });
    }
    while tasks.join_next().await.is_some() {}
    world.shared.m().add("readers", readers.len() as u64);
}

/// Every victim is accounted for once it is back (Resume or re-Identify) or gave up (`storm:failed`); a victim that never returns must not
/// keep the loop waiting for its full 60 s limit.
fn storm_settled(back: u64, failed: u64, victims: usize) -> bool {
    back + failed >= victims as u64
}

/// Reconnect storm: a fraction of the connections is cut at the same instant and comes back with Resume after `offline`,
/// while a low background message load keeps filling the replay buffers.
pub async fn reconnect(world: &World, args: &Args) {
    let metrics = world.shared.m();
    let victims: Vec<usize> =
        (0..world.users.len()).filter(|index| world.conns[*index].is_some()).take(((world.users.len() as f64) * args.storm_fraction).ceil() as usize).collect();
    let offline = Duration::from_millis(args.storm_offline_ms);
    let load = send(world, args.sender_fraction, args.send_rate, offline + Duration::from_secs(10));
    let storm = async {
        tokio::time::sleep(Duration::from_secs(2)).await;
        for index in &victims {
            if let Some(conn) = world.conns[*index].as_ref() {
                let _ = conn.tx.send(Cmd::Storm { offline });
            }
        }
        metrics.add("storm:victims", victims.len() as u64);
        let wait_until = Instant::now() + Duration::from_secs(60);
        while Instant::now() < wait_until {
            let back = metrics.counter("resumed") + metrics.hist("reidentify").summary().count;
            if storm_settled(back, metrics.counter("storm:failed"), victims.len()) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
    };
    tokio::join!(load, storm);
}

#[cfg(test)]
mod tests {
    use super::storm_settled;

    #[test]
    fn storm_waits_until_every_victim_is_back_or_failed() {
        assert!(!storm_settled(3, 0, 5), "two victims still away");
        assert!(storm_settled(5, 0, 5));
        assert!(!storm_settled(3, 1, 5), "one victim unaccounted for");
        assert!(storm_settled(3, 2, 5), "failed reconnects count as settled");
        assert!(storm_settled(0, 0, 0));
    }
}
