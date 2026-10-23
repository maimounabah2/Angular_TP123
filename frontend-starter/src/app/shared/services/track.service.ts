import { inject, Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Page } from '../models/page.model';
import { CoverSearchResult, Track } from '../models/track.model';

/** Encapsulates all HTTP operations for backing tracks. */
@Injectable({ providedIn: 'root' })
export class TrackService {
  private readonly http = inject(HttpClient);

  list(page = 1, limit = 5) {
    return this.http.get<Page<Track>>('/api/tracks', {
      params: { page, limit },
    });
  }

  upload(
    file: File,
    title: string,
    artist: string,
    coverFile?: File,
    coverUrl?: string,
  ) {
    const body = new FormData();
    body.append('audio', file);
    body.append('title', title);
    body.append('artist', artist);
    if (coverFile) body.append('cover', coverFile);
    if (coverUrl) body.append('coverUrl', coverUrl);
    return this.http.post<Track>('/api/tracks', body, {
      observe: 'events',
      reportProgress: true,
    });
  }

  searchCovers(title: string, artist: string) {
    return this.http.get<{ items: CoverSearchResult[] }>(
      '/api/tracks/cover-search',
      { params: { title, artist } },
    );
  }

  cover(id: string) {
    return this.http.get(`/api/tracks/${id}/cover`, {
      responseType: 'blob',
    });
  }

  delete(id: string) {
    return this.http.delete<void>(`/api/tracks/${id}`);
  }

  audio(id: string) {
    return this.http.get(`/api/tracks/${id}/audio`, {
      responseType: 'blob',
    });
  }
}
