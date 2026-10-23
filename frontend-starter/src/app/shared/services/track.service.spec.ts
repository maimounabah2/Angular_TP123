import { provideHttpClient } from '@angular/common/http';
import { HttpEventType } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Page } from '../models/page.model';
import { Track } from '../models/track.model';
import { TrackService } from './track.service';

describe('TrackService', () => {
  let service: TrackService;
  let httpTestingController: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        TrackService,
        provideHttpClient(),
        provideHttpClientTesting(),
      ],
    });

    service = TestBed.inject(TrackService);
    httpTestingController = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    httpTestingController.verify();
  });

  it('requests the selected page and returns the simulated tracks', () => {
    const expectedPage: Page<Track> = {
      items: [
        {
          id: 'track-1',
          title: 'Test track',
          originalName: 'test.mp3',
          mimeType: 'audio/mpeg',
          size: 1024,
          createdAt: '2026-10-20T10:00:00.000Z',
        },
      ],
      page: 2,
      limit: 10,
      total: 1,
      pages: 1,
    };
    let receivedPage: Page<Track> | undefined;

    service.list(2, 10).subscribe((page) => {
      receivedPage = page;
    });

    const request = httpTestingController.expectOne('/api/tracks?page=2&limit=10');
    expect(request.request.method).toBe('GET');
    expect(request.request.params.get('page')).toBe('2');
    expect(request.request.params.get('limit')).toBe('10');

    request.flush(expectedPage);

    expect(receivedPage).toEqual(expectedPage);
  });

  it('deletes the selected track and completes after the simulated response', () => {
    let completed = false;

    service.delete('track-42').subscribe({
      complete: () => {
        completed = true;
      },
    });

    const request = httpTestingController.expectOne('/api/tracks/track-42');
    expect(request.request.method).toBe('DELETE');

    request.flush(null);

    expect(completed).toBe(true);
  });

  it('searches cover art with the title and artist parameters', () => {
    let receivedItems: unknown;

    service.searchCovers('Blue Train', 'John Coltrane').subscribe((response) => {
      receivedItems = response.items;
    });

    const request = httpTestingController.expectOne(
      '/api/tracks/cover-search?title=Blue%20Train&artist=John%20Coltrane',
    );
    expect(request.request.method).toBe('GET');
    request.flush({
      items: [
        {
          releaseId: 'release-1',
          title: 'Blue Train',
          artist: 'John Coltrane',
          date: '1957',
          coverUrl: 'https://coverartarchive.org/release/release-1/front-250',
        },
      ],
    });

    expect(receivedItems).toEqual([
      expect.objectContaining({ title: 'Blue Train', artist: 'John Coltrane' }),
    ]);
  });

  it('uploads audio, artist, and a chosen cover in multipart form data', () => {
    const audio = new File(['audio'], 'practice.mp3', { type: 'audio/mpeg' });
    const cover = new File(['image'], 'cover.png', { type: 'image/png' });
    let receivedTrack: unknown;

    service.upload(audio, 'Practice', 'Test artist', cover).subscribe((event) => {
      if (event.type === HttpEventType.Response) receivedTrack = event.body;
    });

    const request = httpTestingController.expectOne('/api/tracks');
    expect(request.request.method).toBe('POST');
    expect(request.request.body.get('title')).toBe('Practice');
    expect(request.request.body.get('artist')).toBe('Test artist');
    expect(request.request.body.get('audio')).toBe(audio);
    expect(request.request.body.get('cover')).toBe(cover);

    request.flush({ id: 'track-1', title: 'Practice' });

    expect(receivedTrack).toEqual({ id: 'track-1', title: 'Practice' });
  });

  it('sends a chosen public cover URL with the audio upload', () => {
    const audio = new File(['audio'], 'practice.mp3', { type: 'audio/mpeg' });
    const coverUrl =
      'https://coverartarchive.org/release/a0b1c2d3-e4f5-4678-9234-567890abcdef/front-250';

    service.upload(audio, 'Practice', '', undefined, coverUrl).subscribe();

    const request = httpTestingController.expectOne('/api/tracks');
    expect(request.request.body.get('coverUrl')).toBe(coverUrl);
    expect(request.request.body.get('cover')).toBeNull();
    request.flush({ id: 'track-2', title: 'Practice' });
  });
});
