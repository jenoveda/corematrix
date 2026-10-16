import { createContext, useContext } from "react";
import type { Key, Locale } from "./i18n";
import type { State } from "./domain";
export type Dialog =
  | { type: "reservation-cancel"; reservationId: string; admin?: boolean }
  | { type: "cost" }
  | { type: "cost-void"; costId: string }
  | { type: "rental-renew" | "rental-cancel"; orderId: string }
  | { type: "server"; serverId?: string }
  | { type: "server-token" | "delete-server"; serverId: string }
  | { type: "rent" }
  | { type: "deploy"; replaces?: string }
  | {
      type: "deployment-stop" | "deployment-cleanup" | "deployment-events";
      deploymentId: string;
    }
  | { type: "model"; modelId?: string }
  | { type: "recharge" }
  | { type: "try"; modelId: string }
  | { type: "connect" }
  | { type: "credit" }
  | { type: "delete-model"; modelId: string };
export type AppContextValue = {
  state: State;
  changeLocale: (locale: Locale) => Promise<void>;
  languageSaving: boolean;
  refresh: () => Promise<void>;
  mutate: <T = unknown>(
    path: string,
    method: string,
    body?: unknown,
    requestId?: string,
  ) => Promise<T>;
  open: (dialog: Dialog) => void;
  notify: (text: Key | Error, error?: boolean) => void;
};
export const AppContext = createContext<AppContextValue | null>(null);
export function useApp() {
  const app = useContext(AppContext);
  if (!app) throw new Error("Missing AppContext");
  return app;
}
