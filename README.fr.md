<img src="docs/assets/logo.svg" alt="" width="72" align="right">

# Netatmo Energy MCP

[English](README.md) | **Français**

[![CI](https://github.com/christophe77/netatmo-energy-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/christophe77/netatmo-energy-mcp/actions/workflows/ci.yml)
[![Licence : Apache-2.0](https://img.shields.io/badge/licence-Apache--2.0-blue.svg)](LICENSE)
![Node.js >= 22.19](https://img.shields.io/badge/node-%3E%3D22.19-339933)

Un **serveur MCP Netatmo** pour les **thermostats intelligents et vannes
thermostatiques Netatmo**. Il donne aux assistants IA un accès structuré
à votre chauffage :

- températures et consignes des pièces
- demande de chauffe et activité de la chaudière
- historique des températures
- analyses de chauffage déterministes
- plannings hebdomadaires de chauffe
- pilotage optionnel du chauffage : consignes des pièces, mode absent /
  hors-gel et plannings, chaque modification étant confirmée par vous

Il tourne sur votre machine et ne communique qu'avec l'**API Netatmo
Energy** officielle. Il est **en lecture seule par défaut** : il ne peut
modifier votre chauffage que si vous activez le
[mode écriture](#mode-écriture-pilotage-du-chauffage) à la connexion.

Il fonctionne avec tout client [Model Context Protocol](https://modelcontextprotocol.io)
capable de lancer des serveurs locaux, **quel que soit le modèle** :

- **Claude** : Claude Desktop, Claude Code
- **GPT / OpenAI** : Codex CLI, VS Code + GitHub Copilot, Cursor
- **Gemini** : Gemini CLI, VS Code + GitHub Copilot
- **Mistral et d'autres** via les clients multi-modèles
- **LLM locaux** (Llama, Qwen, Mistral, DeepSeek…) : LM Studio, et Ollama
  via Goose, Continue, Cline, AnythingLLM, LibreChat ou Open WebUI

Il fonctionne aussi dans Windsurf / Devin Desktop, Zed, Roo Code, Kilo
Code, JetBrains AI Assistant, Kiro et Warp. Voir
[tous les clients compatibles](#assistants-ia-et-clients-mcp-compatibles).

> **État : première version (0.2.0).** L'intégration de l'API Netatmo a été
> validée sur une installation réelle ; retours et rapports de compatibilité
> bienvenus.

## Pourquoi ce projet ?

Une installation de chauffage Netatmo enregistre des données utiles :

- la température et la consigne de chaque pièce
- ce que demande chaque vanne
- les moments où la chaudière est sollicitée

Ces données restent dans l'application Netatmo, où l'on peut les
consulter, mais pas leur poser de questions.

Ce projet est une petite passerelle entre l'API Netatmo Energy et
n'importe quel assistant IA compatible MCP. Posez une question simple :
« Quelle pièce était la plus froide cette nuit ? » L'assistant appelle un
outil précis et répond à partir de vos données. Il ne devine pas. Avec
le mode écriture, vous pouvez aussi dire « Mets la chambre à 19 °C
jusqu'à 7 h », puis confirmer la modification.

Les rares autres serveurs MCP Netatmo visent les **stations météo**.
Celui-ci est conçu pour les **thermostats, vannes thermostatiques et
l'historique de chauffage**. Voir [docs/research.md](docs/research.md)
(en anglais).

## Fonctionnalités

- **Découverte :** logements, pièces, thermostats, vannes thermostatiques,
  relais et passerelles.
- **État actuel**
  - Par pièce : température, consigne, mode de consigne et demande de
    chauffe.
  - Chaudière en marche ou à l'arrêt, détection de fenêtre ouverte.
  - État des équipements : piles, signal radio/Wi-Fi, joignabilité.
- **Historique**
  - Température et consigne des pièces, avec une résolution de 30 min
    à 1 mois.
  - Activité de la chaudière (installations avec thermostat Netatmo).
  - Les longues périodes sont récupérées par morceaux et résumées, pour
    garder des réponses courtes.
  - Les trous de données sont signalés, jamais comblés.
- **Analyses de chauffage.** Ce sont des calculs déterministes ; aucun
  modèle d'IA ne calcule les chiffres.
  - Statistiques par pièce.
  - Temps sous, dans ou au-dessus de la consigne.
  - Plus forte baisse de température et vitesse de refroidissement.
  - Classement des pièces.
  - Détection par règles des relevés inhabituels, chacun avec sévérité
    et niveau de confiance.
- **Plannings hebdomadaires :** zones (Confort, Nuit, Éco…), consigne de
  chaque pièce par zone et programme horaire, en jours et heures lisibles.
- **Pilotage du chauffage (mode écriture, sur activation)**
  - Consignes temporaires de pièce qui se terminent toujours (3 h par
    défaut, 24 h au plus), ou retour au planning.
  - Mode du logement : planning, absent ou hors-gel, éventuellement
    jusqu'à une date.
  - Changer de planning, en créer, les modifier et les renommer.
  - Chaque modification est présentée et exige votre confirmation
    explicite. Températures limitées à 7–28 °C par défaut.
- **15 outils MCP en lecture seule, 6 outils de pilotage, 4 ressources et
  4 prompts** (rapport quotidien, revue des anomalies, comparaison des
  pièces, revue des habitudes de chauffage).
- **Mise en place simple**
  - Connexion OAuth2 dans le navigateur avec une seule commande `login`.
  - Jetons stockés de façon sécurisée et renouvelés automatiquement.
  - `doctor` vérifie votre configuration.

## Démarrage rapide

Il faut Node.js 22.19 ou plus récent et un compte Netatmo avec des
équipements Energy.

### 1. Créer une application développeur Netatmo (gratuite)

1. Sur <https://dev.netatmo.com/apps>, choisissez **Create**.
2. Indiquez l'**URI de redirection** `http://localhost:8977/callback`.
3. Notez le **client ID** et le **client secret** pour l'étape 2.

Guide détaillé (en anglais) : [docs/authentication.md](docs/authentication.md).

### 2. Se connecter

```bash
npx -y netatmo-energy-mcp login
```

`login` demande le client ID et le secret, puis ouvre votre navigateur :
vous vous connectez sur netatmo.com et autorisez un accès **en lecture
seule**. Pour permettre à l'assistant de modifier votre chauffage,
utilisez plutôt `login --write` (voir le
[mode écriture](#mode-écriture-pilotage-du-chauffage)). Vérifiez ensuite
la configuration :

```bash
npx -y netatmo-energy-mcp doctor
```

> **Depuis les sources :** clonez le dépôt, lancez `pnpm install && pnpm build`,
> puis utilisez `node /chemin/vers/netatmo-energy-mcp/dist/index.js` à la
> place de `npx -y netatmo-energy-mcp`.

### 3. Connecter votre assistant IA

La plupart des clients utilisent le même bloc JSON `mcpServers`. Il
fonctionne pour Claude Desktop, Cursor, Windsurf / Devin Desktop, Cline,
Roo Code, Kiro, LM Studio, JetBrains AI Assistant, AnythingLLM, Warp et
Gemini CLI :

```json
{
  "mcpServers": {
    "netatmo-energy": {
      "command": "npx",
      "args": ["-y", "netatmo-energy-mcp"]
    }
  }
}
```

Clients en ligne de commande :

```bash
# Claude Code
claude mcp add --transport stdio --scope user netatmo-energy -- npx -y netatmo-energy-mcp
# OpenAI Codex CLI
codex mcp add netatmo-energy -- npx -y netatmo-energy-mcp
# GitHub Copilot CLI
copilot mcp add netatmo-energy -- npx -y netatmo-energy-mcp
```

**VS Code + GitHub Copilot.** Ajoutez ceci à `.vscode/mcp.json` ; notez la
clé `servers` :

```json
{
  "servers": {
    "netatmo-energy": { "type": "stdio", "command": "npx", "args": ["-y", "netatmo-energy-mcp"] }
  }
}
```

Aucun secret dans ces fichiers : `login` les a enregistrés dans votre
dossier de configuration utilisateur. L'emplacement des fichiers pour
chaque client, ainsi que Zed, Continue, Goose, LibreChat, Kilo Code, Msty
et Open WebUI, se trouvent dans [examples/](examples/README.md) (en anglais).

### 4. Poser une question

> « Quelle est la température de chaque pièce en ce moment ? »

## Exemples de questions

Voici le type de questions pour lesquelles les outils sont conçus.
L'assistant choisit les outils ; le tableau indique lesquels répondent à
chaque question.

| Question                                                                           | Outils utilisés                                               |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| « Quelle température fait-il dans ma chambre, et la consigne est-elle atteinte ? » | `netatmo_get_room_status`                                     |
| « La chaudière tourne-t-elle ? Quelles pièces demandent de la chauffe ? »          | `netatmo_get_heating_status`                                  |
| « Combien de temps la chaudière a-t-elle fonctionné hier ? »                       | `netatmo_get_boiler_history`                                  |
| « Montre la température du séjour sur les 7 derniers jours. »                      | `netatmo_get_temperature_history`                             |
| « Compare mes pièces sur la semaine. Laquelle refroidit le plus vite ? »           | `netatmo_compare_rooms`                                       |
| « Mon chauffage a-t-il eu un comportement inhabituel cette nuit ? »                | `netatmo_detect_anomalies`                                    |
| « Fais-moi le rapport de chauffage d'hier. »                                       | prompt `heating_daily_report` → `netatmo_get_heating_summary` |
| « Des piles de vannes sont-elles faibles ? »                                       | `netatmo_get_device_status`                                   |
| « À quoi ressemble mon planning de la semaine ? »                                  | `netatmo_get_schedules`                                       |
| _Mode écriture :_ « Chauffe le bureau à 21 °C pendant 2 heures. »                  | `netatmo_set_room_setpoint`                                   |
| _Mode écriture :_ « Je suis absent jusqu'à dimanche soir. »                        | `netatmo_set_home_mode`                                       |
| _Mode écriture :_ « Baisse la zone Nuit à 17 °C dans toutes les chambres. »        | `netatmo_get_schedules` → `netatmo_update_schedule`           |

Le « temps de fonctionnement » de la chaudière est le temps pendant
lequel le thermostat **demandait de la chauffe**. Netatmo ne mesure pas
la consommation de gaz ou d'énergie : ce projet ne l'affiche donc jamais.

## Outils MCP disponibles

Les outils en lecture seule n'ont besoin que du droit OAuth
`read_thermostat`. La référence complète, avec arguments et résultats,
est générée à partir du serveur lui-même : [docs/tools.md](docs/tools.md)
(en anglais).

| Outil                             | Description                                                               |
| --------------------------------- | ------------------------------------------------------------------------- |
| `netatmo_list_homes`              | Logements équipés, nombre de pièces et d'équipements                      |
| `netatmo_get_home`                | Détails d'un logement : mode de chauffage, plannings, pièces, équipements |
| `netatmo_list_rooms`              | Pièces avec identifiants, types et équipements                            |
| `netatmo_list_devices`            | Thermostats, vannes, relais : modèle, pièce, passerelle                   |
| `netatmo_get_home_status`         | État actuel de chaque pièce, chaudière, alertes                           |
| `netatmo_get_room_status`         | Température et consigne actuelles d'une pièce                             |
| `netatmo_get_heating_status`      | Chaudière en marche ou non, pièces qui demandent de la chauffe            |
| `netatmo_get_device_status`       | Piles, signal, joignabilité, firmware                                     |
| `netatmo_get_temperature_history` | Historique de température avec statistiques et trous de données           |
| `netatmo_get_setpoint_history`    | Historique des consignes et périodes de consigne                          |
| `netatmo_get_boiler_history`      | Temps de demande de chauffe par heure, jour ou semaine                    |
| `netatmo_get_heating_summary`     | Indicateurs de confort par pièce et temps chaudière sur une période       |
| `netatmo_compare_rooms`           | Indicateurs et classements des pièces                                     |
| `netatmo_detect_anomalies`        | Relevés inhabituels avec sévérité, confiance et éléments factuels         |
| `netatmo_get_schedules`           | Plannings hebdomadaires : zones, consignes par pièce, programme horaire   |

**Mode écriture uniquement.** Chaque modification exige votre confirmation.

| Outil                       | Description                                                         |
| --------------------------- | ------------------------------------------------------------------- |
| `netatmo_set_room_setpoint` | Consigne temporaire ou boost d'une pièce, ou retour au planning     |
| `netatmo_set_home_mode`     | Mode planning, absent ou hors-gel, éventuellement jusqu'à une date  |
| `netatmo_switch_schedule`   | Activer un autre planning hebdomadaire                              |
| `netatmo_create_schedule`   | Nouveau planning copié d'un planning existant, avec modifications   |
| `netatmo_update_schedule`   | Consignes par zone, températures absent/hors-gel, programme horaire |
| `netatmo_rename_schedule`   | Renommer un planning (expérimental : point d'accès non documenté)   |

Ressources : `netatmo://homes` et `netatmo://homes/{homeId}/rooms`,
`…/devices` et `…/status`.

## Mode écriture (pilotage du chauffage)

Le mode écriture est **désactivé par défaut**. Pour l'activer,
reconnectez-vous avec :

```bash
npx -y netatmo-energy-mcp login --write
```

Le droit OAuth `write_thermostat` est alors demandé en plus. Les outils
de pilotage apparaissent après le redémarrage de votre client MCP.

Garde-fous :

- **Vous confirmez chaque modification.** Les clients qui gèrent
  l'élicitation MCP vous le demandent directement. Avec les autres, le
  premier appel ne renvoie qu'un aperçu et un jeton à usage unique ;
  l'assistant doit vous montrer l'aperçu et obtenir votre accord avant de
  rappeler l'outil. Rien n'est envoyé à Netatmo avant.
- **Limites.** Les températures doivent rester entre 7 et 28 °C. Les
  consignes manuelles se terminent après 3 h par défaut, 24 h au plus.
  Modifiables avec `NETATMO_MCP_MIN_TEMP`, `NETATMO_MCP_MAX_TEMP` et
  `NETATMO_MCP_MAX_SETPOINT_HOURS`.
- **Coupe-circuit.** `NETATMO_MCP_WRITE=0` force la lecture seule, même
  avec une connexion autorisée en écriture.
- **Journal.** Chaque modification appliquée ou en échec est ajoutée à
  `changes.log` dans votre dossier de configuration.
- **Pas de nouvel essai automatique.** Une écriture en échec n'est jamais
  renvoyée à l'aveugle.

Netatmo ne fournit aucune API pour supprimer un planning : ceux créés ici
ne peuvent être supprimés que dans l'application Netatmo. Renommer un
planning et choisir un planning avec le mode « planning » utilisent des
paramètres Netatmo non documentés : ils sont marqués expérimentaux.
Détails (en anglais) : [docs/configuration.md](docs/configuration.md#write-mode).

## Équipements compatibles

| Équipement                                 | Type Netatmo  | État                                                                         |
| ------------------------------------------ | ------------- | ---------------------------------------------------------------------------- |
| Thermostat intelligent                     | `NATherm1`    | **Testé.** API validée sur une installation réelle (08/10/2026)              |
| Vanne thermostatique intelligente          | `NRV`         | **Testé.** Même installation (6 vannes)                                      |
| Relais thermostat                          | `NAPlug`      | **Testé.** Même installation                                                 |
| Thermostat modulant / passerelle OpenTherm | `OTM` / `OTH` | Devrait fonctionner, **non testé**                                           |
| BTicino Smarther with Netatmo              | `BNS`         | Non pris en charge en v0.1 (nécessite probablement le droit `read_smarther`) |

Lancez `netatmo-energy-mcp probe` et ouvrez un
[rapport de compatibilité](https://github.com/christophe77/netatmo-energy-mcp/issues/new?template=device_compatibility.yml)
pour compléter ce tableau. Les données du probe sont anonymisées.

## Assistants IA et clients MCP compatibles

C'est un **serveur MCP local (stdio)** standard : il n'est lié à aucun
éditeur d'IA. Tout client MCP capable de lancer des serveurs locaux peut
l'utiliser, avec le modèle de son choix.

| Client                                                                    | Modèles                                                          |
| ------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Claude Desktop, Claude Code                                               | Claude                                                           |
| OpenAI Codex CLI                                                          | modèles GPT d'OpenAI                                             |
| Gemini CLI                                                                | Google Gemini                                                    |
| VS Code + GitHub Copilot (mode agent), GitHub Copilot CLI                 | GPT, Claude, Gemini et autres modèles Copilot                    |
| Cursor, Windsurf / Devin Desktop, Zed, Warp, Kiro, JetBrains AI Assistant | plusieurs modèles hébergés                                       |
| Cline, Roo Code, Kilo Code, Continue                                      | plusieurs, y compris modèles locaux (Ollama, LM Studio)          |
| LM Studio                                                                 | **modèles open source locaux** : Llama, Qwen, Mistral, DeepSeek… |
| Goose, AnythingLLM, LibreChat, Msty Studio                                | nombreux fournisseurs, dont **Ollama**                           |
| Open WebUI                                                                | Ollama et autres, via le proxy `mcpo`                            |

La configuration de chaque client, vérifiée dans sa documentation
officielle : [examples/](examples/README.md) (en anglais).

**Non compatibles :** les assistants qui n'acceptent que des serveurs MCP
_distants_ (applications et connecteurs ChatGPT, Claude.ai sur le web,
Mistral Le Chat). Ce serveur est local par conception : vos identifiants
ne quittent jamais votre machine.

**Tests.** Le serveur est testé avec le client officiel du SDK MCP et le
MCP Inspector. La qualité des appels d'outils avec de petits modèles
locaux dépend du modèle. Signalez tout problème propre à un client.

## Authentification

Ce projet utilise le flux OAuth2 « authorization code » de Netatmo. Vous
vous connectez sur netatmo.com ; votre mot de passe Netatmo n'est jamais
vu par cet outil.

**Droit demandé.** Par défaut, seul `read_thermostat` est demandé : un
jeton divulgué ne pourrait pas modifier votre chauffage. `login --write`
demande aussi `write_thermostat`.

**Votre propre application.** Chaque utilisateur crée une application
développeur Netatmo gratuite. Le secret client ne peut pas être livré
dans un code open source.

**Renouvellement.** Les jetons d'accès sont renouvelés automatiquement.
Plusieurs clients MCP ouverts en même temps se coordonnent via un fichier
de verrou, pour ne pas invalider les jetons les uns des autres.

Détails (en anglais) : [docs/authentication.md](docs/authentication.md).

## Confidentialité et sécurité

**Ce qui quitte votre machine.** Uniquement des requêtes HTTPS vers
`api.netatmo.com`. En lecture seule, seuls 4 points d'accès en lecture
sont appelés : le client refuse toute écriture avant le moindre accès
réseau, et des tests le vérifient. En mode écriture, une modification
n'est envoyée qu'après votre confirmation.

**Ce qui reste en local.**

- Les identifiants sont dans `credentials.json`, dans votre dossier de
  configuration utilisateur, lisible uniquement par votre compte (`0600`
  sous macOS/Linux ; ACL restreinte sous Windows).
- Aucune télémétrie, aucun suivi, aucun service tiers.
- Le serveur dialogue avec votre client MCP par stdio et n'ouvre aucun
  port réseau.

**Votre fournisseur d'IA.** Les données renvoyées par les outils sont
lues par l'assistant que vous utilisez, donc traitées par son fournisseur
de modèle.

**Ni données de compte ni localisation.** Votre e-mail et les
coordonnées de votre logement ne sont jamais renvoyés.

En savoir plus (en anglais) :

- [Modèle de sécurité](docs/architecture.md#10-security-model)
- [Revue de sécurité avant publication](docs/security-review.md)
- [Signaler une vulnérabilité](SECURITY.md)

## Architecture

![Architecture : l'assistant IA dialogue par stdio avec le serveur local, qui interroge l'API Netatmo (en lecture seule par défaut)](docs/assets/architecture.svg)

Le client Netatmo et les analyses sont indépendants de MCP. Les décisions
de conception sont consignées dans des [ADR](docs/adr/README.md), et
[docs/architecture.md](docs/architecture.md) décrit les couches.

## Limites

Elles viennent de l'API Netatmo Energy ; détails dans
[docs/api-capabilities.md](docs/api-capabilities.md).

- **Pas de consommation d'énergie ni de gaz.** L'activité de la chaudière
  est un temps de _demande_ de chauffe. Avec des données agrégées, le
  nombre de cycles du brûleur ne peut pas être connu.
- **Pas d'historique de la demande de chauffe des vannes.** Elle n'est
  disponible qu'en valeur instantanée. Un futur collecteur optionnel
  pourra l'enregistrer ([ADR-0011](docs/adr/0011-future-snapshot-collector.md)).
- **Pas de température extérieure dans l'API Energy.** Le contexte météo
  est prévu pour la v0.4.
- **L'historique va jusqu'à 30 minutes de résolution, pas plus fin.**
  Chaque requête renvoie au plus 1024 valeurs, donc les longues périodes
  utilisent des pas plus grossiers.
- **La documentation ne correspond pas toujours à l'API.** Les données
  réelles montrent que les mesures chaudière sont en **secondes**, et non
  en minutes comme documenté. Ce projet les convertit.
- **Limites de débit.** Netatmo limite les requêtes par utilisateur et
  par application. Le serveur se limite lui-même et met en cache la
  topologie et l'état actuel.

## Feuille de route

| Version   | Objectif                                             |
| --------- | ---------------------------------------------------- |
| v0.1      | Serveur MCP en lecture seule                         |
| v0.2      | Plannings, pilotage optionnel (version actuelle)     |
| v0.3      | Diagnostics plus riches                              |
| v0.4      | Contexte météo (Open-Meteo)                          |
| v0.5–v0.7 | Modélisation thermique, prévisions, jumeau numérique |
| v1.0      | Une interface stable                                 |

Le mode écriture ne sera jamais activé par défaut.
Voir [docs/roadmap.md](docs/roadmap.md).

## Contribuer

Les signalements de bugs, les rapports de compatibilité et les pull
requests sont les bienvenus. Voir [CONTRIBUTING.md](CONTRIBUTING.md) pour
installer le projet, qui fonctionne avec des réponses d'API simulées :
pas besoin de compte Netatmo. Merci de respecter le
[code de conduite](CODE_OF_CONDUCT.md).

## Licence

[Apache-2.0](LICENSE)

## Avertissement

Projet open source indépendant, ni affilié à Netatmo ou Legrand, ni
approuvé ou sponsorisé par eux. « Netatmo » est une marque de son
propriétaire, citée ici uniquement pour indiquer la compatibilité.
Utilisation à vos risques ; la sécurité de votre chauffage ne doit jamais
dépendre d'un assistant IA.
