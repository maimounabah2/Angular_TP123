import test, { mock } from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import jwt from "jsonwebtoken";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { createApp } from "../src/app.js";
import { User } from "../src/models/User.js";
import { Track } from "../src/models/Track.js";

let server, base;
const JWT_SECRET = process.env.JWT_SECRET || "tp1-development-secret";
const USER_ID = "64b000000000000000000001";
const OTHER_USER_ID = "64b000000000000000000002";

function bearerToken(userId = USER_ID) {
  return jwt.sign({ sub: userId }, JWT_SECRET, { expiresIn: "1h" });
}

test.before(async () => {
  server = createApp().listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => server.close());

test("health sans dépendre de MongoDB", async () => {
  const r = await fetch(base + "/api/health");
  assert.equal(r.status, 200);
  assert.equal((await r.json()).status, "ok");
});

test("schémas Mongoose et relation", () => {
  const u = new User({
    name: "Test",
    email: "TEST@example.com",
    password: "12345678",
  });

  assert.equal(u.email, "test@example.com");
  const t = new Track({
    ownerId: new mongoose.Types.ObjectId(),
    title: "Blues",
    originalName: "b.mp3",
    storedName: "x.mp3",
    mimeType: "audio/mpeg",
    size: 42,
  });
  
  assert.equal(t.title, "Blues");
  assert.equal(Track.schema.path("ownerId").options.ref, "User");
  assert.ok(Track.schema.path("artist"));
  assert.ok(Track.schema.path("coverSourceUrl"));
});

test("refuse une requête protégée sans JWT", async () => {
  const response = await fetch(base + "/api/tracks");

  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), {
    message: "Authentification requise",
  });
});

test("refuse une requête protégée avec un JWT invalide", async () => {
  const response = await fetch(base + "/api/tracks", {
    headers: { Authorization: "Bearer invalid-token" },
  });

  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), {
    message: "Jeton invalide ou expiré",
  });
});

test("refuse un upload sans fichier", async () => {
  const body = new FormData();
  body.append("title", "Fichier absent");

  const response = await fetch(base + "/api/tracks", {
    method: "POST",
    headers: { Authorization: `Bearer ${bearerToken()}` },
    body,
  });

  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), {
    message: "Fichier audio requis",
  });
});

test("refuse un upload dont le type MIME n'est pas accepté", async () => {
  const body = new FormData();
  body.append("audio", new Blob(["contenu de test"], { type: "application/pdf" }), "test.pdf");

  const response = await fetch(base + "/api/tracks", {
    method: "POST",
    headers: { Authorization: `Bearer ${bearerToken()}` },
    body,
  });

  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), {
    message: "Format audio non accepté",
  });
});

test("refuse une image de couverture non autorisée et nettoie l'audio temporaire", async () => {
  const uploadsPath = path.resolve("data/uploads");
  const existingFiles = (await fsPromises.readdir(uploadsPath)).sort();
  const body = new FormData();
  body.append("audio", new Blob(["audio"], { type: "audio/mpeg" }), "practice.mp3");
  body.append(
    "cover",
    new Blob(["not an image"], { type: "application/pdf" }),
    "cover.pdf",
  );

  const response = await fetch(base + "/api/tracks", {
    method: "POST",
    headers: { Authorization: `Bearer ${bearerToken()}` },
    body,
  });

  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), {
    message: "Format de couverture non accepté",
  });
  assert.deepEqual((await fsPromises.readdir(uploadsPath)).sort(), existingFiles);
});

test("applique les paramètres page et limit à la pagination", async () => {
  const items = [
    {
      _id: "64b000000000000000000010",
      title: "Piste de test",
      ownerId: USER_ID,
    },
  ];
  const aggregateMock = mock.method(Track, "aggregatePaginate", async (aggregate, options) => {
    assert.deepEqual(aggregate.pipeline(), [
      { $match: { ownerId: USER_ID } },
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
    ]);
    assert.equal(options.page, 3);
    assert.equal(options.limit, 10);
    return {
      docs: items,
      page: 3,
      limit: 10,
      totalDocs: 21,
      totalPages: 3,
    };
  });

  try {
    const response = await fetch(base + "/api/tracks?page=3&limit=10", {
      headers: { Authorization: `Bearer ${bearerToken()}` },
    });
    const result = await response.json();

    assert.equal(response.status, 200);
    assert.equal(result.page, 3);
    assert.equal(result.limit, 10);
    assert.equal(result.total, 21);
    assert.equal(result.pages, 3);
    assert.equal(result.items[0].id, items[0]._id);
    assert.equal(result.items[0].coverUrl, null);
    assert.equal(typeof Track.aggregatePaginate, "function");
  } finally {
    aggregateMock.mock.restore();
  }
});

