import { useState } from "react";
import { tokenStore } from "./api";
import { Dashboard } from "./components/Dashboard";
import { TokenGate } from "./components/TokenGate";

export function App() {
  const [authenticated, setAuthenticated] = useState(() => tokenStore.get() !== null);

  if (!authenticated) {
    return <TokenGate onAuthenticated={() => setAuthenticated(true)} />;
  }
  return <Dashboard onSignOut={() => setAuthenticated(false)} />;
}
