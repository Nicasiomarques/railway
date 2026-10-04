// Small line icons for the sidebar nav -- same hand-authored approach as ServiceKindIcon, so the
// collapsed (icon-only) sidebar stays legible without a new icon library dependency.
export type NavIconName = "projects" | "usage" | "audit" | "new" | "theme" | "sign-out" | "collapse";

export function NavIcon({ name, className }: { name: NavIconName; className?: string }) {
  const common = { width: 15, height: 15, viewBox: "0 0 24 24", fill: "none", className };

  switch (name) {
    case "projects":
      return (
        <svg {...common}>
          <rect x="3" y="7" width="18" height="13" rx="1.5" stroke="currentColor" strokeWidth="2" />
          <path d="M3 7l2-3h5l2 3" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
        </svg>
      );
    case "usage":
      return (
        <svg {...common}>
          <path d="M4 20V10M12 20V4M20 20v-7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
      );
    case "audit":
      return (
        <svg {...common}>
          <path d="M6 3h9l5 5v13a1 1 0 01-1 1H6a1 1 0 01-1-1V4a1 1 0 011-1z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
          <path d="M9 12h6M9 16h6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
      );
    case "new":
      return (
        <svg {...common}>
          <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
      );
    case "theme":
      return (
        <svg {...common}>
          <path
            d="M12 3a9 9 0 109 9c0-.46-.04-.92-.1-1.36A5.5 5.5 0 0112 4.1c0-.37.03-.74.1-1.1z"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinejoin="round"
          />
        </svg>
      );
    case "sign-out":
      return (
        <svg {...common}>
          <path d="M9 21H5a1 1 0 01-1-1V4a1 1 0 011-1h4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M16 17l5-5-5-5M21 12H9" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    case "collapse":
      return (
        <svg {...common}>
          <rect x="3" y="4" width="18" height="16" rx="1.5" stroke="currentColor" strokeWidth="2" />
          <path d="M10 4v16" stroke="currentColor" strokeWidth="2" />
          <path d="M7 10l-1.5 2L7 14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
  }
}
