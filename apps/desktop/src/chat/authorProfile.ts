import type { MouseEvent } from 'react';
import type { Snowflake, User } from '../api/types';
import { cacheUser, loadUserMenu, openProfile, useContextMenu } from './shell';

/** Handlers for a message author's avatar or name: a click opens the profile card, a right-click the user menu (not the message menu). */
export function useAuthorProfile(guildId: Snowflake | null): (user: User) => { onMouseDown(e: MouseEvent<HTMLElement>): void; onClick(e: MouseEvent<HTMLElement>): void; onContextMenu(e: MouseEvent<HTMLElement>): void } {
  const menu = useContextMenu();
  return user => ({
    // no focus on press: focus would show the row's toolbar (focus-within), which on a phone covers the name before the click lands
    onMouseDown: e => e.preventDefault(),
    onClick: e => { cacheUser(user); openProfile(e.currentTarget, user.id, guildId); },
    onContextMenu: e => {
      e.preventDefault();
      e.stopPropagation();
      cacheUser(user);
      const { clientX, clientY, currentTarget: anchor } = e;
      void loadUserMenu().then(items => menu.open({ clientX, clientY }, items(user, { guildId, anchor })));
    },
  });
}
