import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import {
  Button,
  Icon,
  Layout,
  LeadingIcon,
  ListRow,
  ListSection,
  NativeHeader,
  SegmentedControl,
  Sheet,
  Space,
  Surface,
  Text,
  TextField,
  type IconName,
  useSideInsets,
} from '@/design-system';
import { useCustomJourneys } from '@/features/custom-journeys/custom-journeys-context';
import { expectPointPick, takePointPick } from '@/features/custom-journeys/point-pick-handoff';
import { suggestVia } from '@/features/custom-journeys/suggest-via';
import { newPointId, POINT_VIAS, reversedPoints, type JourneyPoint, type PointVia } from '@/features/custom-journeys/types';
import { useStartCustomJourney } from '@/features/custom-journeys/use-start-custom-journey';
import { placeLabel } from '@/lib/place';

const VIA_ICONS: Record<PointVia, IconName> = { any: 'navigate', walk: 'walk', bus: 'bus', train: 'train' };

/**
 * Builds a journey point by point: home, the stop the rider likes, the
 * station, the other station, work. Each point after the first says how the
 * rider gets there (or leaves it to the planner). Opened with `id` to edit a
 * saved journey, or with `reverseOf` to start the way back from one.
 */
export default function EditCustomJourneyScreen() {
  const { t } = useTranslation();
  const side = useSideInsets();
  const store = useCustomJourneys();
  const { id, reverseOf } = useLocalSearchParams<{ id?: string; reverseOf?: string }>();
  const existing = store.find(id);
  const reversing = existing ? null : store.find(reverseOf);
  const { startJourney, startingId } = useStartCustomJourney();

  const [name, setName] = useState(() =>
    existing?.name ?? (reversing ? t('customJourney.returnName', { name: reversing.name }) : ''));
  const [points, setPoints] = useState<JourneyPoint[]>(() =>
    existing?.points ?? (reversing ? reversedPoints(reversing.points) : []));
  const [editingPointId, setEditingPointId] = useState<string | null>(null);
  // The step INTO this point whose way of travel is being chosen.
  const [editingStepId, setEditingStepId] = useState<string | null>(null);

  // A place chosen in the picker this screen opened (see `point-pick-handoff`).
  useFocusEffect(
    useCallback(() => {
      const pick = takePointPick();
      if (!pick) return;
      setPoints((current) => {
        if (!pick.replacing) {
          // A new point's step starts at the likely way there: a walk to a
          // station nearby, the train between two stations, the bus beyond.
          const last = current[current.length - 1];
          const via = last ? suggestVia(last.place, pick.place) : 'any';
          return [...current, { id: newPointId(), place: pick.place, via }];
        }
        const replaced = current.map((point) => (point.id === pick.replacing ? { ...point, place: pick.place } : point));
        // The steps on either side of a moved point get a suggestion too, but
        // only where the rider had not chosen one.
        return replaced.map((point, index) => {
          const before = replaced[index - 1];
          const touches = point.id === pick.replacing || before?.id === pick.replacing;
          return before && touches && point.via === 'any' ? { ...point, via: suggestVia(before.place, point.place) } : point;
        });
      });
    }, []),
  );

  const pickPlace = (replacing: string | null) => {
    expectPointPick(replacing);
    router.push({ pathname: '/location-picker', params: { field: 'journey-point' } });
  };

  const editingIndex = points.findIndex((point) => point.id === editingPointId);
  const editing = editingIndex >= 0 ? points[editingIndex]! : null;
  const stepIndex = points.findIndex((point) => point.id === editingStepId);
  const editingStep = stepIndex > 0 ? points[stepIndex]! : null;
  const canSave = name.trim().length > 0 && points.length >= 2;

  const update = (pointId: string, change: Partial<JourneyPoint>) =>
    setPoints((current) => current.map((point) => (point.id === pointId ? { ...point, ...change } : point)));
  const move = (from: number, to: number) => setPoints((current) => {
    if (to < 0 || to >= current.length) return current;
    const next = [...current];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved!);
    return next;
  });

  const save = () => {
    if (!canSave) return;
    store.save({ id: existing?.id, name: name.trim(), points });
    router.back();
  };

  const confirmDelete = () => {
    if (!existing) return;
    Alert.alert(t('customJourney.deleteConfirm', { name: existing.name }), undefined, [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('customJourney.delete'),
        style: 'destructive',
        onPress: () => {
          store.remove(existing.id);
          router.back();
        },
      },
    ]);
  };

  const viaLabel = (via: PointVia) => t(`customJourney.via.${via}`);

  return (
    <Surface level="bgGrouped" style={styles.container}>
      <NativeHeader title={t(existing ? 'customJourney.editTitle' : 'customJourney.newTitle')} />
      <SafeAreaView edges={['bottom']} style={[styles.container, { marginStart: side.start, marginEnd: side.end }]}>
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          <TextField
            label={t('customJourney.nameLabel')}
            placeholder={t('customJourney.namePlaceholder')}
            value={name}
            onChangeText={setName}
            returnKeyType="done"
          />

          <View style={styles.section}>
            <ListSection title={t('customJourney.pointsTitle')} footer={t('customJourney.pointsFooter')}>
              {points.flatMap((point, index) => {
                const ends = index === 0 || index === points.length - 1;
                const rows = [];
                if (index > 0) {
                  // The step into this point, between it and the one before:
                  // how the rider travels it, there to be seen and changed.
                  rows.push(
                    <ListRow
                      key={`step:${point.id}`}
                      dense
                      leading={<Icon name={VIA_ICONS[point.via]} size="sm" color={point.via === 'any' ? 'textSecondary' : 'accent'} />}
                      title={
                        <Text variant="footnote" emphasized color={point.via === 'any' ? 'textSecondary' : 'accent'}>
                          {t(`customJourney.step.${point.via}`)}
                        </Text>
                      }
                      accessory="chevron"
                      accessibilityLabel={`${t(`customJourney.step.${point.via}`)}, ${t('customJourney.stepTitle', { name: placeLabel(point.place) })}`}
                      onPress={() => setEditingStepId(point.id)}
                    />,
                  );
                }
                rows.push(
                  <ListRow
                    key={point.id}
                    leading={
                      <LeadingIcon tone={ends ? 'accent' : 'nested'}>
                        <Icon
                          name={point.place.kind === 'stop' ? 'stations' : 'place'}
                          size="sm"
                          color={ends ? 'onAccent' : 'textPrimary'}
                        />
                      </LeadingIcon>
                    }
                    title={placeLabel(point.place)}
                    titleLines={1}
                    subtitle={index === 0
                      ? t('customJourney.startPoint')
                      : index === points.length - 1 ? t('customJourney.destinationPoint') : undefined}
                    accessory="chevron"
                    onPress={() => setEditingPointId(point.id)}
                  />,
                );
                return rows;
              })}
            </ListSection>
            <Button
              variant="secondary"
              icon="add"
              label={t(points.length === 0 ? 'customJourney.addFirstPoint' : 'customJourney.addPoint')}
              onPress={() => pickPlace(null)}
              fullWidth
            />
          </View>

          <View style={styles.section}>
            <Button variant="prominent" label={t('savedLocations.save')} onPress={save} disabled={!canSave} fullWidth />
            {existing && (
              <Button
                variant="secondary"
                icon="navigate"
                label={t('customJourney.start')}
                loading={startingId === existing.id}
                onPress={() => startJourney({ ...existing, name: name.trim() || existing.name, points })}
                disabled={points.length < 2}
                fullWidth
              />
            )}
          </View>

          {existing && (
            <ListSection>
              <ListRow
                leading={<Icon name="swap" />}
                title={t('customJourney.makeReturn')}
                onPress={() => router.replace({ pathname: '/custom-journeys/edit', params: { reverseOf: existing.id } })}
              />
              <ListRow
                leading={<Icon name="delete" color="danger" />}
                title={t('customJourney.delete')}
                destructive
                onPress={confirmDelete}
              />
            </ListSection>
          )}
        </ScrollView>
      </SafeAreaView>

      <Sheet
        visible={editing !== null}
        onClose={() => setEditingPointId(null)}
        title={editing ? placeLabel(editing.place) : undefined}
        closeLabel={t('common.done')}
      >
        {editing && (
          <View style={styles.sheet}>
            <ListSection variant="plain">
              <ListRow
                leading={<Icon name="edit" />}
                title={t('customJourney.changePlace')}
                onPress={() => {
                  setEditingPointId(null);
                  pickPlace(editing.id);
                }}
              />
              {editingIndex > 0 && (
                <ListRow
                  leading={<Icon name="chevronUp" />}
                  title={t('customJourney.moveUp')}
                  onPress={() => move(editingIndex, editingIndex - 1)}
                />
              )}
              {editingIndex < points.length - 1 && (
                <ListRow
                  leading={<Icon name="chevronDown" />}
                  title={t('customJourney.moveDown')}
                  onPress={() => move(editingIndex, editingIndex + 1)}
                />
              )}
              <ListRow
                leading={<Icon name="delete" color="danger" />}
                title={t('customJourney.removePoint')}
                destructive
                onPress={() => {
                  setPoints((current) => current.filter((point) => point.id !== editing.id));
                  setEditingPointId(null);
                }}
              />
            </ListSection>
          </View>
        )}
      </Sheet>

      <Sheet
        visible={editingStep !== null}
        onClose={() => setEditingStepId(null)}
        title={editingStep ? t('customJourney.stepTitle', { name: placeLabel(editingStep.place) }) : undefined}
        closeLabel={t('common.done')}
      >
        {editingStep && (
          <View style={styles.viaBlock}>
            <SegmentedControl
              options={POINT_VIAS.map((via) => ({ value: via, label: viaLabel(via) }))}
              value={editingStep.via}
              onChange={(via) => update(editingStep.id, { via })}
            />
            <View style={styles.viaHint}>
              <Icon name={VIA_ICONS[editingStep.via]} size="sm" color="textSecondary" />
              <Text variant="footnote" color="textSecondary" style={styles.grow}>
                {t(`customJourney.viaHint.${editingStep.via}`)}
              </Text>
            </View>
          </View>
        )}
      </Sheet>
    </Surface>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  content: {
    paddingHorizontal: Layout.pageInset,
    paddingTop: Space.lg,
    paddingBottom: Layout.sectionGap,
    gap: Layout.sectionGap,
  },
  section: {
    gap: Space.md,
  },
  sheet: {
    gap: Space.lg,
  },
  viaBlock: {
    gap: Space.sm,
  },
  viaHint: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Space.sm,
  },
  grow: {
    flex: 1,
  },
});
