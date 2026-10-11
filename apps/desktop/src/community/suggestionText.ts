/** Text under a suggestion: what the two of you have in common. */
export function commonText(mutualFriends: number, serverNames: string[]): string {
  const parts: string[] = [];
  if (mutualFriends > 0) parts.push(`${mutualFriends} mutual friend${mutualFriends === 1 ? "" : "s"}`);
  if (serverNames.length === 1) parts.push(`Both in ${serverNames[0]}`);
  else if (serverNames.length > 1) parts.push(`${serverNames.length} mutual servers`);
  return parts.join(" · ") || "Might know each other";
}
