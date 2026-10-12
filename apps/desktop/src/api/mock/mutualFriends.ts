// Mutual friends with the server's rules (docs/api.md GET /users/{id}/relationships), shared by the profile, the
// relationships route and friend suggestions so their counts agree.
import { RelationshipType, type User } from "../types";
import { compareIds } from "../snowflake";
import { db, type MockAccount } from "./db";
import { relationship } from "./views";

/** Friends the viewer and `otherId` share: [] for self, on a block either way, or with no shared context; blocked mutuals are left out. */
export function mutualFriendsOf(viewer: MockAccount, other: MockAccount): User[] {
  if (viewer.user.id === other.user.id) return [];
  const viewerId = viewer.user.id;
  const otherId = other.user.id;
  if (relationship(viewerId, otherId)?.type === RelationshipType.Blocked || relationship(otherId, viewerId)?.type === RelationshipType.Blocked) return [];
  const shared =
    viewer.relationships.has(otherId) ||
    other.relationships.has(viewerId) ||
    [...db.guilds.values()].some(g => g.members.has(viewerId) && g.members.has(otherId)) ||
    [...db.channels.values()].some(c => c.participant_ids?.includes(viewerId) && c.participant_ids.includes(otherId) && (db.messages.get(c.id)?.length ?? 0) > 0);
  if (!shared) return [];
  const blocks = (a: MockAccount, id: string) => a.relationships.get(id) === RelationshipType.Blocked || db.accounts.get(id)?.relationships.get(a.user.id) === RelationshipType.Blocked;
  return [...viewer.relationships]
    .filter(([id, t]) => t === RelationshipType.Friend && other.relationships.get(id) === RelationshipType.Friend && !blocks(viewer, id))
    .map(([id]) => id)
    .sort(compareIds)
    .flatMap(id => (db.accounts.get(id) ? [db.accounts.get(id)!.user] : []));
}
