<script lang="ts">
  import ImageThumbnail from '$lib/components/assets/thumbnail/ImageThumbnail.svelte';
  import { assetViewerManager } from '$lib/managers/asset-viewer-manager.svelte';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { Route } from '$lib/route';
  import { locale } from '$lib/stores/preferences.store';
  import { getPeopleThumbnailUrl } from '$lib/utils';
  import { handleError } from '$lib/utils/handle-error';
  import { type AssetResponseDto } from '@immich/sdk';
  import { IconButton, Text } from '@immich/ui';
  import { mdiEye, mdiEyeOff, mdiPencil, mdiPlus } from '@mdi/js';
  import { DateTime } from 'luxon';
  import { t } from 'svelte-i18n';

  type Props = {
    asset: AssetResponseDto;
    isOwner: boolean;
    previousRoute: string;
    onRefresh?: () => void | Promise<void>;
  };

  const { asset, isOwner, previousRoute, onRefresh }: Props = $props();

  // Detach all faces of this person from the current asset. The faces stay on
  // the photo (bounding box, embedding) but are no longer linked to anyone, so
  // the person tile disappears from this asset's people grid.
  const handleRemovePersonFromAsset = async (event: MouseEvent, faces: ReadonlyArray<{ id: string }>) => {
    event.preventDefault();
    event.stopPropagation();
    try {
      await Promise.all(
        faces.map((face) =>
          fetch(`/api/faces/${face.id}/person`, { method: 'DELETE' }).then((response) => {
            if (!response.ok) {
              throw new Error(`Failed to unassign face ${face.id}: ${response.status}`);
            }
          }),
        ),
      );
      await onRefresh?.();
    } catch (error) {
      handleError(error, $t('errors.cant_apply_changes'));
    }
  };

  const unassignedFaces = $derived(asset.unassignedFaces || []);
  const people = $derived(asset.people || []);
  const visiblePeople = $derived(
    people
      .filter((p) => assetViewerManager.isShowingHiddenPeople || !p.isHidden)
      .map((person) => {
        if (!person.birthDate) {
          return { formattedBirthDate: undefined, formattedAge: undefined, ...person };
        }
        const personBirthDate = DateTime.fromISO(person.birthDate);
        const ageInYears = Math.floor(DateTime.fromISO(asset.localDateTime).diff(personBirthDate, 'years').years);
        const ageInMonths = Math.floor(DateTime.fromISO(asset.localDateTime).diff(personBirthDate, 'months').months);

        let formattedAge;
        if (ageInYears < 0) {
          return { formattedBirthDate: undefined, formattedAge: undefined, ...person };
        } else if (ageInMonths < 12) {
          formattedAge = $t('age_months', { values: { months: ageInMonths } });
        } else if (ageInMonths > 12 && ageInMonths < 24) {
          formattedAge = $t('age_year_months', { values: { months: ageInMonths - 12 } });
        } else {
          formattedAge = $t('age_years', { values: { years: ageInYears } });
        }

        const formattedBirthDate = personBirthDate.toLocaleString(
          {
            month: 'long',
            day: 'numeric',
            year: 'numeric',
          },
          { locale: $locale },
        );
        return { formattedBirthDate, formattedAge, ...person };
      }),
  );
</script>

