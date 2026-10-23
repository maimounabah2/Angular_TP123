import { DatePipe } from '@angular/common';
import { Component, computed, ElementRef, inject, OnDestroy, signal, ViewChild } from '@angular/core';
import { HttpErrorResponse, HttpEventType } from '@angular/common/http';
import { FormControl, ReactiveFormsModule } from '@angular/forms';
import { MatPaginatorIntl, MatPaginatorModule, PageEvent } from '@angular/material/paginator';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { Subscription } from 'rxjs';
import { Track } from '../../shared/models/track.model';
import { TrackService } from '../../shared/services/track.service';

const MAX_AUDIO_SIZE = 25 * 1024 * 1024;
const ALLOWED_AUDIO_TYPES = new Set([
  'audio/mpeg',
  'audio/wav',
  'audio/x-wav',
  'audio/ogg',
  'audio/mp4',
  'audio/x-m4a',
]);
const ALLOWED_AUDIO_EXTENSIONS = new Set(['mp3', 'wav', 'ogg', 'm4a']);

function normalizeSearchText(value: string): string {
  return value
    .toLocaleLowerCase('fr')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '');
}

@Component({
  imports: [DatePipe, MatPaginatorModule, MatSnackBarModule, ReactiveFormsModule],
  providers: [
    {
      provide: MatPaginatorIntl,
      useFactory: () => {
        const paginatorIntl = new MatPaginatorIntl();
        paginatorIntl.itemsPerPageLabel = 'Pistes par page :';
        paginatorIntl.nextPageLabel = 'Page suivante';
        paginatorIntl.previousPageLabel = 'Page précédente';
        paginatorIntl.firstPageLabel = 'Première page';
        paginatorIntl.lastPageLabel = 'Dernière page';
        paginatorIntl.getRangeLabel = (page, pageSize, length) => {
          if (length === 0 || pageSize === 0) return `0 sur ${length}`;
          const startIndex = page * pageSize;
          const endIndex = Math.min(startIndex + pageSize, length);
          return `${startIndex + 1} – ${endIndex} sur ${length}`;
        };
        return paginatorIntl;
      },
    },
  ],
  templateUrl: './tracks-page.html',
  styleUrl: './tracks-page.css',
})
export class TracksPageComponent implements OnDestroy {
  private readonly service = inject(TrackService);
  private readonly snackBar = inject(MatSnackBar);
  private audioRequest?: Subscription;
  private successMessageTimer?: ReturnType<typeof setTimeout>;

  readonly tracks = signal<Track[]>([]);
  readonly titleFilter = signal('');
  readonly filterOpen = signal(false);
  readonly filteredTracks = computed(() => {
    const query = normalizeSearchText(this.titleFilter().trim());
    return query
      ? this.tracks().filter((track) => normalizeSearchText(track.title).includes(query))
      : this.tracks();
  });
  readonly page = signal(1);
  readonly limit = signal(5);
  readonly total = signal(0);
  readonly pageSizeOptions = [5, 10, 20];
  readonly loading = signal(false);
  readonly loadError = signal('');
  readonly uploadError = signal('');
  readonly uploadSuccess = signal('');
  readonly uploading = signal(false);
  readonly uploadProgress = signal<number | null>(null);
  readonly deletingTrackId = signal<string | null>(null);
  readonly audioUrl = signal('');
  readonly currentTrack = signal<Track | null>(null);
  readonly audioLoading = signal(false);
  readonly audioError = signal('');
  readonly title = new FormControl('', { nonNullable: true });
  file?: File;
  private fileInput?: HTMLInputElement;

  @ViewChild('trackFilterInput')
  set trackFilterInput(input: ElementRef<HTMLInputElement> | undefined) {
    input?.nativeElement.focus();
  }

  constructor() {
    this.load();
  }

  choose(event: Event): void {
    this.clearActionMessages();
    const input = event.target as HTMLInputElement;
    this.fileInput = input;
    const selectedFile = input.files?.[0];

    if (!selectedFile) {
      this.file = undefined;
      return;
    }

    const validationError = this.validateAudioFile(selectedFile);
    if (validationError) {
      this.file = undefined;
      input.value = '';
      this.uploadError.set(validationError);
      return;
    }

    this.file = selectedFile;
  }

  load(): void {
    this.loading.set(true);
    this.loadError.set('');
    this.service.list(this.page(), this.limit()).subscribe({
      next: (response) => {
        console.debug('[TracksPage] Pistes chargées', response.items.length);
        this.tracks.set(response.items);
        this.total.set(response.total);
        this.loading.set(false);
      },
      error: (error: { error?: { message?: string }; message?: string }) => {
        const message =
          error.error?.message ?? error.message ?? 'Erreur de chargement des pistes';
        console.error(
          '[TracksPage] Chargement impossible:',
          message,
        );
        this.loadError.set('Impossible de charger les pistes. Veuillez réessayer.');
        this.loading.set(false);
      },
    });
  }

