/**
 * Model selection shared by the Lead command runtime and the project-memory
 * compactor: resolve a configured `provider/model` string against the registry.
 */
import type { Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { compactModelToken } from "./presentation.ts";

export function modelToken(model: { provider: string; id: string }): string {
  return `${model.provider}/${model.id}`;
}

export function resolveConfiguredModel(
  ctx: ExtensionContext,
  configured: string,
): Model | undefined {
  const models = ctx.modelRegistry.getAll();
  const canonical = models.find(
    (candidate: Model) => modelToken(candidate) === configured,
  );
  if (canonical) return canonical;
  const compactMatches = models.filter(
    (candidate: Model) =>
      compactModelToken(modelToken(candidate)) === configured,
  );
  return compactMatches.length === 1 ? compactMatches[0] : undefined;
}
