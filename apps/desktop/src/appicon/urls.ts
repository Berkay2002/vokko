import type { AppIconId } from "./variants";

/** The SVG sources, as URLs for the picker previews (the desktop shell embeds rasters generated from the same files). */
export const ICON_URLS: Record<string, string> = Object.fromEntries(
  Object.entries(import.meta.glob<string>("../../assets/app-icons/*.svg", { eager: true, query: "?url", import: "default" })).map(([path, url]) => [path.slice(path.lastIndexOf("/") + 1, -".svg".length), url]),
);

export const iconUrl = (id: AppIconId): string | undefined => ICON_URLS[id];
