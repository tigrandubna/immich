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
    mdiMagnify,
    mdiOpenInNew,
    mdiShareVariantOutline,
  } from '@mdi/js';
  import { DateTime } from 'luxon';
  import { SvelteSet } from 'svelte/reactivity';
  import SearchPeople from '$lib/components/faces-page/PeopleSearch.svelte';
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
  // Driven by ?view=faces in URL so the toggle survives back-navigation from
  // the asset viewer and browser refresh; locally-only state used to reset.
  let showFaceThumbnails = $derived($page.url.searchParams.get(QueryParameter.VIEW) === 'faces');
  // True while the nested asset viewer is open (URL has /photos/<assetId>).
  // We keep the face-grid mounted but visually hide it so its scroll position
  // is preserved when the viewer closes.
  let isAssetViewerOpen = $derived(!!$page.params.assetId);
  let faceGridContainer = $state<HTMLDivElement>();
  let faceList = $state<Array<{ id: string; assetId: string; blurScore: number | null; distance?: number }>>([]);
  let faceListLoading = $state(false);
  // When set in the URL, the face grid is sorted by cosine distance from this
  // anchor face's embedding instead of by capture date. Lets the user audit a
  // person's cluster for misattributions ("which faces are farthest from a
  // confirmed-correct one?").
  const anchorFaceId = $derived($page.url.searchParams.get(QueryParameter.ANCHOR));
  // Hide faces whose Laplacian-variance blur score is below this threshold.
  // Persisted in localStorage so the toggle survives page reloads.
  const BLUR_THRESHOLD = 100;
  let hideBlurry = $state(false);
  $effect(() => {
    if (typeof localStorage !== 'undefined') {
      hideBlurry = localStorage.getItem('immich:hideBlurryFaces') === '1';
    }
  });
  const toggleHideBlurry = () => {
    hideBlurry = !hideBlurry;
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem('immich:hideBlurryFaces', hideBlurry ? '1' : '0');
    }
  };
  let visibleFaces = $derived(
    hideBlurry
      ? faceList.filter((f) => f.blurScore === null || f.blurScore >= BLUR_THRESHOLD)
      : faceList,
  );
  let blurryCount = $derived(
    faceList.filter((f) => f.blurScore !== null && f.blurScore < BLUR_THRESHOLD).length,
  );

  const loadFaceList = async () => {
    faceListLoading = true;
    try {
      const url = anchorFaceId
        ? `/api/people/${person.id}/faces?anchor=${encodeURIComponent(anchorFaceId)}`
        : `/api/people/${person.id}/faces`;
      const response = await fetch(url);
      if (response.ok) {
        faceList = await response.json();
      }
    } catch (error) {
      handleError(error, 'Failed to load faces');
    } finally {
      faceListLoading = false;
    }
  };

  // Re-fetch whenever the anchor changes (entering or leaving anchor mode).
  let lastLoadedAnchor = $state<string | null | undefined>(undefined);
  $effect(() => {
    if (!showFaceThumbnails) {
      return;
    }
    const wantedAnchor = anchorFaceId ?? null;
    if (wantedAnchor !== lastLoadedAnchor && !faceListLoading) {
      lastLoadedAnchor = wantedAnchor;
      faceList = [];
      void loadFaceList();
    }
  });

  // ----- brush-select state for face-only grid -----
  // The user clicks a face to start "brushing" — every face the cursor then
  // moves over is added to the selection. A second click ends the brush
  // (selection persists until acted on or cancelled). The active toolbar lets
  // them move all selected faces to another person, or strip the assignment.
  const selectedFaceIds = $state(new SvelteSet<string>());
  let brushActive = $state(false);
  let movePanelOpen = $state(false);
  let moveSearchName = $state('');
  let moveSearchedPeople = $state<PersonResponseDto[]>([]);
  let moveProcessing = $state(false);

  const handleFaceClick = (event: MouseEvent, faceId: string) => {
    event.preventDefault();
    selectedFaceIds.add(faceId);
    // Toggle brush. First click starts; second click ends. Selection persists.
    brushActive = !brushActive;
  };
  const handleFacePointerEnter = (faceId: string) => {
    if (brushActive) {
      selectedFaceIds.add(faceId);
    }
  };
  const clearSelection = () => {
    selectedFaceIds.clear();
    brushActive = false;
    movePanelOpen = false;
    moveSearchName = '';
    moveSearchedPeople = [];
  };
  // After any bulk reassignment / unassignment, the API has changed personId on
  // these faces, so they may no longer belong to this person — drop them from
  // the local list and re-fetch the canonical state from the server.
  const refreshAfterBulkAction = async () => {
    clearSelection();
    faceList = [];
    await loadFaceList();
  };
  const handleMoveToPerson = async (target: PersonResponseDto) => {
    if (selectedFaceIds.size === 0 || moveProcessing) {
      return;
    }
    moveProcessing = true;
    try {
      // PUT /api/faces/:personId  body { id: <faceId> } — reassign one face
      // at a time. The server clears excludedPersonId on every non-null
      // assignment, so previous unassign-exclusions are dropped automatically.
      await Promise.all(
        [...selectedFaceIds].map((faceId) =>
          fetch(`/api/faces/${target.id}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: faceId }),
          }).then((response) => {
            if (!response.ok) {
              throw new Error(`Failed to reassign face ${faceId}: ${response.status}`);
            }
          }),
        ),
      );
      toastManager.primary($t('people_edits_count', { values: { count: selectedFaceIds.size } }));
      await updateAssetCount();
      await refreshAfterBulkAction();
    } catch (error) {
      handleError(error, $t('errors.cant_apply_changes'));
    } finally {
      moveProcessing = false;
    }
  };
  const handleUnassignSelected = async () => {
    if (selectedFaceIds.size === 0 || moveProcessing) {
      return;
    }
    moveProcessing = true;
    try {
      await Promise.all(
        [...selectedFaceIds].map((faceId) =>
          fetch(`/api/faces/${faceId}/person`, { method: 'DELETE' }).then((response) => {
            if (!response.ok) {
              throw new Error(`Failed to unassign face ${faceId}: ${response.status}`);
            }
          }),
        ),
      );
      toastManager.primary($t('people_edits_count', { values: { count: selectedFaceIds.size } }));
      await updateAssetCount();
      await refreshAfterBulkAction();
    } catch (error) {
      handleError(error, $t('errors.cant_apply_changes'));
    } finally {
      moveProcessing = false;
    }
  };

  // Set / clear the anchor=<faceId> query param. Uses replaceState so the user
  // can navigate back out of anchor mode with browser back; preserves view=faces.
  const setAnchorFace = async (faceId: string | null) => {
    const url = new URL($page.url);
    if (faceId) {
      url.searchParams.set(QueryParameter.ANCHOR, faceId);
    } else {
      url.searchParams.delete(QueryParameter.ANCHOR);
    }
    await goto(url.pathname + url.search, { replaceState: true, keepFocus: true, noScroll: true });
  };

  const toggleFaceThumbnails = async () => {
    const url = new URL($page.url);
    if (showFaceThumbnails) {
      url.searchParams.delete(QueryParameter.VIEW);
    } else {
      url.searchParams.set(QueryParameter.VIEW, 'faces');
    }
    await goto(url.pathname + url.search, { replaceState: true, keepFocus: true, noScroll: true });
  };

  // Scroll-memory across page reload (F5 / Cmd+R). Browser-level scroll
  // restoration doesn't help here because both modes scroll an inner element,
  // not window. We snapshot scrollTop into sessionStorage on `beforeunload`
  // (per person + mode) and replay it after the contents are tall enough.
  const scrollStorageKey = $derived(`person-scroll:${person.id}`);

  $effect(() => {
    const handler = () => {
      if (isAssetViewerOpen) {
        return;
      }
      const top = showFaceThumbnails
        ? (faceGridContainer?.scrollTop ?? 0)
        : (timelineManager?.scrollTop ?? 0);
      if (top > 0) {
        sessionStorage.setItem(
          scrollStorageKey,
          JSON.stringify({ mode: showFaceThumbnails ? 'faces' : 'timeline', top }),
        );
      } else {
        sessionStorage.removeItem(scrollStorageKey);
      }
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  });

  // Restore for face mode: faceList is one fetch, so as soon as the grid is
  // mounted and the data is in we can scroll.
  $effect(() => {
    if (!showFaceThumbnails || isAssetViewerOpen || !faceGridContainer || faceList.length === 0) {
      return;
    }
    const raw = sessionStorage.getItem(scrollStorageKey);
    if (!raw) {
      return;
    }
    try {
      const parsed = JSON.parse(raw) as { mode?: string; top?: number };
      if (parsed.mode === 'faces' && typeof parsed.top === 'number') {
        faceGridContainer.scrollTo({ top: parsed.top, behavior: 'instant' });
        sessionStorage.removeItem(scrollStorageKey);
      }
    } catch {
      sessionStorage.removeItem(scrollStorageKey);
    }
  });

  // Restore for timeline mode: TimelineManager grows totalViewerHeight as
  // months load. Retry on RAF until the virtual list is at least as tall as
  // the saved offset, or we give up after ~1 second so we don't spin forever
  // on a now-much-shorter person feed.
  $effect(() => {
    if (showFaceThumbnails || isAssetViewerOpen || !timelineManager) {
      return;
    }
    const raw = sessionStorage.getItem(scrollStorageKey);
    if (!raw) {
      return;
    }
    let cancelled = false;
    let attempts = 0;
    let parsed: { mode?: string; top?: number };
    try {
      parsed = JSON.parse(raw) as { mode?: string; top?: number };
    } catch {
      sessionStorage.removeItem(scrollStorageKey);
      return;
    }
    if (parsed.mode !== 'timeline' || typeof parsed.top !== 'number') {
      return;
    }
    const target = parsed.top;
    const tryRestore = () => {
      if (cancelled || !timelineManager) {
        return;
      }
      const ready = timelineManager.totalViewerHeight >= target + timelineManager.viewportHeight;
      if (ready || attempts++ > 60) {
        timelineManager.scrollTo(target);
        sessionStorage.removeItem(scrollStorageKey);
        return;
      }
      requestAnimationFrame(tryRestore);
    };
    requestAnimationFrame(tryRestore);
    return () => {
      cancelled = true;
    };
  });

  // PageDown / PageUp / Home / End on the face grid. Without this the keys do
  // nothing — the grid container has no focus and the page body isn't scrollable.
  $effect(() => {
    if (!showFaceThumbnails || isAssetViewerOpen) {
      return;
    }
    const handler = (event: KeyboardEvent) => {
      const container = faceGridContainer;
      if (!container) {
        return;
      }
      // Don't hijack keys from text inputs, contenteditable, etc.
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
        return;
      }
      const page = container.clientHeight * 0.9;
      switch (event.key) {
        case 'PageDown': {
          container.scrollBy({ top: page, behavior: 'smooth' });
          event.preventDefault();
          break;
        }
        case 'PageUp': {
          container.scrollBy({ top: -page, behavior: 'smooth' });
          event.preventDefault();
          break;
        }
        case 'Home': {
          container.scrollTo({ top: 0, behavior: 'smooth' });
          event.preventDefault();
          break;
        }
        case 'End': {
          container.scrollTo({ top: container.scrollHeight, behavior: 'smooth' });
          event.preventDefault();
          break;
        }
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
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
      bind:this={faceGridContainer}
      class="immich-scrollbar h-full overflow-y-auto px-4 pt-16 pb-8 sm:px-6"
      class:hidden={!showFaceThumbnails || isAssetViewerOpen}
    >
      {#if faceListLoading && faceList.length === 0}
        <div class="flex justify-center py-10"><LoadingSpinner /></div>
      {:else if faceList.length === 0}
        <p class="py-10 text-center text-gray-500">{$t('no_results')}</p>
      {:else}
        <div class="mb-3 flex flex-wrap items-center gap-3">
          <label class="flex cursor-pointer items-center gap-2 text-sm text-gray-700 dark:text-gray-200">
            <input type="checkbox" checked={hideBlurry} onchange={toggleHideBlurry} />
            {$t('hide_blurry_faces')}
          </label>
          {#if hideBlurry && blurryCount > 0}
            <span class="text-xs text-gray-500">{$t('hidden_faces_count', { values: { count: blurryCount } })}</span>
          {/if}
          {#if anchorFaceId}
            <div
              class="ms-auto flex items-center gap-2 rounded bg-immich-primary/10 px-3 py-1 text-sm dark:bg-immich-dark-primary/20"
            >
              <img
                src={`/api/faces/${anchorFaceId}/thumbnail?v=2`}
                alt=""
                loading="lazy"
                class="h-6 w-6 rounded-full object-cover"
              />
              <span>Sorted by similarity</span>
              <button
                type="button"
                class="cursor-pointer text-immich-primary underline dark:text-immich-dark-primary"
                onclick={() => setAnchorFace(null)}
              >
                Reset
              </button>
            </div>
          {/if}
        </div>
        <div
          class="grid grid-cols-3 gap-2 sm:grid-cols-5 md:grid-cols-7 lg:grid-cols-9 xl:grid-cols-11 {brushActive
            ? 'cursor-crosshair'
            : ''}"
        >
          {#each visibleFaces as face (face.id)}
            {@const isSelected = selectedFaceIds.has(face.id)}
            <div class="group relative">
              <button
                type="button"
                class="block aspect-square w-full overflow-hidden rounded bg-gray-200 dark:bg-gray-800 {face.id ===
                anchorFaceId
                  ? 'outline outline-2 outline-offset-2 outline-immich-primary dark:outline-immich-dark-primary'
                  : ''} {isSelected
                  ? 'outline outline-3 outline-offset-2 outline-blue-500'
                  : ''}"
                title={person.name}
                onclick={(event) => handleFaceClick(event, face.id)}
                onpointerenter={() => handleFacePointerEnter(face.id)}
              >
                <img
                  src={`/api/faces/${face.id}/thumbnail?v=2`}
                  alt={person.name || ''}
                  loading="lazy"
                  draggable="false"
                  class="pointer-events-none h-full w-full object-cover {isSelected ? 'opacity-70' : ''}"
                  onerror={(e) => {
                    const img = e.currentTarget as HTMLImageElement;
                    if (!img.dataset.retried) {
                      img.dataset.retried = '1';
                      img.src = `/api/faces/${face.id}/thumbnail?v=2&r=${Date.now()}`;
                    }
                  }}
                />
                {#if isSelected}
                  <span
                    class="pointer-events-none absolute top-1 right-1 flex h-6 w-6 items-center justify-center rounded-full bg-blue-500 text-white shadow"
                    aria-hidden="true"
                  >
                    <svg viewBox="0 0 24 24" class="h-4 w-4">
                      <path d="M20 6L9 17l-5-5" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" />
                    </svg>
                  </span>
                {/if}
              </button>
              <a
                href={`/people/${person.id}/photos/${face.assetId}?${QueryParameter.VIEW}=faces${anchorFaceId ? `&${QueryParameter.ANCHOR}=${anchorFaceId}` : ''}`}
                class="absolute right-1 bottom-1 hidden h-7 w-7 cursor-pointer items-center justify-center rounded-full bg-black/30 opacity-0 transition-opacity hover:bg-black/50 focus:bg-black/50 focus:opacity-100 focus:outline-none group-hover:flex group-hover:opacity-100"
                aria-label={$t('view')}
                title={$t('view')}
                onclick={(event) => event.stopPropagation()}
              >
                <svg viewBox="0 0 24 24" class="h-5 w-5" aria-hidden="true">
                  <path d={mdiOpenInNew} fill="white" stroke="black" stroke-width="0.6" />
                </svg>
              </a>
              {#if face.id !== anchorFaceId}
                <button
                  type="button"
                  class="absolute top-1 left-1 hidden h-7 w-7 cursor-pointer items-center justify-center rounded-full bg-black/30 opacity-0 transition-opacity hover:bg-black/50 focus:bg-black/50 focus:opacity-100 focus:outline-none group-hover:flex group-hover:opacity-100"
                  aria-label="Find similar within this person"
                  title="Find similar"
                  onclick={(event) => {
                    event.stopPropagation();
                    void setAnchorFace(face.id);
                  }}
                >
                  <svg viewBox="0 0 24 24" class="h-5 w-5" aria-hidden="true">
                    <path d={mdiMagnify} fill="white" stroke="black" stroke-width="0.6" />
                  </svg>
                </button>
              {/if}
              {#if anchorFaceId && face.distance !== undefined}
                <span
                  class="pointer-events-none absolute right-1 bottom-1 rounded bg-black/60 px-1 text-[10px] text-white tabular-nums {selectedFaceIds.size >
                  0
                    ? 'opacity-0'
                    : ''}"
                  title="Cosine distance from anchor"
                >
                  {face.distance.toFixed(3)}
                </span>
              {/if}
            </div>
          {/each}
        </div>
      {/if}
    </div>

    {#if showFaceThumbnails && !isAssetViewerOpen && selectedFaceIds.size > 0}
      <!--
        Bulk-action bar pinned to the bottom of the viewport while at least
        one face is selected. Shows a "Move to..." picker (existing
        SearchPeople component) and a "Make unassigned" button that calls
        the unassign endpoint per-face. "Cancel" clears the selection.
      -->
      <div
        class="fixed inset-x-0 bottom-0 z-30 border-t border-gray-300 bg-white p-3 shadow-lg dark:border-immich-dark-gray dark:bg-immich-dark-bg"
      >
        <div class="mx-auto flex max-w-5xl flex-col gap-3 sm:flex-row sm:items-center">
          <div class="flex items-center gap-2 text-sm">
            <span class="font-medium">{selectedFaceIds.size}</span>
            <span class="text-gray-600 dark:text-gray-300">{$t('faces_selected') || 'selected'}</span>
            {#if brushActive}
              <span class="rounded-full bg-blue-500/20 px-2 py-0.5 text-xs text-blue-700 dark:text-blue-300">
                {$t('brush_active') || 'brush on'}
              </span>
            {/if}
          </div>
          {#if movePanelOpen}
            <div class="min-w-0 flex-1">
              <SearchPeople
                type="searchBar"
                placeholder={$t('move_to_person') || 'Move to person…'}
                bind:searchName={moveSearchName}
                bind:searchedPeopleLocal={moveSearchedPeople}
              />
            </div>
            {#if moveSearchName && moveSearchedPeople.length > 0}
              <div
                class="flex max-h-40 min-w-0 flex-1 flex-wrap gap-2 overflow-y-auto rounded border border-gray-200 p-2 dark:border-immich-dark-gray"
              >
                {#each moveSearchedPeople as candidate (candidate.id)}
                  <button
                    type="button"
                    class="flex items-center gap-2 rounded bg-gray-100 px-2 py-1 text-sm hover:bg-gray-200 disabled:opacity-50 dark:bg-immich-dark-gray dark:hover:bg-gray-700"
                    disabled={moveProcessing || candidate.id === person.id}
                    onclick={() => void handleMoveToPerson(candidate)}
                  >
                    <img
                      src={getPeopleThumbnailUrl(candidate)}
                      alt=""
                      class="h-6 w-6 rounded-full object-cover"
                    />
                    <span>{candidate.name || $t('add_a_name')}</span>
                  </button>
                {/each}
              </div>
            {/if}
          {/if}
          <div class="ms-auto flex items-center gap-2">
            {#if !movePanelOpen}
              <button
                type="button"
                class="cursor-pointer rounded bg-immich-primary px-3 py-1.5 text-sm font-medium text-white hover:bg-immich-primary/90 disabled:opacity-50 dark:bg-immich-dark-primary dark:text-immich-dark-bg"
                disabled={moveProcessing}
                onclick={() => (movePanelOpen = true)}
              >
                {$t('move_to_person') || 'Move to…'}
              </button>
            {/if}
            <button
              type="button"
              class="cursor-pointer rounded border border-gray-300 px-3 py-1.5 text-sm hover:bg-gray-100 disabled:opacity-50 dark:border-immich-dark-gray dark:hover:bg-immich-dark-gray"
              disabled={moveProcessing}
              onclick={() => void handleUnassignSelected()}
            >
              {$t('make_unassigned') || 'Make unassigned'}
            </button>
            <button
              type="button"
              class="cursor-pointer rounded px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-immich-dark-gray"
              disabled={moveProcessing}
              onclick={clearSelection}
            >
              {$t('cancel')}
            </button>
          </div>
        </div>
      </div>
    {/if}

    <div class="h-full" class:hidden={showFaceThumbnails && !isAssetViewerOpen}>
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
            onclick={toggleFaceThumbnails}
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
