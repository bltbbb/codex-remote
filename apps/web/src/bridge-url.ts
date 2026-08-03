export interface BridgeLocation {
  origin: string;
}

export function resolveBridgeUrls(
  location: BridgeLocation,
  webSocketOverride?: string,
  httpOverride?: string,
): { webSocketUrl: string; httpUrl: string } {
  const origin = location.origin.replace(/\/$/, "");
  return {
    webSocketUrl: webSocketOverride || `${origin.replace(/^http:/, "ws:").replace(/^https:/, "wss:")}/ws`,
    httpUrl: httpOverride || origin,
  };
}
