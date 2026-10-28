import { useQueryClient } from '@tanstack/react-query';
import { router, useLocalSearchParams } from 'expo-router';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { MapSchemeScope } from '@/components/map-scheme-scope';
import { reverseGeocodeQuery, useReverseGeocode } from '@/api/geocode';
import { useStop, useStopsInTiles } from '@/api/stops';
import type { MapStop } from '@/api/types';
import { LineBadge } from '@/components/line-badge';
import { StationIcon, stationKindOf } from '@/components/station-icon';
import {
  Button,
  Card,
  Glass,
  GlassGroup,
  Icon,
  IconButton,
  Layout,
  MapStyle,
  Size,
  Space,
  Surface,
  Text,
  useColors,
} from '@/design-system';
import { leaveMapPick } from '@/features/map-picker/map-pick-handoff';
import { insideBox, regionBox, stationUnderPin, tilesForRegion, type MapRegion } from '@/features/map-picker/map-tiles';
import { INITIAL_DELTA, PickMap } from '@/features/map-picker/pick-map';
import { useSearch } from '@/features/search/search-context';
import { useDestinationNavigation } from '@/features/search/use-destination-navigation';
import { stationLines } from '@/features/stations/station-vehicle-markers';
import { hapticSettled } from '@/lib/haptics';
import { namedCoordinate } from '@/lib/name-place';
import { placeCoordinates, type SelectedPlace } from '@/lib/place';

/** Where the map opens with no fix and no trip to start from: Tel Aviv, the
 *  middle of where most of the network is. */
const DEFAULT_CENTER = { lat: 32.0853, lon: 34.7818 };

/** See `location-picker`'s constant of the same name. */
const MAX_LINE_BADGES = 6;

/** How far past the visible edges stations are still drawn, as a share of the
 *  view: a short pan reveals signs already standing rather than empty streets
 *  that fill in when the finger lifts. */
const DRAW_MARGIN = 0.5;

/** The floating choose button's height, the gap under it and a little air
 *  above it: where the map's legal label has to move to so the button never
 *  covers it. */
const CHOOSE_PANEL_CLEARANCE = Size.control.lg + Space.md + Space.sm;

const NO_TILES: [] = [];

/**
 * Choosing a place by moving the map under a fixed pin.
 *
 * Opened from the home screen, a pick starts a trip, like the home screen's
 * own field. Opened over the location picker (`from=picker`), it hands the
 * pick back to the picker, which knows why it was opened -- see
 * `map-pick-handoff`.
 *
 * Painted in the map's scheme (`MapSchemeScope`): it sits on the map.
 */
export default function MapPickerScreen() {
  return (
    <MapSchemeScope screen>
      <MapPickerScreenContent />
    </MapSchemeScope>
  );
}

