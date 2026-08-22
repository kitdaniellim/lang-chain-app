// Tabler outline icons, inlined so the app keeps zero icon dependencies.
// One stroke weight for every glyph; colour always follows the text.

interface IconProps {
  className?: string;
  size?: number;
}

function Outline({ className, size = 20, children }: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

/** Tabler "upload": tray, chevron, stem. */
export function UploadIcon(props: IconProps) {
  return (
    <Outline {...props}>
      <path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2 -2v-2" />
      <path d="M7 9l5 -5l5 5" />
      <path d="M12 4v12" />
    </Outline>
  );
}

/** Tabler "file-description": a document with two text lines. */
export function FileIcon(props: IconProps) {
  return (
    <Outline {...props}>
      <path d="M14 3v4a1 1 0 0 0 1 1h4" />
      <path d="M17 21h-10a2 2 0 0 1 -2 -2v-14a2 2 0 0 1 2 -2h7l5 5v11a2 2 0 0 1 -2 2z" />
      <path d="M9 17h6" />
      <path d="M9 13h6" />
    </Outline>
  );
}

/** Tabler "search": lens and handle. */
export function SearchIcon(props: IconProps) {
  return (
    <Outline {...props}>
      <path d="M10 10m-7 0a7 7 0 1 0 14 0a7 7 0 1 0 -14 0" />
      <path d="M21 21l-6 -6" />
    </Outline>
  );
}
