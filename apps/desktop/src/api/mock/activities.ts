import { hasMockAppIcon } from "../appIcons";
import type { Activity } from "../types";

// The server's activity validation (Activity::list_is_valid in crates/protocol/src/api.rs, docs/api.md "Activities"), so the
// mock backend closes the gateway with 4002 for exactly the lists the real one does.

const UNSHOWN = /[\p{Cc}­͏؜ᅟᅠ᠎​-‏‪-‮⁠-⁩ㅤ﻿ﾠ]/u;
const IMAGE = /^spotify:[0-9a-f]{40}$/;
const APP_IMAGE = /^app:[0-9a-f]{64}$/;
const TRACK = /^[A-Za-z0-9]{22}$/;

const textOk = (text: unknown): boolean => typeof text === "string" && Array.from(text).length <= 128 && !UNSHOWN.test(text) && text.trim() !== "";

function activityOk(a: Activity): boolean {
  const start = a.timestamps?.start;
  const end = a.timestamps?.end;
  if (!textOk(a.name) || (start !== undefined && !(start >= 0))) return false;
  if (a.type === 0) {
    const image = a.assets?.large_image;
    return end === undefined && a.details === undefined && a.state === undefined && a.sync_id === undefined && (image === undefined || APP_IMAGE.test(image));
  }
  if (a.type !== 2 || a.name !== "Spotify") return false;
  const image = a.assets?.large_image;
  return (
    (a.details === undefined || textOk(a.details)) &&
    (a.state === undefined || textOk(a.state)) &&
    (image === undefined || IMAGE.test(image)) &&
    (a.sync_id === undefined || TRACK.test(a.sync_id)) &&
    (end === undefined || (end >= 0 && (start === undefined || end >= start)))
  );
}

/** Whether a client-sent activity list is acceptable: at most two, one of each type, each valid. */
export function activityListIsValid(list: Activity[]): boolean {
  return list.length <= 2 && list.every((a, i) => list.findIndex(other => other.type === a.type) === i && activityOk(a));
}

/** The activity without its `app:` image when the backend holds no such icon. */
export function withKnownIcon(a: Activity): Activity {
  const image = a.assets?.large_image;
  if (a.type !== 0 || !image || hasMockAppIcon(image.slice("app:".length))) return a;
  const { assets: _dropped, ...rest } = a;
  return rest;
}
