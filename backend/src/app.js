import express from "express";
import cors from "cors";
import multer from "multer";
import jwt from "jsonwebtoken";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { User } from "./models/User.js";
import { Track } from "./models/Track.js";

// Les fichiers audio restent sur le disque du serveur dans ce TP.
// MongoDB ne conserve que leurs métadonnées : titre, nom, taille, etc.
const UPLOADS = path.resolve("data/uploads");

try {
  // mkdirSync est utilisé au démarrage : l'application doit disposer de ce
  // dossier avant de pouvoir accepter le premier upload.
  fs.mkdirSync(UPLOADS, { recursive: true });
  console.log(`[startup] Dossier des uploads prêt : ${UPLOADS}`);
} catch (error) {
  console.error("[startup] Impossible de créer le dossier des uploads", error);
  throw error;
}

// Ce secret reste côté serveur. Il ne doit jamais être copié dans Angular.
const SECRET = process.env.JWT_SECRET || "tp1-development-secret";

// La taille maximale d'un fichier audio est de 25 Mo. Les fichiers plus gros
// sont refusés par Multer avant d'être écrits sur le disque.
const MAX_FILE_SIZE = 25 * 1024 * 1024;
const MAX_COVER_SIZE = 5 * 1024 * 1024;

const allowedAudioTypes = new Set([
  "audio/mpeg",
  "audio/wav",
  "audio/x-wav",
  "audio/ogg",
  "audio/mp4",
  "audio/x-m4a",
]);
const allowedCoverTypes = new Set(["image/jpeg", "image/png", "image/webp"]);
const coverExtensions = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
};
const coverArtHost = "coverartarchive.org";
const releaseIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function removeUploadedFiles(files) {
  for (const file of files) {
    try {
      await fsPromises.unlink(file.path);
    } catch (error) {
      if (error.code !== "ENOENT") {
        console.error(`[uploads] Impossible de supprimer ${file.path}`, error);
        throw error;
      }
    }
  }
}

function isAllowedCoverUrl(value) {
  try {
    const url = new URL(value);
    const releaseMatch = /^\/release\/([0-9a-f-]+)\/front-250$/i.exec(url.pathname);
    return (
      url.protocol === "https:" &&
      url.hostname === coverArtHost &&
      !url.port &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      !!releaseMatch &&
      releaseIdPattern.test(releaseMatch[1])
    );
  } catch {
    return false;
  }
}

/**
 * Crée un jeton JWT contenant uniquement l'identité nécessaire à l'API.
 * Le mot de passe n'est jamais placé dans le token. `sub` signifie subject
 * et contient l'identifiant MongoDB de l'utilisateur.
 */
function token(user) {
  console.log(`[auth] Création d'un token pour l'utilisateur ${user.id}`);
  return jwt.sign({ sub: user.id, email: user.email }, SECRET, {
    expiresIn: "2h",
  });
}

/** Middleware Express qui protège les routes privées. */
function auth(req, res, next) {
  const raw = req.headers.authorization;

  // Le token est transmis dans l'en-tête Authorization sous la forme
    // "Authorization: Bearer <token>". Le préfixe "Bearer " est obligatoire pour que
    // le middleware sache qu'il s'agit d'un JWT et non d'un autre type de jeton.
  if (!raw?.startsWith("Bearer ")) {
    console.warn(`[auth] Authorization absente pour ${req.method} ${req.path}`);
    return res.status(401).json({ message: "Authentification requise" });
  }

  try {
    // jwt.verify vérifie la signature et la date d'expiration du token.
    // On ne logue jamais sa valeur, car un JWT permettrait une usurpation.
    req.auth = jwt.verify(raw.slice(7), SECRET);
    console.log(`[auth] Token accepté pour ${req.auth.sub}`);
    next();
  } catch (error) {
    console.error("[auth] Token invalide ou expiré", error);
    return res.status(401).json({ message: "Jeton invalide ou expiré" });
  }
}

/*
 * Multer transforme une requête HTTP multipart/form-data en données exploitables
 * par Express et traite les fichiers envoyés par un formulaire HTML.
 * Documentation officielle : https://github.com/expressjs/multer
 *
 * diskStorage indique que Multer écrit directement le fichier sur disque.
 * Chaque callback doit appeler cb(error, value) : null signifie qu'il n'y a
 * pas d'erreur. Le nom aléatoire évite les collisions entre utilisateurs.
 */
