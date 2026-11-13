# Developer Handover — Customer Success AI Hub

Stand: 2026-08-13. Für einen neuen Claude-Code-Chat, der die Entwicklung fortsetzt. Alle Aussagen unten wurden gegen den echten Code-/Repo-Zustand geprüft, nicht aus einer Chat-Historie übernommen.

## 1. Ziel und Nutzen

Beantwortet für einen CSM: *"Welcher Kunde braucht jetzt meine Aufmerksamkeit, warum ist das wichtig, und was sollte ich als Nächstes tun?"* Kombiniert deterministisch berechnete CS-Signale (Health Score, Priority Score, Expansion Score) mit generativer KI (Erklärung, Next Best Action). Die KI entscheidet nicht autonom — jede Aktion braucht menschliche Freigabe. Portfolio-Projekt für ein KI-Manager-Zertifikat, Präsentation nächste Woche.

## 2. Aktueller technischer Stand

- Vanilla-JS-SPA (kein Framework), statisches HTML + ein `<script type="module">`, kein Build-Schritt
- Serverless-API-Handler in `api/*.js`, lokal über einen custom Node-Server (`dev-server.js`) ausgeführt — `npm run dev` (vercel dev) hat sich in dieser Session lokal als unzuverlässig erwiesen; `npm run dev:local` ist der verlässliche Weg
- Datenquelle: `data/accounts.json` (35 fiktive Accounts, statische Datei, keine Datenbank)
- Git: Branch `master`, verbunden mit `github.com/ClaudiaL-21/customer-success-ai-hub`

## 3. Bereits implementierte Funktionen

- Health Score (8 gewichtete Kriterien), Score Breakdown, Sparkline mit Achsen/Prozent/Pfeil
- Expansion Score, Priority Score (`computePriorityScore` in `src/scoring.js`: Risk × ARR × Renewal-Nähe × Engagement)
- Portfolio-Tabelle mit Filtern (CSM, Region, Risk, Expansion, Trend), Matrix-Ansicht, Map (Leaflet), Team-Ansicht, Feedback-Aggregation
- AI Insight pro Account (Sentiment, Narrative, Confidence, Next Best Action) + Ask-Feld
- **Team/Portfolio Priority-Liste**: Formel bestimmt Reihenfolge, AI liefert Synthese + NBA pro Account + portfolioweiten Pattern-Alert (`handleTeamPriority` in `api/analyze.js`)
- **Ask about Portfolio**: freie Frage über alle aktuell gefilterten Accounts (`handlePortfolioAsk`, Modus `portfolio-ask`)
- Approve-Button (Einzel-Account und in der Priority-Liste) → `/api/approve-action` → optional n8n-Webhook → Google Sheet
- "Try Again"/"Reload"-Buttons bei allen AI-Fehlerzuständen und nach erfolgreichem Laden
- Dualer AI-Provider: direkte Anthropic/OpenAI-API **oder** n8n-Webhook, umschaltbar über `AI_PROVIDER` in `.env` (siehe `docs/06_n8n_integration.md`)

## 4. Wichtige Architekturentscheidungen

- **Trennung deterministisch/generativ ist das Kernprinzip**: Formeln bestimmen Zahlen/Reihenfolge, AI liefert nur Erklärung + Handlungsvorschlag, nie eigene Scores
- AI-Prompts erzwingen explizit "nutze nur die gegebene Zahl als Score, erfinde keine neue" (siehe `SYSTEM_PROMPT` in `api/analyze.js`)
- Kein Datenbankschicht bisher — bewusst noch nicht gebaut, siehe die interne Konzeptnotiz (nicht im Repo) für den geplanten Wechsel zu Supabase (volle Migration, kein Hybrid — Begründung dort)
- n8n wird für zwei unabhängige Zwecke genutzt: (a) optional als AI-Compute-Layer, (b) für den Approval-Workflow (Google Sheet Log) — beide über separate Webhook-URLs

## 5. Bekannte Probleme und technische Schulden

