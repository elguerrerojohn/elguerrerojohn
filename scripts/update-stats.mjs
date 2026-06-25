// Actualiza el bloque de estadísticas del README leyendo datos reales de GitHub.
//
// Seguridad: usa el GITHUB_TOKEN efímero del workflow (no requiere ningún PAT
// almacenado en secrets). Consulta los datos públicos del usuario vía `user(login)`.
// Las contribuciones en repos privados se reflejan de forma anónima sólo si el
// usuario activa "Include private contributions on my profile" en su perfil.
import { readFile, writeFile } from "node:fs/promises";

const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
if (!token) {
  console.error("Falta el token. En GitHub Actions usá GH_TOKEN: ${{ github.token }}.");
  process.exit(1);
}

const LOGIN = process.env.GH_LOGIN || "elguerrerojohn";
const ENDPOINT = "https://api.github.com/graphql";
const README_PATH = "README.md";
const MAX_RETRIES = 3;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function runGraphql(query, variables = {}) {
  let lastError;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await fetch(ENDPOINT, {
        method: "POST",
        headers: {
          Authorization: `bearer ${token}`,
          "Content-Type": "application/json",
          "User-Agent": "profile-stats-updater",
        },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(20000),
      });

      // 5xx y 429 son transitorios: reintentar. 4xx (auth/scopes) son definitivos.
      if (!response.ok) {
        const body = await response.text();
        if (response.status >= 500 || response.status === 429) {
          throw new Error(`HTTP ${response.status}: ${body}`);
        }
        console.error(`HTTP ${response.status}: ${body}`);
        process.exit(1);
      }

      const payload = await response.json();
      if (payload.errors) {
        throw new Error(`GraphQL: ${JSON.stringify(payload.errors)}`);
      }
      return payload.data;
    } catch (error) {
      lastError = error;
      if (attempt < MAX_RETRIES) {
        const backoff = 1000 * 2 ** (attempt - 1);
        console.warn(`Intento ${attempt} falló (${error.message}). Reintentando en ${backoff}ms…`);
        await sleep(backoff);
      }
    }
  }
  throw lastError;
}

async function fetchTotalStars() {
  let totalStars = 0;
  let cursor = null;
  let hasNextPage = true;

  while (hasNextPage) {
    const data = await runGraphql(
      `query($login: String!, $cursor: String) {
        user(login: $login) {
          repositories(first: 100, after: $cursor, ownerAffiliations: OWNER, isFork: false, privacy: PUBLIC) {
            pageInfo { hasNextPage endCursor }
            nodes { stargazerCount }
          }
        }
      }`,
      { login: LOGIN, cursor }
    );

    const repositories = data.user.repositories;
    totalStars += repositories.nodes.reduce((sum, repo) => sum + repo.stargazerCount, 0);
    hasNextPage = repositories.pageInfo.hasNextPage;
    cursor = repositories.pageInfo.endCursor;
  }

  return totalStars;
}

function buildStatsBlock({
  contributions,
  privateContributions,
  pullRequests,
  stars,
  repositories,
}) {
  const formatNumber = (value) => value.toLocaleString("es-CO");
  const updatedAt = new Intl.DateTimeFormat("es-CO", {
    month: "long",
    year: "numeric",
    timeZone: "America/Bogota",
  }).format(new Date());

  return `<!-- STATS:START -->
> Datos reales actualizados a ${updatedAt} _(incluye actividad en repos privados)_

| | |
|---|---|
| 🔥 Contribuciones (último año) | **${formatNumber(contributions)}** |
| 🔒 De ellas, en repos privados | **${formatNumber(privateContributions)}** |
| 🔀 Pull Requests | **${formatNumber(pullRequests)}** |
| ⭐ Stars recibidas | **${formatNumber(stars)}** |
| 📦 Repositorios públicos | **${formatNumber(repositories)}** |
<!-- STATS:END -->`;
}

async function main() {
  const summary = await runGraphql(
    `query($login: String!) {
      user(login: $login) {
        contributionsCollection {
          restrictedContributionsCount
          contributionCalendar { totalContributions }
        }
        pullRequests { totalCount }
        repositories(ownerAffiliations: OWNER, isFork: false, privacy: PUBLIC) { totalCount }
      }
    }`,
    { login: LOGIN }
  );

  const contributionsCollection = summary.user.contributionsCollection;
  const stars = await fetchTotalStars();

  const statsBlock = buildStatsBlock({
    contributions: contributionsCollection.contributionCalendar.totalContributions,
    privateContributions: contributionsCollection.restrictedContributionsCount,
    pullRequests: summary.user.pullRequests.totalCount,
    stars,
    repositories: summary.user.repositories.totalCount,
  });

  const readme = await readFile(README_PATH, "utf8");
  const markers = /<!-- STATS:START -->[\s\S]*<!-- STATS:END -->/;
  if (!markers.test(readme)) {
    console.error("No se encontraron los marcadores STATS:START/STATS:END en el README.");
    process.exit(1);
  }

  const updatedReadme = readme.replace(markers, statsBlock);
  if (updatedReadme === readme) {
    console.log("Las estadísticas ya estaban al día. Sin cambios.");
    return;
  }

  await writeFile(README_PATH, updatedReadme);
  console.log("README actualizado con las estadísticas más recientes.");
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
