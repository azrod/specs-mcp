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

## Commandes

```sh
npm run build   # tsc -> dist/
npm test        # node --import tsx --test "tests/**/*.test.ts"
npm run lint    # tsc --noEmit sur src, puis sur src + tests (tsconfig.test.json)
```

`npm run build`, `npm test` et `npm run lint` doivent passer avant toute livraison. Pas de `any` gratuit ; TypeScript strict.

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