- **Projektname uneinheitlich**: `index.html` `<title>` = "CS AI Signal Hub", `<h1>` = "Customer Success AI Hub", `package.json` `name` = "customer-success-ai-hub" aber `description` nennt "CS AI Signal Hub", `README.md` Titel = "CS AI Signal Hub"
- **Datumsinkonsistenz zwischen Laufzeit und Datengenerierung**: `src/scoring.js` nutzt `TODAY = 2026-08-10`, aber `scripts/add-health-score-history.js`, `add-value-milestones.js`, `augment-feature-sentiment.js` nutzten beim Generieren `2026-08-11` (ein Tag Differenz). `data/accounts.json` selbst hat `generatedAt: 2026-08-10`. Kein aktiver Bug (Skripte laufen nicht zur Laufzeit), aber inkonsistent.
- **Kein sichtbares Referenzdatum im UI** — relative Angaben ("83d", "in 54 Tagen") sind ohne Kontext nicht einordenbar
- Approve-Button ist Ein-Klick-Übernahme ohne Review-/Edit-Schritt vor dem Absenden (siehe `docs/07`, Punkt P0-02)
- "Confidence" bei AI Insights ist reine LLM-Selbstauskunft, nicht aus Datenvollständigkeit abgeleitet (`docs/07`, P1-02)
- Keine Belege/Quellenverweise an einzelnen KI-Aussagen (`docs/07`, P0-03)
- Team-Priority-Ladezeit 15-20s ohne Fortschrittsanzeige
- Klickbare Tabellenzeilen sind `<tr onclick>`, nicht tastatur-/screenreader-zugänglich
- README.md "Next step"-Abschnitt ist veraltet (nennt bereits erledigte Punkte als offen)

## 6. Offene Aufgaben, priorisiert

Die vollständige Priorisierung liegt in einer internen Notiz (nicht im Repo). Kurzfassung:

1. Expansion-Guardrail hart erzwingen (High-Risk-Accounts → keine Growth-Empfehlung)
2. Confidence aus messbaren Faktoren statt LLM-Selbstauskunft
3. AI-Governance-/Trust-Seite
4. Echter Review-Schritt vor Approval
5. Belege/Quellen an KI-Aussagen
6. KI-Feedbackschleife (hilfreich/falsch/etc.)
7. Customer Outcomes/Success Plan (braucht Datenbank, siehe `docs/08`)

## 7. Relevante Dateien und Einstiegspunkte

| Datei | Zweck |
|---|---|
| `src/app.js` | Gesamte UI-Logik, State, Rendering (ca. 1100 Zeilen) |
| `src/scoring.js` | Alle deterministischen Berechnungen |
| `src/ai.js` | Client-seitige Fetch-Wrapper zu `/api/analyze`, `/api/approve-action` |
| `api/analyze.js` | Server-Handler für alle AI-Modi (`account-insight`, `ask`, `team-priority`, `portfolio-ask`) |
| `api/approve-action.js` | Approval-Handoff zu n8n |
| `api/_security.js` | Origin-Allowlist, Rate-Limit |
| `data/accounts.json` | Einzige Datenquelle |
| `dev-server.js` | Lokaler Server ohne Vercel-Abhängigkeit |
| `docs/05_project_brief.md` | Verbindlicher Projekt-Brief |
| `docs/06_n8n_integration.md` | n8n-Setup-Anleitung |

## 8. Lokal starten, testen, builden

```bash
npm run dev:local        # startet dev-server.js auf Port 5180 (empfohlener Weg)
```
Kein separater Build- oder Test-Schritt vorhanden — keine automatisierten Tests im Projekt. `.env` aus `.env.example` kopieren und ausfüllen (nicht committen). `MOCK_AI=true` erlaubt Testen ohne echte AI-Kosten.

## 9. Git-Status (Stand 2026-08-13, ungeprüft eingecheckt)

Modifiziert, nicht committed: `api/analyze.js`, `index.html`, `src/ai.js`, `src/app.js`, `src/scoring.js`, `src/styles.css`
Neu, nicht getrackt: `.claude/` (lokale Preview-Konfiguration)
Diese Änderungen enthalten die in Abschnitt 3 gelisteten Funktionen (Priority-Formel, Portfolio-Ask, Sparkline, Reload-Buttons) — noch kein Commit erfolgt.

## 10. Bewusst nicht umgesetzte Entscheidungen

- Kein Hybrid-Datenmodell (Teil-JSON/Teil-DB) — verworfen wegen Split-Brain-Risiko, siehe `docs/08`
- Kein automatischer/geplanter n8n-Trigger — nur durch explizite Nutzeraktion (Button-Klick)
- Kein öffentlich erreichbares n8n (Cloudflare Tunnel) — für die Präsentation nicht nötig, lokal ausreichend
- Kein MCP, kein Supabase, kein React — alles nur konzeptionell in `docs/08`, nicht begonnen
- Kein "Simulate Update"-Admin-Button — nur konzipiert, nicht gebaut

## 11. Risiken für die Präsentation nächste Woche

- AI-Antworten (egal ob n8n oder direkte API) dauern 15-40s ohne Fortschrittsanzeige — bei Live-Demo Timing einplanen oder vorab MOCK_AI/gecachte Ergebnisse vorbereiten
- Wenn n8n als Provider genutzt wird: Workflow muss auf **"Active"** stehen, sonst Fehler (siehe `docs/06`)
- Namensinkonsistenz (Abschnitt 5) ist bei genauem Hinsehen sichtbar
- Kein Fallback-Pfad dokumentiert, falls die AI-API während der Präsentation nicht erreichbar ist
