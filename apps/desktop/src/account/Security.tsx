// "Password & Security" of My Account (settings slot `accountSecurity`).

import { useEffect } from "react";
import { loadAccount } from "./api";
import { DevicesList } from "./Devices";
import { PasswordRow } from "./Password";
import { AccountRemoval } from "./Removal";
import { TwoFactorRows } from "./TwoFactor";

export function AccountSecurity() {
  useEffect(() => {
    void loadAccount();
  }, []);
  return (
    <>
      <PasswordRow />
      <TwoFactorRows />
      <DevicesList />
      <AccountRemoval />
    </>
  );
}
