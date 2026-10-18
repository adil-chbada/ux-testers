// Dev-only guard. A tester may browse only a local dev host. The app's production domains (apps/<app>/app.yaml
// prod_domains) are also blocked at DNS level (see blockedHostRules), so a redirect or a script cannot reach them,
// and a navigation to one stops the run.

let prodDomains: string[] = [];

/** The production domains of the app under test; set once from its app.yaml. */
export function setProdDomains(domains: string[]) {
  prodDomains = domains.map((d) => d.toLowerCase().replace(/^\*\.|\.$/g, ""));
}

const LOCAL = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function isProdHost(host: string): boolean {
  host = host.toLowerCase().replace(/\.$/, "");
  return prodDomains.some((d) => host === d || host.endsWith("." + d));
}

export function isDevUrl(url: string | URL): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  const host = u.hostname.toLowerCase();
  if (isProdHost(host)) return false;
  return LOCAL.has(host) || host.endsWith(".localhost") || host.endsWith(".test");
}

/** Chromium --host-resolver-rules value that makes every production host fail to resolve ("" when there are none). */
export function blockedHostRules(): string {
  return prodDomains.flatMap((d) => [`MAP ${d} ~NOTFOUND`, `MAP *.${d} ~NOTFOUND`]).join(", ");
}
