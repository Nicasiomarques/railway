// Small, hand-authored line icons per service kind so nodes/lists/settings read at a glance --
// the same iconography pattern Railway and Vercel use for service/resource types -- without
// pulling in an icon library dependency for five glyphs.
export function ServiceKindIcon({ kind, className }: { kind: string; className?: string }) {
  const common = { width: 14, height: 14, viewBox: "0 0 24 24", fill: "none", className };

  switch (kind) {
    case "postgres":
      return (
        <svg {...common}>
          <ellipse cx="12" cy="6" rx="8" ry="3" stroke="currentColor" strokeWidth="2" />
          <path d="M4 6v6c0 1.66 3.58 3 8 3s8-1.34 8-3V6" stroke="currentColor" strokeWidth="2" />
          <path d="M4 12v6c0 1.66 3.58 3 8 3s8-1.34 8-3v-6" stroke="currentColor" strokeWidth="2" />
        </svg>
      );
    case "redis":
      return (
        <svg {...common}>
          <path d="M12 3l8 4-8 4-8-4 8-4z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
          <path d="M4 11l8 4 8-4M4 15l8 4 8-4" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
        </svg>
      );
    case "object_storage":
      return (
        <svg {...common}>
          <rect x="4" y="4" width="16" height="6" rx="1" stroke="currentColor" strokeWidth="2" />
          <rect x="4" y="14" width="16" height="6" rx="1" stroke="currentColor" strokeWidth="2" />
          <circle cx="8" cy="7" r="1" fill="currentColor" />
          <circle cx="8" cy="17" r="1" fill="currentColor" />
        </svg>
      );
    case "worker":
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="2" />
          <path
            d="M19 12a7 7 0 00-.2-1.6l2-1.5-1.6-2.8-2.3.9a7 7 0 00-2.8-1.6L13.6 3h-3.2l-.5 2.4a7 7 0 00-2.8 1.6l-2.3-.9-1.6 2.8 2 1.5A7 7 0 005 12c0 .5.07 1.1.2 1.6l-2 1.5 1.6 2.8 2.3-.9c.8.7 1.8 1.3 2.8 1.6l.5 2.4h3.2l.5-2.4c1-.3 2-.9 2.8-1.6l2.3.9 1.6-2.8-2-1.5c.13-.5.2-1.1.2-1.6z"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinejoin="round"
          />
        </svg>
      );
    case "web":
    default:
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2" />
          <path d="M3 12h18M12 3a14 14 0 010 18 14 14 0 010-18z" stroke="currentColor" strokeWidth="2" />
        </svg>
      );
  }
}
