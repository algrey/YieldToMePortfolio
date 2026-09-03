// design-sync shim: `next/link` outside a Next.js runtime. The design tool
// renders these components without the App Router, so a Link is a plain
// anchor carrying the same href/className/aria props. Next-only props are
// dropped rather than leaked onto the DOM.
import * as React from "react";

type LinkProps = React.AnchorHTMLAttributes<HTMLAnchorElement> & {
  href: string | { pathname?: string; query?: Record<string, string> };
  prefetch?: boolean | null;
  replace?: boolean;
  scroll?: boolean;
  shallow?: boolean;
  locale?: string | false;
  legacyBehavior?: boolean;
  passHref?: boolean;
};

function hrefToString(href: LinkProps["href"]): string {
  if (typeof href === "string") return href;
  const q = href.query ? `?${new URLSearchParams(href.query).toString()}` : "";
  return `${href.pathname ?? ""}${q}`;
}

const Link = React.forwardRef<HTMLAnchorElement, LinkProps>(function Link(
  { href, prefetch, replace, scroll, shallow, locale, legacyBehavior, passHref, children, ...rest },
  ref,
) {
  return (
    <a ref={ref} href={hrefToString(href)} {...rest}>
      {children}
    </a>
  );
});

export default Link;
