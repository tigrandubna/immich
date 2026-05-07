<script lang="ts">
  import { afterNavigate, goto, invalidateAll } from '$app/navigation';
  import { page } from '$app/stores';
  import { clickOutside } from '$lib/actions/click-outside';
  import { listNavigation } from '$lib/actions/list-navigation';
  import { scrollMemoryClearer } from '$lib/actions/scroll-memory';
  import ImageThumbnail from '$lib/components/assets/thumbnail/ImageThumbnail.svelte';
  import EditNameInput from './EditNameInput.svelte';
  import MergeFaceSelector from './MergeFaceSelector.svelte';
  import UnmergeFaceSelector from './UnmergeFaceSelector.svelte';
  import OnEvents from '$lib/components/OnEvents.svelte';
  import ButtonContextMenu from '$lib/components/shared-components/context-menu/ButtonContextMenu.svelte';
  import MenuOption from '$lib/components/shared-components/context-menu/MenuOption.svelte';
  import ControlAppBar from '$lib/components/shared-components/ControlAppBar.svelte';
  import ArchiveAction from '$lib/components/timeline/actions/ArchiveAction.svelte';
  import ChangeDate from '$lib/components/timeline/actions/ChangeDateAction.svelte';
  import ChangeDescription from '$lib/components/timeline/actions/ChangeDescriptionAction.svelte';
  import ChangeLocation from '$lib/components/timeline/actions/ChangeLocationAction.svelte';
  import CreateSharedLink from '$lib/components/timeline/actions/CreateSharedLinkAction.svelte';
  import DeleteAssets from '$lib/components/timeline/actions/DeleteAssetsAction.svelte';
  import DownloadAction from '$lib/components/timeline/actions/DownloadAction.svelte';
  import FavoriteAction from '$lib/components/timeline/actions/FavoriteAction.svelte';
  import SelectAllAssets from '$lib/components/timeline/actions/SelectAllAction.svelte';
  import SetVisibilityAction from '$lib/components/timeline/actions/SetVisibilityAction.svelte';
  import TagAction from '$lib/components/timeline/actions/TagAction.svelte';
  import AssetSelectControlBar from '$lib/components/timeline/AssetSelectControlBar.svelte';
  import Timeline from '$lib/components/timeline/Timeline.svelte';
  import { PersonPageViewMode, QueryParameter, SessionStorageKey } from '$lib/constants';
  import { assetMultiSelectManager } from '$lib/managers/asset-multi-select-manager.svelte';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { TimelineManager } from '$lib/managers/timeline-manager/timeline-manager.svelte';
  import type { TimelineAsset } from '$lib/managers/timeline-manager/types';
  import PersonMergeSuggestionModal from '$lib/modals/PersonMergeSuggestionModal.svelte';
  import { Route } from '$lib/route';
  import { getAssetBulkActions } from '$lib/services/asset.service';
  import { getPersonActions } from '$lib/services/person.service';
  import { locale } from '$lib/stores/preferences.store';
  import { websocketEvents } from '$lib/stores/websocket';
  import { getPeopleThumbnailUrl } from '$lib/utils';
  import { handleError } from '$lib/utils/handle-error';
  import { isExternalUrl } from '$lib/utils/navigation';
  import { AssetVisibility, searchPerson, updatePerson, type PersonResponseDto } from '@immich/sdk';
  import {
    ActionButton,
    CommandPaletteDefaultProvider,
    ContextMenuButton,
    IconButton,
    LoadingSpinner,
    modalManager,
    toastManager,
    type ActionItem,
  } from '@immich/ui';
  import {
    mdiAccountBoxOutline,
    mdiAccountMultipleCheckOutline,
    mdiArrowLeft,
    mdiDotsVertical,
    mdiFaceMan,
    mdiImageMultiple,
    mdiShareVariantOutline,
  } from '@mdi/js';
  import { DateTime } from 'luxon';
  import { onMount } from 'svelte';
  import { t } from 'svelte-i18n';
  import type { PageData } from './$types';

  interface Props {
    data: PageData;
  }

  let { data }: Props = $props();

  let numberOfAssets = $derived(data.statistics.assets);
  let person = $derived(data.person);
  let thumbnailData = $derived(getPeopleThumbnailUrl(person));

  let timelineManager = $state<TimelineManager>() as TimelineManager;
  const options = $derived({ visibility: AssetVisibility.Timeline, personId: data.person.id });

  let viewMode: PersonPageViewMode = $state(PersonPageViewMode.VIEW_ASSETS);
  let isEditingName = $state(false);
  let showFaceThumbnails = $state(false);
  let faceList = $state<Array<{ id: string; assetId: string }>>([]);
  let faceListLoading = $state(false);

  const loadFaceList = async () => {
    faceListLoading = true;
    try {
      const response = await fetch(`/api/people/${person.id}/faces`);
      if (response.ok) {
        faceList = await response.json();
      }
    } catch (error) {
      handleError(error, 'Failed to load faces');
    } finally {
      faceListLoading = false;
    }
  };

  $effect(() => {
    if (showFaceThumbnails && faceList.length === 0 && !faceListLoading) {
      void loadFaceList();
    }
  });
  let previousRoute = $state<string>(Route.explore());
  let personMerge1: PersonResponseDto | undefined = $state();
  let personMerge2: PersonResponseDto | undefined = $state();
  let potentialMergePeople: PersonResponseDto[] = $state([]);
  let isSuggestionSelectedByUser = $state(false);

  let personName = $derived(person.name);
  let suggestedPeople: PersonResponseDto[] = $state([]);

  /**
   * Save the word used to search people name: for example,
   * if searching 'r' and the server returns 15 people with names starting with 'r',
   * there's no need to search again people with name starting with 'ri'.
   * However, it needs to make a new api request if searching 'r' returns 20 names (arbitrary value, the limit sent back by the server).
   * or if the new search word starts with another word / letter
   **/
  let isSearchingPeople = $state(false);
  let suggestionContainer: HTMLElement | undefined = $state();

  onMount(() => {
    const action = $page.url.searchParams.get(QueryParameter.ACTION);
    const getPreviousRoute = $page.url.searchParams.get(QueryParameter.PREVIOUS_ROUTE);
    if (getPreviousRoute && !isExternalUrl(getPreviousRoute)) {
      previousRoute = getPreviousRoute;
    }
    if (action == 'merge') {
      viewMode = PersonPageViewMode.MERGE_PEOPLE;
    }

    return websocketEvents.on('on_person_thumbnail', (personId: string) => {
      if (person.id === personId) {
        thumbnailData = getPeopleThumbnailUrl(person, Date.now().toString());
      }
    });
  });

  const handleEscape = async () => {
    if (assetMultiSelectManager.selectionActive) {
      assetMultiSelectManager.clear();
      return;
    }

    await goto(previousRoute);
    return;
  };

  const updateAssetCount = async () => {
    await invalidateAll();
  };

  afterNavigate(({ from }) => {
    // Prevent setting previousRoute to the current page.
    if (from?.url && from.route.id !== $page.route.id) {
      previousRoute = from.url.href;
    }
  });

  const handleUnmerge = () => {
    timelineManager.removeAssets(assetMultiSelectManager.assets.map((a) => a.id));
    assetMultiSelectManager.clear();
    viewMode = PersonPageViewMode.VIEW_ASSETS;
  };

  const handleReassignAssets = () => {
    viewMode = PersonPageViewMode.UNASSIGN_ASSETS;
  };

  const handleMerge = async (person: PersonResponseDto) => {
    await updateAssetCount();
    await handleGoBack();

    data = { ...data, person };
  };

  const handleSelectFeaturePhoto = async (asset: TimelineAsset) => {
    if (viewMode !== PersonPageViewMode.SELECT_PERSON) {
      return;
    }
    try {
      person = await updatePerson({ id: person.id, personUpdateDto: { featureFaceAssetId: asset.id } });
      toastManager.primary($t('feature_photo_updated'));
    } catch (error) {
      handleError(error, $t('errors.unable_to_set_feature_photo'));
    }

    assetMultiSelectManager.clear();

    viewMode = PersonPageViewMode.VIEW_ASSETS;
  };

  const handleMergeSuggestion = async (): Promise<{ merged: boolean }> => {
    if (!personMerge1 || !personMerge2) {
      return { merged: false };
    }

    const result = await modalManager.show(PersonMergeSuggestionModal, {
      personToMerge: personMerge1,
      personToBeMergedInto: personMerge2,
      potentialMergePeople,
    });

    if (!result) {
      return { merged: false };
    }

    const [, personToBeMergedInto] = result;

    if (personToBeMergedInto.name != personName && person.id === personToBeMergedInto.id) {
      await updateAssetCount();
      return { merged: true };
    }
    await goto(Route.viewPerson(personToBeMergedInto), { replaceState: true });
    return { merged: true };
  };

  const handleSuggestPeople = async (person2: PersonResponseDto) => {
    isEditingName = false;
    if (person.id !== person2.id) {
      potentialMergePeople = [];
      personMerge1 = person;
      personMerge2 = person2;
      isSuggestionSelectedByUser = true;

      await handleMergeSuggestion();
    }
  };

  const changeName = async () => {
    viewMode = PersonPageViewMode.VIEW_ASSETS;
    person.name = personName;
    isEditingName = false;

    if (isSuggestionSelectedByUser) {
      // User canceled the merge
      isSuggestionSelectedByUser = false;
      return;
    }

    try {
      person = await updatePerson({ id: person.id, personUpdateDto: { name: personName } });
      toastManager.primary($t('change_name_successfully'));
    } catch (error) {
      handleError(error, $t('errors.unable_to_save_name'));
    }
  };

  const handleCancelEditName = () => {
    isSearchingPeople = false;
    isEditingName = false;
  };

  const handleNameChange = async (name: string) => {
    isEditingName = false;
    potentialMergePeople = [];
    personName = name;

    if (person.name === personName) {
      return;
    }
    if (name === '') {
      await changeName();
      return;
    }

    const result = await searchPerson({ name: personName, withHidden: true });

    const existingPerson = result.find(
      ({ name, id }: PersonResponseDto) => name.toLowerCase() === personName.toLowerCase() && id !== person.id && name,
    );
    if (existingPerson) {
      personMerge2 = existingPerson;
      personMerge1 = person;
      potentialMergePeople = result
        .filter(
          (person: PersonResponseDto) =>
            personMerge2?.name.toLowerCase() === person.name.toLowerCase() &&
            person.id !== personMerge2.id &&
            person.id !== personMerge1?.id &&
            !person.isHidden,
        )
        .slice(0, 3);
      const { merged } = await handleMergeSuggestion();
      if (merged) {
        return;
      }
    }
    await changeName();
  };

  const handleGoBack = async () => {
    viewMode = PersonPageViewMode.VIEW_ASSETS;
    if ($page.url.searchParams.has(QueryParameter.ACTION)) {
      $page.url.searchParams.delete(QueryParameter.ACTION);
      await goto($page.url);
    }
  };

  const handleDeleteAssets = async (assetIds: string[]) => {
    timelineManager.removeAssets(assetIds);
    await updateAssetCount();
  };

  const handleUndoDeleteAssets = async (assets: TimelineAsset[]) => {
    timelineManager.upsertAssets(assets);
    await updateAssetCount();
  };

  const handleSetVisibility = (assetIds: string[]) => {
    timelineManager.removeAssets(assetIds);
    assetMultiSelectManager.clear();
  };

  const onPersonUpdate = async (response: PersonResponseDto) => {
    if (response.id !== person.id) {
      return;
    }

    if (response.isHidden) {
      await goto(previousRoute);
      return;
    }

    person = response;
  };

  const handlePersonAssetDelete = async ({ id, assetId }: { id: string; assetId: string }) => {
    if (id !== person.id) {
      return;
    }
    timelineManager.removeAssets([assetId]);
    await updateAssetCount();
  };

  const { SetDateOfBirth, Favorite, Unfavorite, HidePerson, ShowPerson } = $derived(getPersonActions($t, person));
  const SelectFeaturePhoto: ActionItem = {
    title: $t('select_featured_photo'),
    icon: mdiAccountBoxOutline,
    onAction: () => {
      viewMode = PersonPageViewMode.SELECT_PERSON;
    },
  };

  const Merge: ActionItem = {
    title: $t('merge_people'),
    icon: mdiAccountMultipleCheckOutline,
    onAction: () => {
      viewMode = PersonPageViewMode.MERGE_PEOPLE;
    },
  };

  const handleCreatePersonShareLink = async () => {
    try {
      const response = await fetch('/api/shared-links', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'PERSON', personId: person.id, allowDownload: true, showMetadata: true }),
      });
      if (!response.ok) {
        throw new Error(`Failed: ${response.status}`);
      }
      const link = await response.json();
      const url = `${window.location.origin}/share/${link.key}`;
      try {
        await navigator.clipboard.writeText(url);
        toastManager.primary($t('shared_link_copied'));
      } catch {
        toastManager.primary(url);
      }
    } catch (error) {
      handleError(error, $t('errors.unable_to_create_shared_link'));
    }
  };

  const CreatePersonShareLink: ActionItem = {
    title: $t('create_person_share_link'),
    icon: mdiShareVariantOutline,
    onAction: handleCreatePersonShareLink,
  };
