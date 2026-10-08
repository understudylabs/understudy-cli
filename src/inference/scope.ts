import type { InferenceCredential } from "./credentials.js";

export function matchesInferenceService(credential: Pick<InferenceCredential, "inferenceUrl">, serviceUrl: string): boolean {
  try {
    const stored = new URL(credential.inferenceUrl);
    const current = new URL(serviceUrl);
    if ([stored, current].some(url => url.username || url.password || url.search || url.hash)) return false;
    return stored.href.replace(/\/+$/, "") === current.href.replace(/\/+$/, "");
  } catch {
    return false;
  }
}
