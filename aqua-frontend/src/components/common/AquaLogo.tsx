import { cn } from '@/lib/utils';

interface AquaLogoProps {
  /** Rendered width/height in pixels (square). Default 24. */
  size?: number;
  className?: string;
  alt?: string;
}

/**
 * Official AQUA logo mark — the single source of truth for the brand mark
 * everywhere it appears (sidebar, welcome screen, message avatar, settings,
 * header, …). Replaces the old hardcoded gradient-square "AQ" text badge.
 *
 * Source: `public/favicon-96x96.png`. Of the assets exported alongside it
 * (favicon.svg, apple-touch-icon.png, the 192/512 PWA icons), this is the
 * only one with a genuinely transparent background — the others bake in a
 * solid white backdrop (required for iOS/maskable PWA icons), which would
 * render as a white box over our colored gradient chips. 96px is a clean 2x
 * for the largest badge this fills (48px), so it stays crisp everywhere it's
 * used. The mark itself is a circle inscribed edge-to-edge in that canvas,
 * so it's already symmetric — plain flex centering is enough, no offset
 * correction needed for the transparent corners.
 */
export function AquaLogo({ size = 24, className, alt = 'AQUA' }: AquaLogoProps) {
  return (
    <img
      src={`${import.meta.env.BASE_URL}favicon-96x96.png`}
      width={size}
      height={size}
      alt={alt}
      draggable={false}
      className={cn('shrink-0 select-none object-contain', className)}
      style={{ width: size, height: size, minWidth: size, minHeight: size }}
    />
  );
}
