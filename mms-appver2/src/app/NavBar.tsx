"use client";

import React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";

const NAV_ITEMS = [
  { href: "/", label: "Sensor Panel" },
  { href: "/search", label: "Search Algorithm" },
  { href: "/docs", label: "Docs" },
];

const NavBar: React.FC = () => {
  const pathname = usePathname();

  return (
    <nav style={navStyle}>
      <div style={brandStyle}>MMS</div>
      <div style={linksStyle}>
        {NAV_ITEMS.map((item) => {
          const isActive = pathname === item.href || (item.href !== "/" && pathname.startsWith(item.href));
          return (
            <Link key={item.href} href={item.href} style={{ ...linkStyle, ...(isActive ? activeLinkStyle : {}) }}>
              {item.label}
            </Link>
          );
        })}
      </div>
    </nav>
  );
};

// Inline styles to avoid needing a separate CSS module for the nav
const navStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  padding: "0 2rem",
  height: "48px",
  backgroundColor: "#111",
  color: "#fff",
  fontSize: "0.9rem",
  position: "sticky",
  top: 0,
  zIndex: 9999,
};

const brandStyle: React.CSSProperties = {
  fontWeight: 700,
  fontSize: "1.1rem",
  letterSpacing: "0.05em",
};

const linksStyle: React.CSSProperties = {
  display: "flex",
  gap: "1.5rem",
};

const linkStyle: React.CSSProperties = {
  color: "#ccc",
  textDecoration: "none",
  padding: "4px 0",
  borderBottomWidth: "2px",
  borderBottomStyle: "solid",
  borderBottomColor: "transparent",
  transition: "color 0.2s, border-color 0.2s",
};

const activeLinkStyle: React.CSSProperties = {
  color: "#fff",
  borderBottomColor: "#fff",
};

export default NavBar;