</script>

<OnEvents
  {onPersonUpdate}
  onPersonAssetDelete={handlePersonAssetDelete}
  onAssetsDelete={updateAssetCount}
  onAssetsArchive={updateAssetCount}
/>

<main
  class="relative z-0 h-dvh overflow-hidden px-2 pt-(--navbar-height) md:px-6 md:pt-(--navbar-height-md)"
  use:scrollMemoryClearer={{
    routeStartsWith: Route.people(),
    beforeClear: () => {
      sessionStorage.removeItem(SessionStorageKey.INFINITE_SCROLL_PAGE);
    },
  }}
>
  {#key person.id}
    <div
      class="immich-scrollbar h-full overflow-y-auto px-4 pt-16 pb-8 sm:px-6"
      class:hidden={!showFaceThumbnails}
    >
      {#if faceListLoading && faceList.length === 0}
        <div class="flex justify-center py-10"><LoadingSpinner /></div>
      {:else if faceList.length === 0}
        <p class="py-10 text-center text-gray-500">{$t('no_results')}</p>
      {:else}
        <div class="grid grid-cols-3 gap-2 sm:grid-cols-5 md:grid-cols-7 lg:grid-cols-9 xl:grid-cols-11">
          {#each faceList as face (face.id)}
            <a
              href={Route.viewAsset({ id: face.assetId })}
              class="block aspect-square overflow-hidden rounded bg-gray-200 dark:bg-gray-800"
              title={person.name}
            >
              <img
                src={`/api/faces/${face.id}/thumbnail`}
                alt={person.name || ''}
                loading="lazy"
                class="h-full w-full object-cover"
              />
            </a>
          {/each}
        </div>
      {/if}
    </div>
    <div class="h-full" class:hidden={showFaceThumbnails}>
    <Timeline
      enableRouting={true}
      {person}
      bind:timelineManager
      {options}
      assetInteraction={assetMultiSelectManager}
      isSelectionMode={viewMode === PersonPageViewMode.SELECT_PERSON}
      singleSelect={viewMode === PersonPageViewMode.SELECT_PERSON}
      onSelect={handleSelectFeaturePhoto}
      onEscape={handleEscape}
    >
      {#if viewMode === PersonPageViewMode.VIEW_ASSETS}
        <!-- Person information block -->
        <div
          class="relative w-fit p-4 pt-12 sm:px-6"
          use:clickOutside={{
            onOutclick: handleCancelEditName,
            onEscape: handleCancelEditName,
          }}
          use:listNavigation={suggestionContainer}
        >
          <section class="flex w-64 place-items-center border-black sm:w-96">
            {#if isEditingName}
              <EditNameInput
                {person}
                bind:suggestedPeople
                name={person.name}
                bind:isSearchingPeople
                onChange={handleNameChange}
                {thumbnailData}
              />
            {:else}
              <div class="relative">
                <button
                  type="button"
                  class="flex items-center justify-center"
                  title={$t('edit_name')}
                  onclick={() => (isEditingName = true)}
                >
                  <ImageThumbnail
                    circle
                    shadow
                    url={thumbnailData}
                    altText={person.name}
                    widthStyle="3.375rem"
                    heightStyle="3.375rem"
                  />
                  <div class="flex flex-col justify-center px-4 text-start text-primary">
                    <p class="w-40 truncate font-medium sm:w-72">{person.name || $t('add_a_name')}</p>
                    <p class="text-sm text-gray-500 dark:text-gray-400">
                      {$t('assets_count', { values: { count: numberOfAssets } })}
                    </p>
                    {#if person.birthDate}
                      <p class="text-sm text-gray-500 dark:text-gray-400">
                        {$t('person_birthdate', {
                          values: {
                            date: DateTime.fromISO(person.birthDate).toLocaleString(
                              {
                                month: 'numeric',
                                day: 'numeric',
                                year: 'numeric',
                              },
                              { locale: $locale },
                            ),
                          },
                        })}
                      </p>
                    {/if}
                  </div>
                </button>
              </div>
            {/if}
          </section>
          {#if isEditingName}
            <div class="absolute z-1 w-64 sm:w-96">
              {#if isSearchingPeople}
                <div
                  class="flex h-14 place-items-center rounded-b-lg border border-gray-400 bg-gray-200 p-2 dark:border-immich-dark-gray dark:bg-gray-700"
                >
                  <div class="flex w-full place-items-center">
                    <LoadingSpinner />
                  </div>
                </div>
              {:else}
                <div bind:this={suggestionContainer}>
                  {#each suggestedPeople as person, index (person.id)}
                    <button
                      type="button"
                      class="flex h-14 w-full place-items-center border border-gray-200 bg-gray-100 p-2 hover:bg-gray-300 focus:bg-gray-300 dark:border-immich-dark-gray dark:bg-gray-700 hover:dark:bg-[#232932] focus:dark:bg-[#232932] {index ===
                      suggestedPeople.length - 1
                        ? 'rounded-b-lg border-b'
                        : ''}"
                      onclick={() => handleSuggestPeople(person)}
                    >
                      <ImageThumbnail
                        circle
                        shadow
                        url={getPeopleThumbnailUrl(person)}
                        altText={person.name}
                        widthStyle="2rem"
                        heightStyle="2rem"
                      />
                      <p class="ms-4 text-gray-700 dark:text-gray-100">{person.name}</p>
                    </button>
                  {/each}
                </div>
              {/if}
            </div>
          {/if}
        </div>
      {/if}
    </Timeline>
    </div>
  {/key}
</main>

<header>
  {#if assetMultiSelectManager.selectionActive}
    <AssetSelectControlBar>
      {@const Actions = getAssetBulkActions($t)}
      <CommandPaletteDefaultProvider name={$t('assets')} actions={Object.values(Actions)} />
      <CreateSharedLink />
      <SelectAllAssets {timelineManager} assetInteraction={assetMultiSelectManager} />
      <ActionButton action={Actions.AddToAlbum} />
      <FavoriteAction
        removeFavorite={assetMultiSelectManager.isAllFavorite}
        onFavorite={(ids, isFavorite) => timelineManager.update(ids, (asset) => (asset.isFavorite = isFavorite))}
      />
      <ButtonContextMenu icon={mdiDotsVertical} title={$t('menu')}>
        <DownloadAction menuItem filename="{person.name || 'immich'}.zip" />
        <MenuOption
          icon={mdiAccountMultipleCheckOutline}
          text={$t('fix_incorrect_match')}
          onClick={handleReassignAssets}
        />
        <ChangeDate menuItem />
        <ChangeDescription menuItem />
        <ChangeLocation menuItem />
        <ArchiveAction
          menuItem
          unarchive={assetMultiSelectManager.isAllArchived}
          onArchive={(ids, visibility) => timelineManager.update(ids, (asset) => (asset.visibility = visibility))}
        />
        {#if authManager.preferences.tags.enabled && assetMultiSelectManager.isAllUserOwned}
          <TagAction menuItem />
        {/if}
        <SetVisibilityAction menuItem onVisibilitySet={handleSetVisibility} />
        <DeleteAssets
          menuItem
          onAssetDelete={(assetIds) => handleDeleteAssets(assetIds)}
          onUndoDelete={(assets) => handleUndoDeleteAssets(assets)}
        />
      </ButtonContextMenu>
    </AssetSelectControlBar>
  {:else}
    {#if viewMode === PersonPageViewMode.VIEW_ASSETS}
      <ControlAppBar showBackButton backIcon={mdiArrowLeft} onClose={() => goto(previousRoute)}>
        {#snippet trailing()}
          <IconButton
            shape="round"
            color="secondary"
            variant="ghost"
            aria-label={showFaceThumbnails ? $t('show_full_thumbnails') : $t('show_face_thumbnails')}
            icon={showFaceThumbnails ? mdiImageMultiple : mdiFaceMan}
            onclick={() => (showFaceThumbnails = !showFaceThumbnails)}
          />
          <ContextMenuButton
            items={[
              SelectFeaturePhoto,
              CreatePersonShareLink,
              HidePerson,
              ShowPerson,
              SetDateOfBirth,
              Merge,
              Favorite,
              Unfavorite,
            ]}
            aria-label={$t('open')}
          />
        {/snippet}
      </ControlAppBar>
    {/if}

    {#if viewMode === PersonPageViewMode.SELECT_PERSON}
      <ControlAppBar onClose={() => (viewMode = PersonPageViewMode.VIEW_ASSETS)}>
        {#snippet leading()}
          {$t('select_featured_photo')}
        {/snippet}
      </ControlAppBar>
    {/if}
  {/if}
</header>

{#if viewMode === PersonPageViewMode.UNASSIGN_ASSETS}
  <UnmergeFaceSelector
    assetIds={assetMultiSelectManager.assets.map((a) => a.id)}
    personAssets={person}
    onClose={() => (viewMode = PersonPageViewMode.VIEW_ASSETS)}
    onConfirm={handleUnmerge}
  />
{/if}

{#if viewMode === PersonPageViewMode.MERGE_PEOPLE}
  <MergeFaceSelector {person} onBack={handleGoBack} onMerge={handleMerge} />
{/if}