const storage = multer.diskStorage({
  destination: (_request, _file, callback) => {
    console.debug(`[multer] Destination sélectionnée : ${UPLOADS}`);
    callback(null, UPLOADS);
  },
  filename: (_request, file, callback) => {
    const extension =
      file.fieldname === "cover"
        ? coverExtensions[file.mimetype]
        : path.extname(file.originalname).toLowerCase();
    const filename = crypto.randomUUID() + extension;
    console.log(`[multer] Nom de stockage généré pour ${file.originalname}`);
    callback(null, filename);
  },
});

/*
 * limits.fileSize protège le serveur contre les fichiers trop volumineux.
 * fileFilter est appelé avant l'enregistrement : accepter le fichier appelle
 * callback(null, true), le refuser transmet une vraie Error à Express.
 */
const upload = multer({
  storage,
  limits: { fileSize: MAX_FILE_SIZE, files: 2 },
  fileFilter: (_request, file, callback) => {
    const accepted =
      (file.fieldname === "audio" && allowedAudioTypes.has(file.mimetype)) ||
      (file.fieldname === "cover" && allowedCoverTypes.has(file.mimetype));
    if (accepted) {
      console.log(`[multer] Type accepté : ${file.mimetype}`);
      return callback(null, true);
    }

    const error = new Error(
      file.fieldname === "cover"
        ? "Format de couverture non accepté"
        : "Format audio non accepté",
    );
    console.error(`[multer] Type refusé : ${file.mimetype}`, error);
    return callback(error);
  },
});

/**
 * Construit l'application Express sans ouvrir de port.
 * Cette séparation permet au serveur réel et aux tests de créer la même
 * application. Le port est ouvert uniquement dans server.js.
 */