  onPageChange(event: PageEvent): void {
    if (this.loading()) return;
    this.clearActionMessages();
    this.page.set(event.pageIndex + 1);
    this.limit.set(event.pageSize);
    this.load();
  }

  refresh(): void {
    this.clearActionMessages();
    this.load();
  }

  onTitleInput(): void {
    this.clearActionMessages();
  }

  toggleFilter(): void {
    this.clearActionMessages();
    this.filterOpen.update((open) => !open);
  }

  updateTitleFilter(event: Event): void {
    this.clearActionMessages();
    this.titleFilter.set((event.target as HTMLInputElement).value);
  }

  clearTitleFilter(): void {
    this.clearActionMessages();
    this.titleFilter.set('');
  }

  deleteTrack(track: Track): void {
    this.clearActionMessages();
    if (this.deletingTrackId()) return;
    const confirmed = window.confirm('Voulez-vous supprimer définitivement cette piste ?');
    if (!confirmed) return;

    this.deletingTrackId.set(track.id);

    this.service.delete(track.id).subscribe({
      next: () => {
        if (this.currentTrack()?.id === track.id) this.clearAudioPlayer();
        this.total.update((total) => Math.max(0, total - 1));
        if (this.tracks().length === 1 && this.page() > 1) {
          this.page.update((page) => page - 1);
        }
        this.showDeleteMessage(`La piste ${track.title} a été supprimée.`, 'polite');
        this.deletingTrackId.set(null);
        this.load();
      },
      error: (error: HttpErrorResponse) => {
        const message = this.getDeleteErrorMessage(error);
        console.error('[TracksPage] Suppression impossible:', message);
        this.showDeleteMessage(message, 'assertive');
        this.deletingTrackId.set(null);
        if (error.status >= 500) this.load();
      },
    });
  }

  private getDeleteErrorMessage(error: HttpErrorResponse): string {
    const serverMessage =
      typeof error.error?.message === 'string' ? error.error.message : '';
    if (serverMessage) return serverMessage;
    if (error.status === 0) {
      return 'Impossible de contacter le serveur pour supprimer cette piste.';
    }
    if (error.status === 401) {
      return 'Votre session a expiré. Veuillez vous reconnecter.';
    }
    if (error.status === 404) {
      return 'Cette piste est introuvable ou a déjà été supprimée.';
    }
    return 'La suppression de cette piste a échoué. Veuillez réessayer.';
  }

  upload(): void {
    this.clearActionMessages();
    if (this.uploading()) return;

    if (!this.file) {
      this.uploadError.set('Sélectionnez un fichier audio avant de l’envoyer.');
      return;
    }

    const validationError = this.validateAudioFile(this.file);
    if (validationError) {
      this.uploadError.set(validationError);
      return;
    }

    this.uploading.set(true);
    this.uploadProgress.set(null);
    this.service.upload(this.file, this.title.value || this.file.name).subscribe({
      next: (event) => {
        if (event.type === HttpEventType.UploadProgress) {
          this.uploadProgress.set(
            event.total === undefined
              ? null
              : Math.round((event.loaded / event.total) * 100),
          );
          return;
        }

        if (event.type === HttpEventType.Response) {
          const track = event.body;
          if (!track) {
            this.uploading.set(false);
            this.uploadProgress.set(null);
            this.uploadError.set('Le serveur a répondu sans confirmer la piste envoyée.');
            return;
          }

          console.debug('[TracksPage] Piste envoyée', track.id);
          this.title.setValue('');
          this.file = undefined;
          if (this.fileInput) this.fileInput.value = '';
          this.showUploadSuccessMessage('Le fichier audio a été envoyé avec succès.');
          this.uploading.set(false);
          this.uploadProgress.set(null);
          this.page.set(1);
          this.load();
        }
      },
      error: (error: HttpErrorResponse) => {
        const message = this.getUploadErrorMessage(error);
        console.error('[TracksPage] Envoi impossible:', message);
        this.uploadError.set(message);
        this.uploading.set(false);
        this.uploadProgress.set(null);
      },
    });
  }

  private getUploadErrorMessage(error: HttpErrorResponse): string {
    if (error.status === 0) {
      return 'Impossible de contacter le serveur. Vérifiez votre connexion puis réessayez.';
    }
    if (error.status === 400) {
      return 'Le serveur a refusé le fichier. Vérifiez son format et sa taille.';
    }
    if (error.status === 413) {
      return 'Le fichier est trop volumineux. La taille maximale est de 25 Mo.';
    }
    if (error.status === 401) {
      return 'Votre session a expiré. Veuillez vous reconnecter.';
    }
    return 'L’envoi du fichier a échoué. Veuillez réessayer.';
  }

