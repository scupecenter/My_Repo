import { useUiFeatures, type UiFeatures } from './uiFeatures';

/** Contract 0.15.341 (migration 0412): the site map on real tiles, a section of the interface features (Settings > Screens > Map). Off by default. */
export type UiMap = UiFeatures['map'];
export const MAP_SEED: UiMap = { enabled: false, tile_url: '', min_zoom: 0, max_zoom: 18, attribution: '', center_lat: 32.9, center_lon: 13.2, default_zoom: 6 };

export function useMapSettings(): UiMap {
  const d = useUiFeatures().map as Partial<UiMap> | undefined;
  return { ...MAP_SEED, ...d };
}

/** True when the tile layer can be drawn: the switch is on and an address is set. Without it the outline map stays. */
export const tilesOn = (m: UiMap) => m.enabled && m.tile_url !== '';
