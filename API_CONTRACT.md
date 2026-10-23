# Contrat HTTP - TP1

Base : `/api`. Sauf inscription et connexion, envoyer `Authorization: Bearer <token>`.

Le contrat HTTP ne dépend pas du choix de persistance : le backend fourni utilise Mongoose et MongoDB. MongoDB conserve les utilisateurs et métadonnées ; les octets des fichiers audio restent sur le disque du serveur.

| Méthode | Route | Requête | Réponse principale |
|---|---|---|---|
| GET | `/health` | - | `{ "status": "ok" }` |
| POST | `/auth/register` | `{name,email,password}` | `201 {token,user}` |
| POST | `/auth/login` | `{email,password}` | `200 {token,user}` |
| GET | `/users/me` | JWT | `200 User` |
| PUT | `/users/me` | `{name}` + JWT | `200 User` |
| GET | `/tracks?page=1&limit=5` | JWT | `Page<Track>` |
| GET | `/tracks/cover-search?title=...&artist=...` | JWT | `{ items: CoverSearchResult[] }` |
| POST | `/tracks` | multipart : `audio`, `title`, `artist?`, `cover?` ou `coverUrl?` | `201 Track` |
| GET | `/tracks/:id/audio` | JWT | flux audio |
| GET | `/tracks/:id/cover` | JWT | image de couverture téléversée |
| DELETE | `/tracks/:id` | JWT | `204` (bonus) |

`Page<Track>` contient `items`, `page`, `limit`, `total` et `pages`. Le backend utilise `mongoose-aggregate-paginate-v2` pour paginer l’agrégation, tout en conservant cette forme de réponse. Chaque `Track` contient ses métadonnées, `coverUrl` (éventuellement `null`) et `coverSourceUrl` (éventuellement `null`, renseigné pour une pochette externe).

Formats audio acceptés : MP3, WAV, OGG et M4A, 25 Mo maximum. Les couvertures envoyées localement acceptent JPEG, PNG ou WebP, jusqu’à 5 Mo. Une couverture recherchée est une URL HTTPS du Cover Art Archive renvoyée par le backend après une recherche déclenchée par l’utilisateur dans MusicBrainz.

`CoverSearchResult` contient `releaseId`, `title`, `artist`, `date`, `sourceUrl` et `coverUrl`.

Erreurs courantes : `400` validation, `401` authentification, `404` ressource, `409` email déjà utilisé.
