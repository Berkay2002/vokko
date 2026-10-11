// My Account: fills the User Settings slots of the shell (src/shell/settings/slots.ts). main.tsx imports this once.

import { listenForOAuthLinks } from "../auth/oauth";
import { registerSettingsSlots } from "../shell/settings/slots";
import { AccountIdentity } from "./Identity";
import { AccountSecurity } from "./Security";
import { SignInMethods } from "./SignInMethods";

registerSettingsSlots({ accountIdentity: AccountIdentity, accountSecurity: AccountSecurity, signInMethods: SignInMethods });
// desktop: OAuth results arrive as vokko://auth/callback links (queued ones are replayed)
listenForOAuthLinks();
