import { HttpClient, provideHttpClient, withInterceptors } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthService } from '../services/auth.service';
import { authInterceptor } from './auth.interceptor';

describe('authInterceptor', () => {
  afterEach(() => {
    TestBed.inject(HttpTestingController).verify();
  });

  it('adds the bearer token to the request', () => {
    const fakeAuthService = {
      token: () => 'test-token-not-a-real-credential',
      logout: vi.fn(),
    };

    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(withInterceptors([authInterceptor])),
        provideHttpClientTesting(),
        { provide: AuthService, useValue: fakeAuthService },
        { provide: Router, useValue: { navigateByUrl: vi.fn() } },
      ],
    });

    const http = TestBed.inject(HttpClient);
    const httpTestingController = TestBed.inject(HttpTestingController);
    let receivedResponse: { ok: boolean } | undefined;

    http.get<{ ok: boolean }>('/api/tracks').subscribe((response) => {
      receivedResponse = response;
    });

    const request = httpTestingController.expectOne('/api/tracks');
    expect(request.request.method).toBe('GET');
    expect(request.request.headers.get('Authorization')).toBe(
      'Bearer test-token-not-a-real-credential',
    );

    request.flush({ ok: true });

    expect(receivedResponse).toEqual({ ok: true });
  });
});