{#if !authManager.isSharedLink && isOwner}
  <section class="px-4 pt-4 text-sm">
    <div class="flex h-10 w-full items-center justify-between">
      <Text size="small" color="muted">{$t('people')}</Text>
      <div class="flex items-center gap-2">
        {#if people.some((person) => person.isHidden)}
          <IconButton
            aria-label={$t('show_hidden_people')}
            icon={assetViewerManager.isShowingHiddenPeople ? mdiEyeOff : mdiEye}
            size="medium"
            shape="round"
            color="secondary"
            variant="ghost"
            onclick={() => assetViewerManager.toggleHiddenPeople()}
          />
        {/if}
        <IconButton
          aria-label={$t('tag_people')}
          icon={mdiPlus}
          size="medium"
          shape="round"
          color="secondary"
          variant="ghost"
          onclick={() => assetViewerManager.toggleFaceEditMode()}
        />

        {#if people.length > 0 || unassignedFaces.length > 0}
          <IconButton
            aria-label={$t('edit_people')}
            icon={mdiPencil}
            size="medium"
            shape="round"
            color="secondary"
            variant="ghost"
            onclick={() => assetViewerManager.openEditFacesPanel()}
          />
        {/if}
      </div>
    </div>

    <div class="mt-2 grid {visiblePeople.length <= 6 ? 'grid-cols-3 gap-3' : 'grid-cols-4 gap-2'}">
      {#each visiblePeople as person (person.id)}
        {@const isHighlighted = person.faces.some((f) =>
          assetViewerManager.highlightedFaces.some((b) => b.id === f.id),
        )}
        <a
          class="group relative outline-none"
          href={Route.viewPerson(person, { previousRoute })}
          onfocus={() => assetViewerManager.setHighlightedFaces(person.faces)}
          onblur={() => assetViewerManager.clearHighlightedFaces()}
          onpointerenter={() => assetViewerManager.setHighlightedFaces(person.faces)}
          onpointerleave={() => assetViewerManager.clearHighlightedFaces()}
        >
          <ImageThumbnail
            curve
            shadow
            url={getPeopleThumbnailUrl(person)}
            altText={person.name}
            title={person.name}
            widthStyle="100%"
            hidden={person.isHidden}
            highlighted={isHighlighted}
            class="outline-offset-2 outline-immich-primary group-focus-visible:outline-2 dark:outline-immich-dark-primary"
          />
          {#if isOwner && person.faces.length > 0}
            <button
              type="button"
              class="absolute top-1 right-1 hidden h-7 w-7 cursor-pointer items-center justify-center rounded-full bg-black/30 opacity-0 transition-opacity hover:bg-black/50 focus:bg-black/50 focus:opacity-100 focus:outline-none group-hover:flex group-hover:opacity-100"
              aria-label={$t('remove')}
              title={$t('remove')}
              onclick={(event) => handleRemovePersonFromAsset(event, person.faces)}
            >
              <!--
                Two pairs of <line>s: the first pair draws a wider black outline,
                the second pair draws the white X on top with stroke-width=5 so
                the white "bars" of the cross render at ~5px.
                viewBox is 24x24 and the rendered icon size is h-6 w-6 (24px),
                so 1 svg unit ≈ 1 css px.
              -->
              <svg viewBox="0 0 24 24" class="h-6 w-6" aria-hidden="true">
                <line x1="6" y1="6" x2="18" y2="18" stroke="black" stroke-width="9" stroke-linecap="round" />
                <line x1="18" y1="6" x2="6" y2="18" stroke="black" stroke-width="9" stroke-linecap="round" />
                <line x1="6" y1="6" x2="18" y2="18" stroke="white" stroke-width="5" stroke-linecap="round" />
                <line x1="18" y1="6" x2="6" y2="18" stroke="white" stroke-width="5" stroke-linecap="round" />
              </svg>
            </button>
          {/if}
          <p class="mt-1 truncate font-medium" title={person.name}>{person.name}</p>
          {#if person.birthDate && person.formattedAge}
            <p class="font-light {visiblePeople.length > 6 ? 'text-xs' : ''}" title={person.formattedBirthDate!}>
              {person.formattedAge}
            </p>
          {/if}
        </a>
      {/each}
    </div>

    {#if unassignedFaces.length > 0}
      <!--
        Recognised faces that aren't currently attached to any person — either
        never had one, or were just detached via the X button on a person tile.
        Render them as their own grid so the face doesn't visually disappear
        from the asset after unassignment.
      -->
      <div
        class="mt-4 grid {unassignedFaces.length <= 6 ? 'grid-cols-3 gap-3' : 'grid-cols-4 gap-2'}"
      >
        {#each unassignedFaces as face (face.id)}
          {@const isHighlighted = assetViewerManager.highlightedFaces.some((b) => b.id === face.id)}
          <button
            type="button"
            class="group flex flex-col items-stretch text-left outline-none"
            title={$t('no_name')}
            onclick={() => assetViewerManager.openEditFacesPanel()}
            onfocus={() => assetViewerManager.setHighlightedFaces([face])}
            onblur={() => assetViewerManager.clearHighlightedFaces()}
            onpointerenter={() => assetViewerManager.setHighlightedFaces([face])}
            onpointerleave={() => assetViewerManager.clearHighlightedFaces()}
          >
            <img
              src={`/api/faces/${face.id}/thumbnail?v=2`}
              alt={$t('no_name')}
              loading="lazy"
              class="aspect-square w-full rounded-xl bg-gray-200 object-cover shadow dark:bg-gray-800 {isHighlighted
                ? 'outline outline-2 outline-offset-2 outline-immich-primary dark:outline-immich-dark-primary'
                : ''}"
            />
            <p class="mt-1 truncate text-sm font-light text-gray-500 dark:text-gray-400">{$t('no_name')}</p>
          </button>
        {/each}
      </div>
    {/if}
  </section>
{/if}
