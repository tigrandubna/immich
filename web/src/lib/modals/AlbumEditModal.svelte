<script lang="ts">
  import AlbumCover from '$lib/components/album-page/AlbumCover.svelte';
  import { handleUpdateAlbum } from '$lib/services/album.service';
  import { type AlbumResponseDto } from '@immich/sdk';
  import { Field, FormModal, Input, Textarea } from '@immich/ui';
  import { mdiRenameOutline } from '@mdi/js';
  import { t } from 'svelte-i18n';

  // Keep in sync with AUTO_DESCRIPTION_PREFIX in server/src/services/auto-trip.service.ts
  // and AUTO_TRIP_DESCRIPTION_PREFIX in server/src/services/album.service.ts.
  const AUTO_TRIP_DESCRIPTION_PREFIX = 'Auto-detected trip ·';

  type Props = {
    album: AlbumResponseDto;
    onClose: () => void;
  };

  let { album, onClose }: Props = $props();

  let albumName = $state(album.albumName);
  let description = $state(album.description);

  // Auto-trip albums encode the trip's date range and last-scan watermark
  // inside description; the detector needs those on every subsequent run to
  // recognise the album and avoid creating duplicates. Editing the text
  // breaks that, so the UI locks the field and explains why. Renaming and
  // changing the cover still work.
  const isAutoTripAlbum = (album.description ?? '').startsWith(AUTO_TRIP_DESCRIPTION_PREFIX);

  const onSubmit = async () => {
    const success = await handleUpdateAlbum(album, {
      albumName,
      // If the description is locked, always send back what was already
      // there so the server doesn't reject the whole update.
      description: isAutoTripAlbum ? album.description : description,
    });
    if (success) {
      onClose();
    }
  };
</script>

<FormModal icon={mdiRenameOutline} title={$t('edit_album')} size="medium" {onClose} {onSubmit}>
  <div class="m-4 flex items-center gap-8">
    <AlbumCover {album} class="hidden size-50 shadow-lg sm:flex" />

    <div class="flex grow flex-col gap-4">
      <Field label={$t('name')}>
        <Input bind:value={albumName} />
      </Field>

      <Field
        label={$t('description')}
        description={isAutoTripAlbum ? $t('auto_trip_description_locked') : undefined}
        disabled={isAutoTripAlbum}
      >
        <Textarea bind:value={description} disabled={isAutoTripAlbum} />
      </Field>
    </div>
  </div>
</FormModal>
