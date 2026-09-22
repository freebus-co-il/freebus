import {
  IconArrowLeft,
  IconArrowRight,
  IconChevronLeft,
  IconChevronRight,
  type Icon,
} from '@tabler/icons-react-native';
import { I18nManager } from 'react-native';

/**
 * The arrows, already pointing the way this layout runs.
 *
 * A `mirrored` style with `transform: [{ scaleX: -1 }]` applied under RTL is
 * the wrong tool twice over: the pair already exists in the icon set, and the
 * transform renders nothing at all under genuine RTL, so a back arrow built
 * that way goes blank rather than merely pointing the wrong way.
 *
 * Resolved once at module load, not per render: `I18nManager.isRTL` cannot
 * change without a native restart, which takes this module with it.
 */

/** Points back the way this language came from -- left in English, right in
 *  Hebrew. Every screen's back control. */
export const IconBack: Icon = I18nManager.isRTL ? IconChevronRight : IconChevronLeft;

/** Points onward: the disclosure chevron on a row that opens something. */
export const IconForward: Icon = I18nManager.isRTL ? IconChevronLeft : IconChevronRight;

/** The same direction as `IconForward`, drawn as a full arrow rather than a
 *  chevron -- for a button that names where it goes. */
export const IconArrowForward: Icon = I18nManager.isRTL ? IconArrowLeft : IconArrowRight;
