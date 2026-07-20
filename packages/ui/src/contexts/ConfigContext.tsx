// @vayo/ui — the API base URL + auth token every component that calls
// `api.*` needs. Previously threaded as a `config={config}` prop into 11+
// separate components from DocsApp.tsx; this is the one shared version.
import { createContext, useContext, type ReactNode } from "react";
import type { ApiConfig } from "../api.js";

const ConfigContext = createContext<ApiConfig | null>(null);

export function ConfigProvider({ config, children }: { config: ApiConfig; children: ReactNode }): JSX.Element {
  return <ConfigContext.Provider value={config}>{children}</ConfigContext.Provider>;
}

/** Throws rather than silently returning a placeholder — a component
 * rendered outside `<ConfigProvider>` making API calls against a wrong/empty
 * config would fail confusingly far from the actual mistake. DocsApp (the
 * only provider today) never renders its own children until past the login
 * gate, so every real consumer is always inside the provider. */
export function useConfig(): ApiConfig {
  const config = useContext(ConfigContext);
  if (!config) throw new Error("useConfig() called outside <ConfigProvider>");
  return config;
}