test("recherche des pochettes via le catalogue public avec authentification", async () => {
  let requestedUrl;
  let requestedHeaders;
  const searchServer = createApp({
    fetchImpl: async (url, options) => {
      requestedUrl = new URL(url);
      requestedHeaders = options.headers;
      return new Response(JSON.stringify({
        releases: [
          {
            id: "a0b1c2d3-e4f5-4678-9234-567890abcdef",
            title: "Album de test",
            date: "2024",
            "artist-credit": [{ name: "Artiste", joinphrase: "" }],
            "cover-art-archive": { front: true },
          },
          {
            id: "b0b1c2d3-e4f5-4678-9234-567890abcdef",
            title: "Sans pochette",
            "cover-art-archive": { front: false },
          },
        ],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    },
  }).listen(0);
  await new Promise((resolve) => searchServer.once("listening", resolve));

  try {
    const response = await fetch(
      `http://127.0.0.1:${searchServer.address().port}/api/tracks/cover-search?title=Album%20test&artist=Artiste`,
      { headers: { Authorization: `Bearer ${bearerToken()}` } },
    );
    const result = await response.json();

    assert.equal(response.status, 200);
    assert.equal(requestedUrl.hostname, "musicbrainz.org");
    assert.match(requestedUrl.searchParams.get("query"), /release:/);
    assert.match(requestedUrl.searchParams.get("query"), /artist:/);
    assert.match(requestedHeaders["User-Agent"], /^GuitarPracticeCloud\//);
    assert.equal(result.items.length, 1);
    assert.equal(result.items[0].artist, "Artiste");
    assert.equal(
      result.items[0].sourceUrl,
      "https://musicbrainz.org/release/a0b1c2d3-e4f5-4678-9234-567890abcdef",
    );
    assert.equal(
      result.items[0].coverUrl,
      "https://coverartarchive.org/release/a0b1c2d3-e4f5-4678-9234-567890abcdef/front-250",
    );
  } finally {
    await new Promise((resolve, reject) => {
      searchServer.close((error) => error ? reject(error) : resolve());
    });
  }
});

test("sert une couverture distante via l'API authentifiée", async () => {
  const coverSourceUrl =
    "https://coverartarchive.org/release/a0b1c2d3-e4f5-4678-9234-567890abcdef/front-250";
  let fetchedUrl;
  const searchServer = createApp({
    fetchImpl: async (url) => {
      fetchedUrl = String(url);
      return new Response(Buffer.from("remote-image"), {
        status: 200,
        headers: { "Content-Type": "image/jpeg" },
      });
    },
  }).listen(0);
  await new Promise((resolve) => searchServer.once("listening", resolve));
  const findMock = mock.method(Track, "findOne", (filter) => {
    assert.deepEqual(filter, {
      _id: "64b000000000000000000030",
      ownerId: USER_ID,
    });
    return {
      select: async () => ({
        id: "64b000000000000000000030",
        coverSourceUrl,
      }),
    };
  });

  try {
    const response = await fetch(
      `http://127.0.0.1:${searchServer.address().port}/api/tracks/64b000000000000000000030/cover`,
      { headers: { Authorization: `Bearer ${bearerToken()}` } },
    );

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "image/jpeg");
    assert.equal(fetchedUrl, coverSourceUrl);
    assert.deepEqual(
      Buffer.from(await response.arrayBuffer()),
      Buffer.from("remote-image"),
    );
  } finally {
    findMock.mock.restore();
    await new Promise((resolve, reject) => {
      searchServer.close((error) => error ? reject(error) : resolve());
    });
  }
});

test("enregistre une couverture locale avec l'upload audio", async () => {
  let createdTrack;
  const createMock = mock.method(Track, "create", async (data) => {
    createdTrack = data;
    return {
      id: "64b000000000000000000020",
      toPublic: () => ({
        id: "64b000000000000000000020",
        title: data.title,
        artist: data.artist,
        coverUrl: "/api/tracks/64b000000000000000000020/cover",
      }),
    };
  });
  let findMock;
  const body = new FormData();
  body.append("audio", new Blob(["audio-data"], { type: "audio/mpeg" }), "practice.mp3");
  body.append("cover", new Blob(["image-data"], { type: "image/png" }), "cover.png");
  body.append("title", "Practice");
  body.append("artist", "Test artist");

  try {
    const response = await fetch(base + "/api/tracks", {
      method: "POST",
      headers: { Authorization: `Bearer ${bearerToken()}` },
      body,
    });
    const result = await response.json();

    assert.equal(response.status, 201);
    assert.equal(createdTrack.title, "Practice");
    assert.equal(createdTrack.artist, "Test artist");
    assert.equal(createdTrack.coverMimeType, "image/png");
    assert.match(createdTrack.coverStoredName, /\.png$/);
    assert.equal(result.coverUrl, "/api/tracks/64b000000000000000000020/cover");
    await fsPromises.access(path.resolve("data/uploads", createdTrack.coverStoredName));
    await fsPromises.access(path.resolve("data/uploads", createdTrack.storedName));

    findMock = mock.method(Track, "findOne", (filter) => {
      assert.deepEqual(filter, {
        _id: "64b000000000000000000020",
        ownerId: USER_ID,
      });
      return {
        select: async () => ({
          id: "64b000000000000000000020",
          coverStoredName: createdTrack.coverStoredName,
          coverMimeType: "image/png",
        }),
      };
    });
    const coverResponse = await fetch(
      base + "/api/tracks/64b000000000000000000020/cover",
      { headers: { Authorization: `Bearer ${bearerToken()}` } },
    );
    assert.equal(coverResponse.status, 200);
    assert.match(coverResponse.headers.get("content-type"), /image\/png/);
    assert.deepEqual(
      Buffer.from(await coverResponse.arrayBuffer()),
      Buffer.from("image-data"),
    );
  } finally {
    findMock?.mock.restore();
    createMock.mock.restore();
    if (createdTrack) {
      await fsPromises.unlink(path.resolve("data/uploads", createdTrack.coverStoredName));
      await fsPromises.unlink(path.resolve("data/uploads", createdTrack.storedName));
    }
  }
});

test("refuse une URL de couverture qui ne provient pas du Cover Art Archive", async () => {
  const createMock = mock.method(Track, "create", async () => {
    throw new Error("Le modèle ne doit pas être appelé pour une URL refusée.");
  });
  const body = new FormData();
  body.append("audio", new Blob(["audio-data"], { type: "audio/mpeg" }), "practice.mp3");
  body.append("coverUrl", "https://example.org/untrusted-image.png");

  try {
    const response = await fetch(base + "/api/tracks", {
      method: "POST",
      headers: { Authorization: `Bearer ${bearerToken()}` },
      body,
    });

    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), {
      message: "Choisissez une seule couverture provenant d’une source acceptée.",
    });
    assert.equal(createMock.mock.callCount(), 0);
  } finally {
    createMock.mock.restore();
  }
});

test("interdit la suppression d'une piste qui n'appartient pas à l'utilisateur", async () => {
  let queriedFilter;
  const deleteMock = mock.method(Track, "findOneAndDelete", (filter) => {
    queriedFilter = filter;
    return {
      select(fields) {
      assert.equal(fields, "+storedName +coverStoredName");
        return Promise.resolve(null);
      },
    };
  });

  try {
    const response = await fetch(
      base + "/api/tracks/64b000000000000000000099",
      {
        method: "DELETE",
        headers: { Authorization: `Bearer ${bearerToken(OTHER_USER_ID)}` },
      },
    );

    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { message: "Piste inconnue" });
    assert.deepEqual(queriedFilter, {
      _id: "64b000000000000000000099",
      ownerId: OTHER_USER_ID,
    });
  } finally {
    deleteMock.mock.restore();
  }
});