  private validateAudioFile(file: File): string {
    if (file.size > MAX_AUDIO_SIZE) {
      return 'Le fichier ne doit pas dépasser 25 Mo.';
    }

    const extension = file.name.split('.').pop()?.toLowerCase() ?? '';
    const hasAllowedType = ALLOWED_AUDIO_TYPES.has(file.type);
    const hasAllowedExtension = ALLOWED_AUDIO_EXTENSIONS.has(extension);

    if (file.type ? !hasAllowedType : !hasAllowedExtension) {
      return 'Format non accepté. Choisissez un fichier MP3, WAV, OGG ou M4A.';
    }

    return '';
  }

  formatSize(bytes: number): string {
    const units = ['Ko', 'Mo', 'Go'];
    let size = bytes / 1024;
    let unitIndex = 0;

    while (size >= 1024 && unitIndex < units.length - 1) {
      size /= 1024;
      unitIndex++;
    }

    return `${new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 1 }).format(size)} ${units[unitIndex]}`;
  }

  formatAudioFormat(track: Track): string {
    const mimeFormats: Record<string, string> = {
      'audio/mpeg': 'MP3',
      'audio/wav': 'WAV',
      'audio/x-wav': 'WAV',
      'audio/ogg': 'OGG',
      'audio/mp4': 'M4A',
      'audio/x-m4a': 'M4A',
    };
    const mimeFormat = mimeFormats[track.mimeType.toLowerCase()];
    if (mimeFormat) return mimeFormat;

    const extension = track.originalName.split('.').pop();
    return extension ? extension.toUpperCase() : track.mimeType;
  }

  play(track: Track): void {
    this.clearActionMessages();
    this.audioRequest?.unsubscribe();
    this.clearAudioPlayer();
    this.audioError.set('');
    this.audioLoading.set(true);
    this.audioRequest = this.service.audio(track.id).subscribe({
      next: (blob) => {
        console.debug('[TracksPage] Audio chargé', track.id);
        const previousUrl = this.audioUrl();
        if (previousUrl) URL.revokeObjectURL(previousUrl);
        this.audioUrl.set(URL.createObjectURL(blob));
        this.currentTrack.set(track);
        this.audioLoading.set(false);
        this.audioRequest = undefined;
      },
      error: (error: HttpErrorResponse) => {
        const message = this.getAudioErrorMessage(error);
        console.error('[TracksPage] Lecture impossible:', message);
        this.audioError.set(message);
        this.audioLoading.set(false);
        this.audioRequest = undefined;
      },
    });
  }

  onAudioElementError(): void {
    this.clearActionMessages();
    this.clearAudioPlayer();
    this.audioError.set(
      'Le navigateur ne peut pas lire ce fichier audio. Essayez un autre format ou relancez la lecture.',
    );
  }

  ngOnDestroy(): void {
    this.clearSuccessMessageTimer();
    this.audioRequest?.unsubscribe();
    const currentUrl = this.audioUrl();
    if (currentUrl) URL.revokeObjectURL(currentUrl);
  }

  private clearActionMessages(): void {
    this.clearSuccessMessageTimer();
    this.snackBar.dismiss();
    this.uploadSuccess.set('');
    this.uploadError.set('');
    this.loadError.set('');
    this.audioError.set('');
  }

  private showUploadSuccessMessage(message: string): void {
    this.clearSuccessMessageTimer();
    this.uploadSuccess.set('');
    this.uploadSuccess.set(message);
    this.successMessageTimer = setTimeout(() => {
      this.uploadSuccess.set('');
      this.successMessageTimer = undefined;
    }, 4000);
  }

  private showDeleteMessage(message: string, politeness: 'polite' | 'assertive'): void {
    this.snackBar.open(message, undefined, {
      duration: 4000,
      politeness,
    });
  }

  private clearSuccessMessageTimer(): void {
    if (this.successMessageTimer !== undefined) {
      clearTimeout(this.successMessageTimer);
      this.successMessageTimer = undefined;
    }
  }

  private clearAudioPlayer(): void {
    const currentUrl = this.audioUrl();
    if (currentUrl) URL.revokeObjectURL(currentUrl);
    this.audioUrl.set('');
    this.currentTrack.set(null);
  }

  private getAudioErrorMessage(error: HttpErrorResponse): string {
    if (error.status === 0) {
      return 'Impossible de contacter le serveur pour charger cette piste.';
    }
    if (error.status === 401 || error.status === 403) {
      return 'Vous n’êtes pas autorisée à écouter cette piste. Vérifiez votre connexion.';
    }
    if (error.status === 404) {
      return 'Cette piste audio est introuvable.';
    }
    return 'La piste audio n’a pas pu être chargée. Veuillez réessayer.';
  }
}
