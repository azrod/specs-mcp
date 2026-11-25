# specs-mcp

Serveur MCP (stdio) qui expose les tools `spec_*` pour créer, lire, rechercher, valider et lister des specs markdown dans un projet. Réimplémentation TypeScript des tools `spec_*` du plugin opencode `opencode-team-lead`.

## Installation

Prérequis : Node.js >= 22.

```sh
npm install
npm run build
```

Le binaire est `dist/index.js` (`specs-mcp` une fois le paquet installé).

## Configuration du client

### opencode

Dans `opencode.json` :

```json
{
  "mcp": {
    "specs": {
      "type": "local",
      "command": ["node", "/chemin/vers/specs-mcp/dist/index.js"],
      "enabled": true
    }
  }
}
```

Avec options : `"command": ["node", "/chemin/vers/specs-mcp/dist/index.js", "--specs-dir", "docs/specs"]`.

### Claude Desktop

Dans `claude_desktop_config.json` :

```json
{
  "mcpServers": {
    "specs": {
      "command": "node",
      "args": ["/chemin/vers/specs-mcp/dist/index.js", "--root", "/chemin/vers/projet"]
    }
  }
}
```

Claude Desktop n'annonce pas de root exploitable : passe `--root` (ou `SPECS_ROOT`), sinon le serveur travaille dans son répertoire courant.

## Options

| Option | Variable d'environnement | Défaut | Rôle |
|--------|--------------------------|--------|------|
| `--root <dir>` | `SPECS_ROOT` | aucun | Racine du projet. |
| `--specs-dir <dir>` | `SPECS_DIR` | `docs/specs` | Dossier des specs, relatif à la racine. Une valeur vide est une erreur (`paths.specs must be a non-empty string`). |

L'option de la ligne de commande l'emporte sur la variable d'environnement.

Sans `--root` ni `SPECS_ROOT`, la racine est le premier root `file://` annoncé par le client MCP (`roots/list`), sinon `process.cwd()`. Elle est résolue au premier appel d'un tool.

## Tools

Neuf tools, mêmes noms, arguments et réponses que le plugin d'origine. Les arguments sont tous des chaînes ; ceux marqués « optionnel » peuvent être omis.

| Tool | Arguments | Rôle |
|------|-----------|------|
| `spec_get` | `id`, `cursor`? | Lit une page bornée (16 384 octets) d'une spec, avec `file` et `frontmatter` du document entier. Continuer avec `pagination.next_cursor` tant que `pagination.has_more` est vrai. |
| `spec_search` | `query`, `id`?, `type`?, `status`? | Cherche jusqu'à cinq passages (jetons lettres/chiffres, OR) avec citation fichier/lignes et `source_hash`. |
| `spec_read_section` | `id`, `section_id`, `source_hash`, `cursor`? | Développe une section citée par `spec_search`, par pages ; `STALE_SOURCE` / `STALE_CURSOR` si la spec a changé. |
| `spec_create` | `title`, `type`?, `content`? | Crée une spec (`type` par défaut : `technical`, statut `draft`). Refuse d'écraser. |
| `spec_update` | `id`, `old_string`, `new_string` | Remplace une occurrence unique. |
| `spec_validate` | `id` | Validation structurelle. `valid` / `issues` portent les erreurs bloquantes, `warnings` les écarts au format (type/statut inconnus, sections requises absentes ou dans le désordre). |
| `spec_list` | `type`?, `status`? | Liste les specs avec leurs métadonnées ; les filtres comparent exactement, sans tenir compte de la casse. |
| `spec_delete` | `id` | Supprime une spec. |
| `spec_format` | aucun | Renvoie le format canonique d'une spec, en texte brut. |

Réponses : le texte est le JSON de l'original (sauf `spec_format`, texte brut) et le même objet est repris dans `structuredContent`, décrit par un `outputSchema`. Un échec renvoie `{ "error": "…" }` (avec `code` pour la pagination et la recherche) et `isError: true`.

## Resources

Template `spec://{id}` : `id` est le nom du fichier sans `.md` (insensible à la casse). La liste (`resources/list`) donne une entrée par spec du dossier (`name` = id, `title` = titre du frontmatter, `mimeType` = `text/markdown`). La lecture renvoie le fichier complet, sans pagination. Une spec inconnue répond par l'erreur MCP `-32002`. Le serveur notifie `resources/list_changed` après un `spec_create` ou `spec_delete` réussi.

## Prompts

| Prompt | Arguments | Contenu |
|--------|-----------|---------|
| `spec_format` | aucun | Le format canonique d'une spec. |
| `write_spec` | `title`, `type`? | Embarque le format, demande de rédiger la spec puis d'appeler `spec_create` et `spec_validate`. |

## Développement

```sh
npm run build   # tsc -> dist/
npm test        # node --test via tsx
npm run lint    # tsc --noEmit (src + tests)
npm run test:parity   # parité avec l'implémentation d'origine (ORIGIN_DIR), ignorée si elle est absente
```