export function createApp({ fetchImpl = globalThis.fetch } = {}) {
  const app = express();
  const coverSearchCache = new Map();
  let lastMusicBrainzRequestAt = 0;
  let musicBrainzQueue = Promise.resolve();

  const fetchMusicBrainz = async (url, options) => {
    let releaseQueue;
    const previousRequest = musicBrainzQueue;
    musicBrainzQueue = new Promise((resolve) => {
      releaseQueue = resolve;
    });
    await previousRequest;
    try {
      const delay = Math.max(0, 1000 - (Date.now() - lastMusicBrainzRequestAt));
      if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
      lastMusicBrainzRequestAt = Date.now();
      return await fetchImpl(url, options);
    } finally {
      releaseQueue();
    }
  };

  // Journaliser la fin de chaque requête permet de suivre méthode, URL,
  // statut et durée sans exposer les corps contenant des mots de passe.
  app.use((req, res, next) => {
    const startedAt = Date.now();
    res.on("finish", () => {
      console.log(
        `[http] ${req.method} ${req.originalUrl} -> ${res.statusCode} (${Date.now() - startedAt} ms)`,
      );
    });
    next();
  });

  // CORS est nécessaire pour que le frontend Angular puisse appeler l'API.
  // C'est-à-dire que le navigateur autorise les requêtes cross-origin depuis localhost:4200.
  // Dans un vrai projet, il est recommandé de limiter les origines autorisées.
  app.use(cors());

  // Express ne gère pas nativement le JSON : ce middleware transforme le corps JSON en objet JavaScript 
  // accessible via req.body.
  // Il est placé avant les routes pour que toutes les requêtes JSON soient traitées.
  app.use(express.json());

  /** Endpoint public utilisé pour vérifier que l'API répond. */
  app.get("/api/health", (_req, res) => {
    console.log("[health] Vérification de l'API");
    res.json({ status: "ok" });
  });

  app.get("/api/tracks/cover-search", auth, async (req, res) => {
    const title = String(req.query.title || "").trim();
    const artist = String(req.query.artist || "").trim();
    if (title.length < 2 || title.length > 120 || artist.length > 120) {
      return res.status(400).json({
        message: "Indiquez un titre valide et un artiste de 120 caractères maximum.",
      });
    }

    const cacheKey = `${title.toLocaleLowerCase()}|${artist.toLocaleLowerCase()}`;
    const cached = coverSearchCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return res.json({ items: cached.items });
    }
    for (const [key, entry] of coverSearchCache) {
      if (entry.expiresAt <= Date.now()) coverSearchCache.delete(key);
    }
    if (coverSearchCache.size >= 100) {
      coverSearchCache.delete(coverSearchCache.keys().next().value);
    }

    try {
      const escapeLucene = (value) =>
        value.replace(/([+\-!(){}[\]^"~*?:\\/])/g, "\\$1");
      const terms = [`release:"${escapeLucene(title)}"`];
      if (artist) terms.push(`artist:"${escapeLucene(artist)}"`);
      const searchUrl = new URL("https://musicbrainz.org/ws/2/release/");
      searchUrl.searchParams.set("query", terms.join(" AND "));
      searchUrl.searchParams.set("fmt", "json");
      searchUrl.searchParams.set("limit", "10");

      const response = await fetchMusicBrainz(searchUrl, {
        headers: {
          Accept: "application/json",
          "User-Agent": "GuitarPracticeCloud/1.0 (student project)",
        },
        signal: AbortSignal.timeout(8000),
      });
      if (!response.ok) {
        console.error(`[cover-search] MusicBrainz returned ${response.status}`);
        return res.status(502).json({
          message: "Le catalogue musical est momentanément indisponible.",
        });
      }

      const payload = await response.json();
      const items = (payload.releases || [])
        .filter((release) => releaseIdPattern.test(release.id || "") &&
          release["cover-art-archive"]?.front)
        .map((release) => ({
          releaseId: release.id,
          title: release.title,
          artist: (release["artist-credit"] || [])
            .map((credit) => `${credit.name || credit.artist?.name || ""}${credit.joinphrase || ""}`)
            .join(""),
          date: release.date || "",
          sourceUrl: `https://musicbrainz.org/release/${release.id}`,
          coverUrl: `https://${coverArtHost}/release/${release.id}/front-250`,
        }));

      coverSearchCache.set(cacheKey, {
        items,
        expiresAt: Date.now() + 10 * 60 * 1000,
      });
      res.json({ items });
    } catch (error) {
      console.error("[cover-search] Recherche du catalogue impossible", error);
      res.status(502).json({
        message: "La recherche de couverture a échoué. Réessayez plus tard.",
      });
    }
  });

  /** Requête POST pour "insertion" de donnée.
   * Inscrit un utilisateur et renvoie un token avec ses données publiques. 
   * @param {Object} req - La requête HTTP.
   * @param {Object} res - La réponse HTTP.
   * @param {Function} next - La fonction de middleware suivante.
   */
  app.post("/api/auth/register", async (req, res, next) => {
    try {
      const { name, email, password } = req.body || {};
      console.log(`[auth] Tentative d'inscription pour ${email || "email absent"}`);

      if (!name || !email || !password || password.length < 8) {
        console.warn("[auth] Inscription refusée : données invalides ou incomplètes");
        return res.status(400).json({
          message: "Nom, email et mot de passe de 8 caractères requis",
        });
      }

      // Vérifie si l'email est déjà utilisé avant de créer un nouvel utilisateur.
      if (await User.exists({ email: String(email).toLowerCase() })) {
        console.warn(`[auth] Email déjà utilisé : ${email}`);
        return res.status(409).json({ message: "Email déjà utilisé" });
      }

      // Crée l'utilisateur et le stocke dans MongoDB. Le mot de passe est haché
      // par le hook pre('validate') défini dans le schéma Mongoose.
      const user = await User.create({ name, email, password });
      console.log(`[auth] Utilisateur créé : ${user.id}`);
      res.status(201).json({ token: token(user), user: user.toPublic() });
    } catch (error) {
      console.error("[auth] Erreur pendant l'inscription", error);
      next(error);
    }
  });

  /** Vérifie les identifiants et ouvre une session JWT. Les identifiants sont envoyés dans le corps de la 
   * requête par un HTTP POST. */
  app.post("/api/auth/login", async (req, res, next) => {
    try {
        // req.body est déjà un objet JavaScript grâce au middleware express.json() placé plus haut.
        // il contient les champs email et password envoyés par le frontend Angular.
      const email = String(req.body?.email || "").toLowerCase();
      console.log(`[auth] Tentative de connexion pour ${email || "email absent"}`);

      // Sélectionne le mot de passe haché pour vérifier les identifiants.
      // User est un modèle Mongoose qui correspond au schéma défini dans models/User.js.
      // on envoie les requête à MongoDB via cet objet. Le mot de passe haché est stocké dans 
      // passwordHash, mais il n'est pas renvoyé par défaut dans les requêtes pour 
      // des raisons de sécurité.
      const user = await User.findOne({ email }).select("+passwordHash");

      if (!user || !(await user.verifyPassword(req.body?.password || ""))) {
        console.warn(`[auth] Identifiants incorrects pour ${email}`);
        return res.status(401).json({ message: "Identifiants incorrects" });
      }

      console.log(`[auth] Connexion réussie : ${user.id}`);
      res.json({ token: token(user), user: user.toPublic() });
    } catch (error) {
      console.error("[auth] Erreur pendant la connexion", error);
      next(error);
    }
  });

  /** Retourne le profil public de l'utilisateur identifié par le JWT. 
   * Les paramètres sont :
   * @param auth - Le middleware qui vérifie le JWT et ajoute req.auth. 
   * @param {Object} req - La requête HTTP.
   * @param {Object} res - La réponse HTTP.
   * @param {Function} next - La fonction de middleware suivante.
  */
  app.get("/api/users/me", auth, async (req, res, next) => {
    try {
        // req.auth.sub contient l'identifiant MongoDB de l'utilisateur 
        // extrait du JWT par le middleware auth. ici req.auth est un objet ajouté par le middleware 
        // auth à la requête, et sub est la propriété qui contient l'identifiant de l'utilisateur.
      const user = await User.findById(req.auth.sub);
      if (!user) {
        console.warn(`[user] Profil introuvable : ${req.auth.sub}`);
        return res.status(404).json({ message: "Utilisateur inconnu" });
      }

      console.log(`[user] Profil envoyé : ${user.id}`);
      res.json(user.toPublic());
    } catch (error) {
      console.error("[user] Erreur de lecture du profil", error);
      next(error);
    }
  });

  /** Modifie uniquement le nom de l'utilisateur connecté. */
  app.put("/api/users/me", auth, async (req, res, next) => {
    try {
      const user = await User.findByIdAndUpdate(
        req.auth.sub,
        { $set: { name: req.body?.name } },
        { new: true, runValidators: true },
      );

      if (!user) {
        console.warn(`[user] Mise à jour impossible : ${req.auth.sub}`);
        return res.status(404).json({ message: "Utilisateur inconnu" });
      }

      console.log(`[user] Nom mis à jour : ${user.id}`);
      res.json(user.toPublic());
    } catch (error) {
      console.error("[user] Erreur de mise à jour du profil", error);
      next(error);
    }
  });

  /** Retourne une page des pistes appartenant exclusivement à l'utilisateur. */
  app.get("/api/tracks", auth, async (req, res, next) => {
    try {
      const page = Math.max(1, Number(req.query.page) || 1);
      const limit = Math.min(20, Math.max(1, Number(req.query.limit) || 5));
      const filter = { ownerId: req.auth.sub };

      console.log(`[tracks] Lecture page=${page}, limit=${limit}, user=${req.auth.sub}`);

      const result = await Track.aggregatePaginate(
        Track.aggregate([
          { $match: filter },
          { $sort: { createdAt: -1 } },
          {
            $project: {
              _id: 1,
              ownerId: 1,
              title: 1,
              artist: 1,
              originalName: 1,
              mimeType: 1,
              size: 1,
              createdAt: 1,
              coverStoredName: 1,
              coverSourceUrl: 1,
            },
          },
        ]),
        { page, limit },
      );

      const publicItems = result.docs.map((track) => {
        const id = String(track._id);
        return {
          ...track,
          id,
          coverUrl: track.coverStoredName || track.coverSourceUrl
            ? `/api/tracks/${id}/cover`
            : null,
          coverSourceUrl: track.coverSourceUrl || null,
          _id: undefined,
          coverStoredName: undefined,
        };
      });

      console.log(
        `[tracks] ${publicItems.length} piste(s) envoyée(s) sur ${result.totalDocs}`,
      );

      // envoi de la réponse JSON avec les pistes publiques, la page actuelle, la limite par page, 
      // le nombre total de pistes et le nombre total de pages.
      res.json({
        items: publicItems,
        page,
        limit,
        total: result.totalDocs,
        pages: result.totalPages,
      });
    } catch (error) {
      console.error("[tracks] Erreur de pagination", error);
      next(error);
    }
  });

  /**
   * Reçoit le champ multipart audio et le champ texte title.
   * upload.single("audio") traite un seul fichier et le place dans req.file,
   * tandis que req.body.title contient le champ texte associé.
   * C'est ici qu'est fait l'upload de fichiers sur le serveur. 
   * Le middleware auth vérifie le JWT avant d'accepter l'upload.
   * Le middleware upload.single("audio") traite le fichier audio envoyé dans le champ "audio" du formulaire
   * ou de l'appel depuis le frontend avec un objet FormData.
   * Si le fichier est accepté, il est stocké sur le disque et ses métadonnées sont enregistrées 
   * dans MongoDB.
   */
  app.post(
    "/api/tracks",
    auth,
    (req, res, next) => {
      upload.fields([
        { name: "audio", maxCount: 1 },
        { name: "cover", maxCount: 1 },
      ])(req, res, (error) => {
        if (!error) return next();
        const files = Object.values(req.files || {}).flat();
        removeUploadedFiles(files)
          .then(() => next(error))
          .catch(next);
      });
    },
    async (req, res, next) => {
      const audioFile = req.files?.audio?.[0];
      const coverFile = req.files?.cover?.[0];
      const uploadedFiles = [audioFile, coverFile].filter(Boolean);

      try {
        if (!audioFile) {
          console.warn(`[tracks] Upload sans fichier par ${req.auth.sub}`);
          await removeUploadedFiles(uploadedFiles);
          return res.status(400).json({ message: "Fichier audio requis" });
        }

        if (coverFile && coverFile.size > MAX_COVER_SIZE) {
          await removeUploadedFiles(uploadedFiles);
          return res.status(400).json({
            message: "La couverture ne doit pas dépasser 5 Mo.",
          });
        }

        const coverSourceUrl = String(req.body.coverUrl || "").trim();
        if (
          (coverFile && coverSourceUrl) ||
          (coverSourceUrl && !isAllowedCoverUrl(coverSourceUrl))
        ) {
          await removeUploadedFiles(uploadedFiles);
          return res.status(400).json({
            message: "Choisissez une seule couverture provenant d’une source acceptée.",
          });
        }

        const track = await Track.create({
          ownerId: req.auth.sub,
          title: req.body.title || audioFile.originalname,
          artist: String(req.body.artist || "").trim(),
          originalName: audioFile.originalname,
          storedName: audioFile.filename,
          mimeType: audioFile.mimetype,
          size: audioFile.size,
          coverStoredName: coverFile?.filename,
          coverMimeType: coverFile?.mimetype,
          coverSourceUrl,
        });

        console.log(`[tracks] Upload enregistré : ${track.id}`);
        res.status(201).json(track.toPublic());
      } catch (error) {
        console.error("[tracks] Erreur après l'enregistrement du fichier", error);

        // Si MongoDB échoue après l'écriture sur disque, on tente de nettoyer
        // le fichier orphelin. L'erreur de nettoyage est elle aussi loguée.
        try {
          await removeUploadedFiles(uploadedFiles);
        } catch (cleanupError) {
          console.error("[tracks] Nettoyage des fichiers temporaires impossible", cleanupError);
        }
        next(error);
      }
    },
  );

  app.get("/api/tracks/:id/cover", auth, async (req, res, next) => {
    try {
      const track = await Track.findOne({
        _id: req.params.id,
        ownerId: req.auth.sub,
      }).select("+coverStoredName +coverMimeType");

      if (!track) {
        return res.status(404).json({ message: "Couverture inconnue" });
      }

      if (track.coverStoredName && track.coverMimeType) {
        res.type(track.coverMimeType);
        return res.sendFile(path.join(UPLOADS, track.coverStoredName), (error) => {
          if (error) {
            console.error(`[tracks] Erreur d’envoi de la couverture ${track.id}`, error);
            if (!res.headersSent) next(error);
          }
        });
      }

      if (!isAllowedCoverUrl(track.coverSourceUrl || "")) {
        return res.status(404).json({ message: "Couverture inconnue" });
      }

      try {
        const upstream = await fetchImpl(track.coverSourceUrl, {
          headers: { "User-Agent": "GuitarPracticeCloud/1.0 (student project)" },
          signal: AbortSignal.timeout(8000),
        });
        if (!upstream.ok) {
          console.warn(`[tracks] Cover Art Archive returned ${upstream.status}`);
          return res.status(502).json({ message: "La couverture distante est indisponible." });
        }
        const mimeType = upstream.headers.get("content-type")?.split(";")[0] || "";
        const contentLength = Number(upstream.headers.get("content-length") || 0);
        if (!allowedCoverTypes.has(mimeType) || contentLength > MAX_COVER_SIZE) {
          return res.status(502).json({ message: "La couverture distante n’est pas valide." });
        }

        const reader = upstream.body?.getReader();
        if (!reader) {
          return res.status(502).json({ message: "La couverture distante est vide." });
        }
        const chunks = [];
        let imageSize = 0;
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          imageSize += value.byteLength;
          if (imageSize > MAX_COVER_SIZE) {
            await reader.cancel();
            return res.status(502).json({
              message: "La couverture distante est trop volumineuse.",
            });
          }
          chunks.push(Buffer.from(value));
        }
        const image = Buffer.concat(chunks, imageSize);
        res.setHeader("Cache-Control", "private, max-age=3600");
        res.type(mimeType).send(image);
      } catch (error) {
        console.error("[tracks] Récupération de la couverture distante impossible", error);
        res.status(502).json({ message: "La couverture distante est momentanément indisponible." });
      }
    } catch (error) {
      console.error("[tracks] Erreur de préparation de la couverture", error);
      next(error);
    }
  });

  /** Envoie le contenu binaire d'une piste après vérification de sa propriété. */
  app.get("/api/tracks/:id/audio", auth, async (req, res, next) => {
    try {
      const track = await Track.findOne({
        _id: req.params.id,
        ownerId: req.auth.sub,
      }).select("+storedName");

      if (!track) {
        console.warn(`[tracks] Audio introuvable ou interdit : ${req.params.id}`);
        return res.status(404).json({ message: "Piste inconnue" });
      }

      const audioPath = path.join(UPLOADS, track.storedName);
      res.type(track.mimeType);
      // Ce callback permet de loguer le succès ou l'erreur du transfert.
      res.sendFile(audioPath, (error) => {
        if (error) {
          console.error(`[tracks] Erreur d'envoi audio ${track.id}`, error);
          if (!res.headersSent) next(error);
          return;
        }
        console.log(`[tracks] Audio envoyé : ${track.id}`);
      });
    } catch (error) {
      console.error("[tracks] Erreur de préparation du flux audio", error);
      next(error);
    }
  });

  /** Supprime la métadonnée et le fichier physique correspondant. */
  app.delete("/api/tracks/:id", auth, async (req, res, next) => {
    try {
      const track = await Track.findOneAndDelete({
        _id: req.params.id,
        ownerId: req.auth.sub,
      }).select("+storedName +coverStoredName");

      if (!track) {
        console.warn(`[tracks] Suppression impossible : ${req.params.id}`);
        return res.status(404).json({ message: "Piste inconnue" });
      }

      const audioPath = path.join(UPLOADS, track.storedName);
      const coverPath = track.coverStoredName
        ? path.join(UPLOADS, track.coverStoredName)
        : undefined;
      try {
        await removeUploadedFiles([
          { path: audioPath },
          ...(coverPath ? [{ path: coverPath }] : []),
        ]);
        console.log(`[tracks] Fichiers de piste supprimés : ${track.id}`);
      } catch (error) {
        // L'exception n'est volontairement pas ignorée : l'administrateur doit
        // voir ce fichier orphelin si sa suppression échoue.
        console.error(`[tracks] Fichier audio non supprimé : ${audioPath}`, error);
        return res.status(500).json({
          message: "Métadonnées supprimées, mais un fichier associé n’a pas été supprimé",
        });
      }

      res.status(204).end();
    } catch (error) {
      console.error("[tracks] Erreur de suppression", error);
      next(error);
    }
  });

  /** Gestionnaire central des erreurs connues de l'application. */
  app.use((error, _req, res, next) => {
    console.error("[error] Erreur reçue par le gestionnaire central", error);

    if (
      error instanceof multer.MulterError ||
      error?.message === "Format audio non accepté" ||
      error?.message === "Format de couverture non accepté"
    ) {
      return res.status(400).json({ message: error.message });
    }
    if (error?.name === "ValidationError") {
      return res.status(400).json({ message: error.message });
    }
    if (error?.name === "CastError") {
      return res.status(404).json({ message: "Ressource inconnue" });
    }

    next(error);
  });

  return app;
}
