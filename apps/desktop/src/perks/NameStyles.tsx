import type { CSSProperties, ReactNode } from "react";
import type { DisplayNameStyles } from "../api/types";
import { intToHex, nameEffectById, nameFontById, nameplateById } from "./catalog";
import "./name-styles.css";

/**
 * A nameplate: the art behind a user's row in the member list and the DM list. Mount it as the first child of a row that has the
 * `has-nameplate` class (which makes the row the positioning box and clips the plate). Vokko's own set (src/perks/catalog.ts).
 */
export function Nameplate({ id }: { id: string | null | undefined }) {
  const def = nameplateById(id);
  if (!def) return null;
  const style = { ["--np-gradient" as string]: `linear-gradient(90deg, ${def.colors.join(", ")})` } as CSSProperties;
  return (
    <span className={`nameplate${def.pattern ? ` np-${def.pattern}` : ""}${def.sheen ? " np-sheen" : ""}`} style={style} aria-hidden="true" data-nameplate={def.id} />
  );
}

/** Class names for a row that may carry a nameplate. */
export const nameplateRowClass = (id: string | null | undefined): string => (nameplateById(id) ? " has-nameplate" : "");

/** Inline style and class of a styled display name; empty when the user has no (known) style. */
export function nameStyleProps(styles: DisplayNameStyles | null | undefined): { className: string; style?: CSSProperties } {
  if (!styles) return { className: "" };
  const font = nameFontById(styles.font_id);
  const effect = nameEffectById(styles.effect_id);
  if (!font && !effect) return { className: "" };
  const [first, second] = styles.colors;
  const a = first !== undefined ? intToHex(first) : undefined;
  const b = second !== undefined ? intToHex(second) : a;
  const style: CSSProperties = {};
  if (font) {
    style.fontFamily = font.family;
    if (font.weight) style.fontWeight = font.weight;
    if (font.spacing) style.letterSpacing = `${font.spacing}em`;
    if (font.uppercase) style.textTransform = "uppercase";
  }
  if (a) (style as Record<string, string>)["--dn-a"] = a;
  if (b) (style as Record<string, string>)["--dn-b"] = b;
  return { className: ` styled-name${effect ? ` dn-${effect.id}` : ""}`, style };
}

/**
 * A display name in the user's chosen font, effect and colours. With no style the name renders as given (role colour and all); a style
 * replaces the role colour, like Discord's display name styles. `data-text` lets effects layer a copy of the text (glitch).
 */
export function StyledName({ styles, children, className = "", style }: { styles: DisplayNameStyles | null | undefined; children: ReactNode; className?: string; style?: CSSProperties }) {
  const styled = nameStyleProps(styles);
  if (!styled.className) return <span className={className || undefined} style={style}>{children}</span>;
  return (
    <span className={`${className}${styled.className}`} style={{ ...style, ...styled.style, color: undefined }} data-text={typeof children === "string" ? children : undefined}>
      <span className="styled-name-text">{children}</span>
    </span>
  );
}
