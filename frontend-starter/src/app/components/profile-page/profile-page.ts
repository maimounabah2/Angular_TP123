import { Component, inject, signal } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { AuthService } from '../../shared/services/auth.service';

@Component({
  imports: [ReactiveFormsModule],
  templateUrl: './profile-page.html',
  styleUrl: './profile-page.css',
})
export class ProfilePageComponent {
  readonly auth = inject(AuthService);
  readonly loading = signal(false);
  readonly saving = signal(false);
  readonly success = signal('');
  readonly error = signal('');
  readonly form = new FormGroup({
    name: new FormControl('', {
      nonNullable: true,
      validators: [Validators.required, Validators.minLength(2)],
    }),
  });

  constructor() {
    this.load();
  }

  load(): void {
    this.loading.set(true);
    this.error.set('');
    this.success.set('');

    this.auth.profile().subscribe({
      next: (user) => {
        this.form.setValue({ name: user.name });
        this.loading.set(false);
      },
      error: (error: HttpErrorResponse) => {
        this.error.set(this.getErrorMessage(error, 'Impossible de charger le profil.'));
        this.loading.set(false);
      },
    });
  }

  save(): void {
    this.error.set('');
    this.success.set('');
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }

    this.saving.set(true);
    this.auth.update(this.form.getRawValue().name).subscribe({
      next: () => {
        this.success.set('Votre profil a été mis à jour.');
        this.saving.set(false);
      },
      error: (error: HttpErrorResponse) => {
        this.error.set(this.getErrorMessage(error, 'Impossible d’enregistrer le profil.'));
        this.saving.set(false);
      },
    });
  }

  private getErrorMessage(error: HttpErrorResponse, fallback: string): string {
    if (error.status === 401) {
      return 'Votre session a expiré. Veuillez vous reconnecter.';
    }
    if (error.status === 0 || error.status >= 500) {
      return 'Le service est momentanément indisponible. Veuillez réessayer.';
    }
    if (error.status === 400) {
      return 'Les informations saisies ne sont pas valides.';
    }
    return fallback;
  }
}
