// design-sync shim: `next/navigation` outside a Next.js runtime. Components
// call useRouter()/usePathname() for refresh-after-mutation and active-tab
// logic; here they get browser-backed equivalents so the same compiled
// component renders in the design tool without an App Router mounted.
const loc = () => (typeof window === "undefined" ? null : window.location);

export function useRouter() {
  return {
    push(href: string) { if (loc()) window.location.assign(href); },
    replace(href: string) { if (loc()) window.location.replace(href); },
    refresh() { /* no server components to refresh in a static preview */ },
    back() { if (loc()) window.history.back(); },
    forward() { if (loc()) window.history.forward(); },
    prefetch(_href: string) { /* no-op */ },
  };
}

export function usePathname(): string {
  return loc()?.pathname ?? "/";
}

export function useSearchParams(): URLSearchParams {
  return new URLSearchParams(loc()?.search ?? "");
}

export function useParams<T extends Record<string, string | string[]> = Record<string, string | string[]>>(): T {
  return {} as T;
}

export function redirect(_url: string): never {
  throw new Error("redirect() is not available in the design preview runtime");
}

export function notFound(): never {
  throw new Error("notFound() is not available in the design preview runtime");
}
