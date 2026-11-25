# specs-mcp

Serveur MCP (stdio) qui expose les tools `spec_*` pour créer, lire, rechercher, valider et lister des specs markdown dans un projet. Réimplémentation TypeScript des tools `spec_*` du plugin opencode `opencode-team-lead`.

> État : socle du projet (config, serveur, utilitaires). Les tools `spec_*` arrivent dans les volets suivants.

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

## Développement

```sh
npm run build   # tsc -> dist/
npm test        # node --test via tsx
npm run lint    # tsc --noEmit (src + tests)
```