function MapPickerScreenContent() {
  const { t, i18n } = useTranslation();
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const search = useSearch();
  const { from } = useLocalSearchParams<{ from?: string }>();
  const { waitingForOrigin, originFailed, selectDestination } = useDestinationNavigation();

  const [initialCenter] = useState(() => {
    const here = search.originState.status === 'success' ? placeCoordinates(search.originState.place) : null;
    const destination = search.destination ? placeCoordinates(search.destination) : null;
    return here ?? destination ?? DEFAULT_CENTER;
  });
  // Only where the camera came to rest: stations, and the one under the pin,
  // follow a settled map, not every frame of a drag.
  const [region, setRegion] = useState<MapRegion>(() => ({
    latitude: initialCenter.lat,
    longitude: initialCenter.lon,
    latitudeDelta: INITIAL_DELTA,
    longitudeDelta: INITIAL_DELTA,
  }));
  const [moving, setMoving] = useState(false);
  // Where the map draws its centre; until it says, the screen's middle.
  const [centerPoint, setCenterPoint] = useState<{ x: number; y: number } | null>(null);

  const tiles = useMemo(() => tilesForRegion(region), [region]);
  const loaded = useStopsInTiles(tiles ?? NO_TILES, i18n.language);
  const stations = useMemo(() => {
    const drawn = regionBox({
      ...region,
      latitudeDelta: region.latitudeDelta * (1 + 2 * DRAW_MARGIN),
      longitudeDelta: region.longitudeDelta * (1 + 2 * DRAW_MARGIN),
    });
    const byId = new Map<string, MapStop>();
    for (const stop of loaded) if (insideBox(drawn, stop)) byId.set(stop.stopId, stop);
    // A stable order, so a new tile arriving inserts markers rather than
    // reshuffling the ones already on the map.
    return [...byId.values()].sort((a, b) => a.stopId.localeCompare(b.stopId));
  }, [loaded, region]);

  const underPin = stationUnderPin({ lat: region.latitude, lon: region.longitude }, stations);
  const { data: stopDetail } = useStop(underPin?.stopId ?? null, i18n.language);
  const lines = underPin !== null && stopDetail?.stopId === underPin.stopId ? stationLines(stopDetail.routes) : [];

  // What the pin is standing on when it is not standing on a station: asked
  // once the map settles, not while it travels, so a drag is not a lookup per
  // frame. Reverse geocoding is answered by the self-hosted Photon whatever
  // the address-search backend is, so this costs nothing per pick -- which is
  // what makes naming the pin affordable at all. Skipped entirely over a
  // station: that already has a name, and a better one than its street.
  const pinAt = { lat: region.latitude, lon: region.longitude };
  const { data: pinPlace } = useReverseGeocode(pinAt, i18n.language, underPin === null);
  // Only ever true when the rider taps Choose before the lookup above has
  // answered -- usually it is already in cache and the tap is instant.
  const [naming, setNaming] = useState(false);
  const queryClient = useQueryClient();

  function commit(place: SelectedPlace) {
    if (from === 'picker') {
      leaveMapPick(place);
      router.back();
      return;
    }
    selectDestination(place);
  }

  /**
   * A point on the map is committed as an ADDRESS, not as "Pinned location":
   * the rider reads this name back on the results screen, in a recent trip,
   * and in a saved place, and a placeholder tells them nothing about which
   * pin they dropped.
   *
   * `fetchQuery` rather than the hook's data so a tap that beats the lookup
   * waits for it instead of settling for the placeholder; it returns straight
   * from cache in the ordinary case, where the map settled first. The
   * placeholder survives only as `namedCoordinate`'s fallback, for a geocoder
   * that is down or knows nothing about this spot.
   */
  async function choose() {
    if (underPin !== null) {
      commit({ kind: 'stop', stopId: underPin.stopId, name: underPin.name ?? underPin.stopId, lat: underPin.lat, lon: underPin.lon });
      return;
    }

    setNaming(true);
    try {
      commit(await namedCoordinate(
        pinAt,
        async () => (await queryClient.fetchQuery(reverseGeocodeQuery(pinAt, i18n.language)))?.label ?? null,
        t('search.pinnedLocation'),
      ));
    } finally {
      setNaming(false);
    }
  }

  return (
    <Surface level="bgPlain" style={styles.container}>
      {/* The whole screen, so the map's centre -- the pick -- is the screen's
          centre too, and everything else floats over it. */}
      <PickMap
        style={StyleSheet.absoluteFill}
        initialCenter={initialCenter}
        stations={stations}
        legalLabelBottomInset={insets.bottom + CHOOSE_PANEL_CLEARANCE}
        onCenterPoint={setCenterPoint}
        onMoveStart={() => setMoving(true)}
        onMoveEnd={(next) => {
          // The pin lifts while the map travels and drops when it stops --
          // this is that landing, and the moment the coordinate under it
          // becomes the one "Choose" would take. `onMoveEnd` only: a buzz
          // per frame of the drag would be unusable.
          hapticSettled();
          setMoving(false);
          setRegion(next);
        }}
      />

      {/* The pick itself: the map's centre, so it is the screen's and not a
          marker. The frame is twice the pin's height with the pin in its top
          half, so the stem's tip lands exactly on the centre; the ground dot
          stays put there while the pin lifts during a move. Ink with the
          map-marker ring, like every other marker on a map. */}
      {/* At the point the map reports, which is physical: `left`, not `start`. */}
      <View
        pointerEvents="none"
        style={centerPoint === null
          ? styles.pinLayer
          : [styles.pinAt, { left: centerPoint.x - PIN_BOX_WIDTH / 2, top: centerPoint.y - PIN_BOX_HEIGHT / 2 }]}
      >
        <View style={[styles.groundDot, { backgroundColor: colors.textPrimary, borderColor: colors.mapMarkerRing }]} />
        <View style={[styles.pinFrame, moving && styles.pinLifted]}>
          <View style={[styles.pinHead, { backgroundColor: colors.textPrimary, borderColor: colors.mapMarkerRing }]}>
            <View style={[styles.pinEye, { backgroundColor: colors.mapMarkerRing }]} />
          </View>
          <View style={[styles.pinStem, { backgroundColor: colors.textPrimary }]} />
          <View style={styles.pinSpacer} />
        </View>
      </View>

      <View pointerEvents="box-none" style={[styles.topBar, { top: insets.top + Space.sm }]}>
        <GlassGroup spacing={Space.sm} style={styles.topRow}>
          <IconButton icon="chevronBack" variant="glass" accessibilityLabel={t('common.back')} onPress={() => router.back()} />
          {/* What the pin is on, as a glass capsule in the search field's
              place: this screen is the other way to fill that field. A label,
              not an input -- the map is what the rider moves. */}
          <Glass shape="capsule" style={styles.field}>
            {underPin !== null ? (
              <StationIcon kind={stationKindOf(underPin)} />
            ) : (
              <Icon name="pin" size="md" weight="medium" />
            )}
            <View style={styles.fieldText}>
              <Text variant="body" emphasized numberOfLines={1}>
                {underPin !== null
                  ? underPin.name ?? underPin.stopId
                  : pinPlace?.label ?? t('mapPicker.locationOnMap')}
              </Text>
              {lines.length > 0 && (
                <View style={styles.lineRow}>
                  {lines.slice(0, MAX_LINE_BADGES).map((line) => (
                    <LineBadge key={`${line.agencyId}:${line.shortName}:${line.type}`} route={line} size="small" />
                  ))}
                  {lines.length > MAX_LINE_BADGES && (
                    <Text variant="footnote" color="textSecondary" numeric>
                      {t('search.moreLines', { count: lines.length - MAX_LINE_BADGES })}
                    </Text>
                  )}
                </View>
              )}
            </View>
          </Glass>
        </GlassGroup>
        {tiles === null && (
          <Glass shape="capsule" style={styles.hint}>
            <Text variant="subheadline">{t('mapPicker.zoomInForStations')}</Text>
          </Glass>
        )}
      </View>

      {/* The confirm button floats on the map by itself: Liquid Glass on
          iOS 26 (`prominent` is tinted glass there), a filled button on
          Android. No card around it -- a panel holding one button was a
          frame around a frame. Only the location notice, which is content,
          gets a solid card, and only when there is something to say. */}
      <View pointerEvents="box-none" style={[styles.bottomPanel, { bottom: insets.bottom + Space.md }]}>
        {originFailed && (
          <Card variant="floating" style={styles.notice}>
            <Text variant="subheadline" color="textSecondary">
              {t(
                search.originState.status === 'error' && search.originState.message === 'location_permission_denied'
                  ? 'search.locationPermissionDenied'
                  : 'search.locationUnavailable',
              )}
            </Text>
            <Button
              variant="plain"
              size="sm"
              label={t('search.chooseOrigin')}
              onPress={() => router.push({ pathname: '/location-picker', params: { field: 'origin', andPlan: '1' } })}
            />
          </Card>
        )}
        <Button
          variant="prominent"
          fullWidth
          label={t(underPin !== null ? 'mapPicker.chooseStation' : 'mapPicker.chooseLocation')}
          onPress={() => void choose()}
          disabled={moving}
          loading={waitingForOrigin || naming}
        />
      </View>
    </Surface>
  );
}

