/**
 * The icons a Mission can have, by key (mission_profiles.icon). A new Mission
 * gets one from its id, so two side by side are told apart before anyone
 * picks.
 */

import {
  Anchor,
  Atom,
  Compass,
  Flag,
  Flame,
  Gem,
  Hexagon,
  type LucideIcon,
  Mountain,
  Orbit,
  Radar,
  Rocket,
  Satellite,
  Shield,
  Target,
  Telescope,
} from "lucide-react";

export const MISSION_ICONS: { key: string; label: string; Icon: LucideIcon }[] = [
  { key: "rocket", label: "Rocket", Icon: Rocket },
  { key: "compass", label: "Compass", Icon: Compass },
  { key: "satellite", label: "Satellite", Icon: Satellite },
  { key: "telescope", label: "Telescope", Icon: Telescope },
  { key: "orbit", label: "Orbit", Icon: Orbit },
  { key: "radar", label: "Radar", Icon: Radar },
  { key: "target", label: "Target", Icon: Target },
  { key: "flag", label: "Flag", Icon: Flag },
  { key: "shield", label: "Shield", Icon: Shield },
  { key: "atom", label: "Atom", Icon: Atom },
  { key: "gem", label: "Gem", Icon: Gem },
  { key: "flame", label: "Flame", Icon: Flame },
  { key: "mountain", label: "Mountain", Icon: Mountain },
  { key: "anchor", label: "Anchor", Icon: Anchor },
  { key: "hexagon", label: "Hexagon", Icon: Hexagon },
];

/** The Mission's icon: the one picked, else one from its id. */
export function missionIcon(id: string, picked: string | null): (typeof MISSION_ICONS)[number] {
  const chosen = picked ? MISSION_ICONS.find((i) => i.key === picked) : undefined;
  if (chosen) return chosen;
  let hash = 0;
  for (const c of id) hash = (hash * 31 + c.charCodeAt(0)) >>> 0;
  return MISSION_ICONS[hash % MISSION_ICONS.length];
}
