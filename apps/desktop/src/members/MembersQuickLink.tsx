import { NavLink } from "react-router";
import { Users } from "lucide-react";
import type { Guild } from "../api/types";
import { guildPath } from "../shell/nav";
import { usePermissions } from "../shell/usePermissions";
import { MEMBERS_ROUTE, canSeeMembersPage } from "./query";

/** The "Members" row under Events; only moderators (Discord's member-safety permissions) see it. */
export function MembersQuickLink({ guild }: { guild: Guild }) {
  const { bits } = usePermissions(guild.id);
  if (!canSeeMembersPage(bits)) return null;
  return (
    <NavLink to={guildPath(guild.id, MEMBERS_ROUTE)} className={({ isActive }) => `cm-quicklink mp-quicklink${isActive ? " selected" : ""}`}>
      <Users size={20} aria-hidden="true" />
      <span className="cm-quicklink-label">Members</span>
    </NavLink>
  );
}
