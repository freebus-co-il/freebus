import type { ActiveJourney } from '../types';
import { backboneOf } from './backbone';

/**
 * The backbone is captured when the journey starts, and kept through every
 * re-plan after -- a splice must never redefine what the rider chose. A
 * journey stored before backbones existed gets one from its itinerary as it
 * stands, which is the closest thing to what they chose that is left.
 */
export function withBackbone(journey: ActiveJourney): ActiveJourney {
  if (journey.backbone !== undefined) return journey;
  return { ...journey, backbone: backboneOf(journey.itinerary)?.backbone ?? null };
}
