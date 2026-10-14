import { registerLocaleData } from '@angular/common';
import localeFr from '@angular/common/locales/fr';
import { bootstrapApplication } from "@angular/platform-browser";
import { provideHttpClient, withInterceptors, withXhr } from "@angular/common/http";
import { provideRouter } from "@angular/router";
import { AppComponent } from './app/components/app/app';
import { routes } from './app/routes';
import { authInterceptor } from './app/shared/interceptors/auth.interceptor';

registerLocaleData(localeFr);

bootstrapApplication(AppComponent, {
  providers: [
    provideRouter(routes),
    provideHttpClient(withXhr(), withInterceptors([authInterceptor])),
  ],
}).catch(console.error);
