import type { ReactNode, SVGProps } from 'react';

type IconProps = Omit<SVGProps<SVGSVGElement>, 'children'>;

function IconBase({ children, ...props }: IconProps & { children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      data-stroke="1.6"
      aria-hidden="true"
      {...props}
    >
      {children}
    </svg>
  );
}

export const RectangleIcon = (props: IconProps) => <IconBase {...props}><rect x="4" y="4" width="16" height="16" /></IconBase>;
export const EllipseIcon = (props: IconProps) => <IconBase {...props}><circle cx="12" cy="12" r="8" /></IconBase>;
export const EmojiIcon = (props: IconProps) => <IconBase {...props}><circle cx="12" cy="12" r="8" /><path d="M8 14c2 2 6 2 8 0M9 9h.01M15 9h.01" /></IconBase>;
export const ArrowIcon = (props: IconProps) => <IconBase {...props}><path d="M5 19 19 5M11 5h8v8" /></IconBase>;
export const PenIcon = (props: IconProps) => <IconBase {...props}><path d="m5 19 4-1 10-10-3-3L6 15l-1 4Z" /></IconBase>;
export const MosaicIcon = (props: IconProps) => <IconBase {...props}><path d="M4 4h16v16H4zM7 7h3v3H7zM14 7h3v3h-3zM7 14h3v3H7zM14 14h3v3h-3z" /></IconBase>;
export const TextIcon = (props: IconProps) => <IconBase {...props}><rect x="5" y="4" width="14" height="16" /><path d="M8 8h8M12 8v9" /></IconBase>;
export const PrivacyIcon = (props: IconProps) => <IconBase {...props}><rect x="4" y="8" width="10" height="10" /><rect x="10" y="4" width="10" height="10" /><path d="m15 6 .7 1.6 1.8.2-1.3 1.2.4 1.8-1.6-.9-1.6.9.4-1.8-1.3-1.2 1.8-.2Z" /></IconBase>;
export const OcrIcon = (props: IconProps) => <IconBase {...props}><path d="M5 8V5h3M16 5h3v3M19 16v3h-3M8 19H5v-3M9 16l3-8 3 8M10 13h4" /></IconBase>;
export const ScrollIcon = (props: IconProps) => <IconBase {...props}><rect x="6" y="3" width="12" height="18" strokeDasharray="2 2" /><path d="m9 8 3-3 3 3M12 5v14m-3-3 3 3 3-3" /></IconBase>;
export const UndoIcon = (props: IconProps) => <IconBase {...props}><path d="M9 7 5 11l4 4M5 11h8a6 6 0 0 1 6 6" /></IconBase>;
export const SaveIcon = (props: IconProps) => <IconBase {...props}><path d="M5 4h14v16H5zM8 4v5h8V4M9 17h6" /></IconBase>;
export const PinIcon = (props: IconProps) => <IconBase {...props}><path d="M12 3v12M8 7l4-4 4 4M6 15h12v6H6z" /></IconBase>;
export const ShareIcon = (props: IconProps) => <IconBase {...props}><path d="m5 12 7-7v4c5 0 7 3 7 8-2-3-4-4-7-4v4l-7-5Z" /></IconBase>;
export const CancelIcon = (props: IconProps) => <IconBase {...props}><path d="m6 6 12 12M18 6 6 18" /></IconBase>;
export const CompleteIcon = (props: IconProps) => <IconBase {...props}><path d="m5 12 4 4L19 6" /></IconBase>;
