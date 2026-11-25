# AGENTS.md — specs-mcp

Serveur MCP TypeScript (Node >= 22, ESM, `@modelcontextprotocol/sdk`, transport stdio, `zod`) qui porte les tools `spec_*` du plugin opencode `opencode-team-lead`.

## Structure

| Fichier | Rôle |
|---------|------|
| `src/index.ts` | Bin stdio (`#!/usr/bin/env node`). Lit argv/env, crée le serveur, se connecte. Erreurs de démarrage sur stderr (stdout porte le protocole). |
| `src/config.ts` | `resolveConfig(argv, env)` → `{ projectRoot: string \| null, paths: Readonly<{ specs }> }`. Racine : `--root` > `SPECS_ROOT` > null. Specs : `--specs-dir` > `SPECS_DIR` > `docs/specs`. |
| `src/server.ts` | `createServer(config)` → `{ server, getContext() }`. Racine paresseuse : config, sinon premier root `file://` du client (`roots/list`), sinon `process.cwd()`. |
| `src/spec-get.ts` | `specGet(projectRoot, paths, id, cursor?)` : port de `specGet` (résolution par id, lecture, `paginateArtifact` avec `metadata: { file, frontmatter }`). |
| `src/tools.ts` | `registerSpecTools(server, getContext)` : enregistre les 9 tools `spec_*` (descriptions et arguments du registry d'origine, `outputSchema` souple), la resource `spec://{id}` et les prompts `spec_format` / `write_spec`. |
| `src/frontmatter.ts` | `parseFrontmatter(content)` : port exact de l'original. |
| `src/result.ts` | `toolText` / `toolError` → `CallToolResult` (`isError: true` pour l'erreur) ; `jsonResult(text)` : texte JSON de l'original + `structuredContent` (erreur si l'objet porte `error`). |
| `tests/*.test.ts` | Tests `node:test` via `tsx`, fixtures dans des dossiers temporaires (`fs.mkdtemp`). `tests/mcp.test.ts` : intégration bout en bout (`InMemoryTransport` + `Client`), dont le snapshot des descriptions du registry d'origine. |
| `tests/parity/*.test.ts` | Tests différentiels : chaque scénario tourne sur l'implémentation d'origine puis sur le port, sur une copie fraîche d'une même racine, et les sorties sérialisées sont comparées (deep equal, ou égalité stricte des chaînes pour spec_get / spec_search / spec_read_section, curseurs compris). `helpers.ts` : chargement de l'origine, glue du registry, sandbox, neutralisations (documentées en tête de fichier). |

## Commandes

```sh
npm run build   # tsc -> dist/
npm test        # node --import tsx --test "tests/**/*.test.ts"
npm run lint    # tsc --noEmit sur src, puis sur src + tests (tsconfig.test.json)
npm run test:parity   # node --import tsx --test "tests/parity/*.test.ts" (parité avec l'origine seule)
```

`npm run build`, `npm test` et `npm run lint` doivent passer avant toute livraison. Pas de `any` gratuit ; TypeScript strict.

### Tests de parité

`npm test` inclut `tests/parity/` ; `npm run test:parity` ne lance qu'eux. Ils importent dynamiquement `lifecycle.js`, `artifact-pagination.js` et `spec-retrieval.js` (pas `registry.js`, qui dépend du runtime opencode, dont la glue est recopiée dans `tests/parity/helpers.ts`) depuis `ORIGIN_DIR` (défaut : `/Users/mickael/Documents/git/opencode-team-lead/tools`) :

```sh
ORIGIN_DIR=/chemin/vers/opencode-team-lead/tools npm run test:parity
```

Si un des trois fichiers manque, chaque fichier de parité enregistre un test explicitement ignoré (`skip`) avec la raison : le CI sans l'origine ne casse pas. Un import qui échoue alors que les fichiers existent reste une vraie erreur.

Les deux implémentations tournent sur la même racine (les curseurs hachent des chemins absolus), l'une après l'autre, chacune sur une copie fraîche. Seuls les écarts voulus sont neutralisés : `warnings` retiré des résultats de `spec_validate` côté port (sa présence est vérifiée), date `created` masquée, filtres `type` / `status` de `spec_list` jamais passés, couche MCP (`isError`, `structuredContent`, resources, prompts) hors périmètre. Une divergence non voulue se corrige dans `src/`, pas dans le test.

## Règle iso-fonctionnelle

Source de vérité (lecture seule) : le dépôt `opencode-team-lead`, dossiers `tools/` (`lifecycle.js` partie SPECS + `specFormat`, `artifact-pagination.js`, `spec-retrieval.js`, `registry.js`) et `tests/`.

Le portage est iso-fonctionnel : mêmes noms de tools, arguments, formes JSON de réponse, messages et codes d'erreur, limites (`PAGE_BYTES=16384`, `MAX_CURSOR_BYTES=1024`, top-5, passages de 2000 code points) et hints. Aucune correction de robustesse non demandée : pas d'écriture atomique, pas de durcissement realpath ajouté à `spec_get`/`spec_update`/`spec_delete`, `titleToId` identique (suppression des accents comprise).

Les fonctions internes gardent la signature `(projectRoot: string, paths: { specs: string }, ...)` de l'original, pour que les tests différentiels appellent ancien et nouveau code de la même façon.

## Écarts voulus (les seuls)

- `isError: true` + `structuredContent` / `outputSchema` côté MCP.
- Resources `spec://{id}`.
- Prompt MCP `spec_format`.
- Filtres optionnels `type` / `status` sur `spec_list`.
- Champ `warnings` dans `spec_validate` (sans changer `valid` / `issues`).

Tout autre écart (contrat public, stockage, permission, dépendance directe) demande un arbitrage préalable.

## Conventions

- Commits Conventional Commits.
- Dépendances : ne pas lancer `npm ci` / `npm install` dans un worktree qui partage `node_modules` avec le dépôt principal.