// Pin geometry: the drawn shape of the pick, not layout rhythm.
const PIN_HEAD = 30;
const PIN_STEM = 14;
const PIN_STEM_WIDTH = 3;
const PIN_EYE = 8;
const GROUND_DOT = 10;
/** How far the pin rises off its ground dot while the map travels. */
const PIN_LIFT = 10;
/** The pin's frame: its head's width, and twice head-plus-stem tall (the stem
 *  overlaps the head by a point), so the tip is its middle. */
const PIN_BOX_WIDTH = PIN_HEAD;
const PIN_BOX_HEIGHT = 2 * (PIN_HEAD + PIN_STEM - 1);

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  pinLayer: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    start: 0,
    end: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
  // The pin's own box, placed so its middle -- the stem's tip -- is the map's
  // reported centre. Sized rather than a zero-size box the pin overflows:
  // Yoga did not centre the overflowing pin vertically, and it stood 44pt low.
  pinAt: {
    position: 'absolute',
    width: PIN_BOX_WIDTH,
    height: PIN_BOX_HEIGHT,
    alignItems: 'center',
    justifyContent: 'center',
  },
  groundDot: {
    position: 'absolute',
    width: GROUND_DOT,
    height: GROUND_DOT,
    borderRadius: GROUND_DOT / 2,
    borderWidth: MapStyle.markerRingWidthSecondary,
  },
  pinFrame: {
    alignItems: 'center',
  },
  // Lifted off the ground dot while the map travels: the pick is not made yet.
  pinLifted: {
    transform: [{ translateY: -PIN_LIFT }],
  },
  pinHead: {
    width: PIN_HEAD,
    height: PIN_HEAD,
    borderRadius: PIN_HEAD / 2,
    borderWidth: MapStyle.markerRingWidth,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pinEye: {
    width: PIN_EYE,
    height: PIN_EYE,
    borderRadius: PIN_EYE / 2,
  },
  pinStem: {
    width: PIN_STEM_WIDTH,
    height: PIN_STEM,
    marginTop: -1,
  },
  pinSpacer: {
    height: PIN_HEAD + PIN_STEM - 1,
  },
  topBar: {
    position: 'absolute',
    start: Layout.pageInset,
    end: Layout.pageInset,
    gap: Space.sm,
  },
  // Top-aligned: a station's line badges make the field taller, and the back
  // button must not stretch or drift with them.
  topRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: Space.sm,
  },
  field: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: Space.sm,
    minHeight: Size.control.md,
    paddingHorizontal: Space.lg,
    paddingVertical: Space.sm,
  },
  fieldText: {
    flex: 1,
    gap: Space.xs,
  },
  lineRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Space.xs,
  },
  hint: {
    alignSelf: 'center',
    paddingHorizontal: Space.md,
    paddingVertical: Space.sm,
  },
  bottomPanel: {
    position: 'absolute',
    start: Layout.pageInset,
    end: Layout.pageInset,
    gap: Space.md,
  },
  notice: {
    gap: Space.xs,
  },
});
