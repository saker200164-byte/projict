// src/lib/providers/index.ts — سجل المزودات

import { cometProvider } from "./cometapi";
import { kieProvider } from "./kie";
import type { ProviderAdapter, ProviderId } from "../types";

export const PROVIDERS: Record<ProviderId, ProviderAdapter> = {
  kie: kieProvider,
  cometapi: cometProvider,
};

export function getProvider(id: ProviderId): ProviderAdapter {
  return PROVIDERS[id];
}
