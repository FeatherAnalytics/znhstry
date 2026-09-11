"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const PAGES = [
  { href: "/", label: "Map" },
  { href: "/atlantis/", label: "Atlantis" },
  { href: "/query/", label: "Query" },
];

const trimSlash = (path: string) => path.replace(/\/+$/, "");

export function SiteNav() {
  const here = trimSlash(usePathname() ?? "");
  return (
    <nav className="site-nav" aria-label="Pages">
      {PAGES.map((page) => (
        <Link
          key={page.href}
          href={page.href}
          aria-current={here === trimSlash(page.href) ? "page" : undefined}
        >
          {page.label}
        </Link>
      ))}
    </nav>
  );
}
