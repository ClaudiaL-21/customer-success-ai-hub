# Customer Success AI Hub – Projektübersicht für die Bewerbung bei n8n

> Zweck dieses Dokuments: Übergabe an ChatGPT, damit daraus eine Bewerbung bei n8n entsteht, die auf das Projekt und seine Screenshots aufmerksam macht. Alle Aussagen unten sind belegt (Code, Tests, laufende Workflows, Screenshots). Bitte nichts hinzuerfinden und keine Produktivität behaupten, die es nicht gibt (siehe Abschnitt „Ehrliche Grenzen“).

## 1. In einem Satz

Ein Customer-Success-Cockpit mit KI-Copilot, bei dem **n8n alles übernimmt, was die Außenwelt berührt** (KI-Aufrufe, E-Mail-Eingang, Audit-Log, Benachrichtigungen), während die KI **nur vorschlägt** und **ein Mensch zweimal entscheidet**, bevor irgendetwas passiert.

## 2. Das Problem und die Idee

Customer Success Manager (CSMs) betreuen viele Kunden und erfahren Risiken oft zu spät. Kundenmails, Tickets und Kennzahlen liegen verstreut. Das Projekt zeigt, wie man daraus ein verlässliches Frühwarnsystem baut, **ohne der KI Entscheidungen zu überlassen**.

Leitprinzip: **„The Hub decides what is true. n8n does the work.“**
- Der Hub berechnet Health Scores und Rankings deterministisch (kein Modell entscheidet über Zahlen oder Reihenfolge).
- n8n erledigt die zwei Dinge, die nach außen wirken: ein KI-Modell aufrufen und eine freigegebene Aktion ausführen.

## 3. Was gebaut wurde

- **Hub (Web-App):** Portfolio, Matrix, Team, Karte, QBRs, Feature-Requests, Trust-Seite, **Customer Intelligence Inbox**. Demo-Daten sind vollständig fiktiv (35 Accounts, 6 CSMs).
- **KI-Copilot in sechs Modi:** Portfolio-Zusammenfassung, Fragen ans Portfolio, Account-Insight mit Next Best Action, Fragen zu einem Account, Team-Priorisierung, QBR-Entwurf in drei Versionen (intern, Kunde, Präsentation).
- **Drei n8n-Workflows** (siehe Abschnitt 5), alle mit Sticky Notes dokumentiert.
- **Supabase** als Datenbank (Postgres mit Row Level Security, Datenbankfunktionen) plus eine **Edge Function** als einziger Schreibzugang für eingehende Signale.
- **261 automatisierte Tests**, alle grün (Stand des letzten Laufs).
- **Case-Study-Seite**, zwei **Klickdummys** und zwei Videos als Präsentationsmaterial.

Hinweis zur Entstehung: Das Projekt wurde iterativ mit KI-Coding-Assistenten (Claude Code und Codex) unter meiner Anleitung gebaut. Die Architekturentscheidungen, das Testen mit echten Mails und das Debuggen sind meine Arbeit.

## 4. Der End-to-End-Ablauf (das Herzstück)

```
Kundenmail → n8n (Gmail Trigger) → KI klassifiziert → strenge Prüfung
   → Supabase (unbestätigtes Signal) → Inbox im Hub
   → Gate 1: CSM bestätigt den Account (Mensch)
   → Gate 2: CSM prüft und gibt die Maßnahme frei (Mensch)
   → n8n Approval-Workflow: Audit-Zeile, interne Mail, Kundenantwort als Entwurf/Testmail
```

Wichtige Regeln:
- **Gate 1 (Account bestätigen):** Die KI darf einen Account vorschlagen, entscheidet aber nie. Bis ein Mensch bestätigt, hat ein Signal **keinen Einfluss** auf Health Score oder Aktionen.
- **Health-Effekt nach Bestätigung, deterministisch:** Ein Risiko mit hoher Dringlichkeit senkt den Score um 10, andere Risiken um 5, Wachstumssignale ändern nichts.
- **Gate 2 (Review und Freigabe):** Der CSM bearbeitet Maßnahme und Begründung. Erst „Confirm & Send to Workflow“ startet den Approval-Workflow.
- **Die KI sendet nie an einen Kunden.** Die Kundenantwort wird mit der Klassifikation in **einem** KI-Aufruf vorformuliert; ein Mensch liest, ändert und sendet sie.
- Beide Gates sind **atomar abgesichert** (bedingtes Update in der Datenbank), sodass Doppelklicks oder parallele Klicks nie zwei Aktionen auslösen.

Realer Durchlauf, belegt durch Screenshots: eine Mail von „Alpenbank AG“ (Dashboard fällt vor einem Board-Meeting aus) wird als **Risk, negativ, hohe Dringlichkeit** erkannt, die KI schlägt Maßnahme, Begründung und Antwortentwurf vor, der Health Score sinkt nach der Bestätigung von 58 auf 48, die Freigabe löst alle n8n-Schritte aus.

## 5. Die drei n8n-Workflows

Alle drei sind veröffentlicht, verwenden Header- bzw. Token-Authentifizierung und haben Sticky Notes, die die Knoten in farbige Gruppen einteilen (Intake, KI, Speichern, Fehlerpfad).

### 5.1 Email Signal Ingestion
`Gmail Trigger (jede Minute) → Fetch full email → Guard and build AI prompt → Classify with AI → Validate AI output → Output valid? → Store unconfirmed signal / Log validation error`

- **Anti-Loop-Guard:** Die eigenen internen Mails des Hubs („[Action approved] …“) werden per festem Betreffcheck verworfen, **bevor** ein KI-Aufruf passiert. Das entscheidet bewusst keine KI.
- **KI-Schritt** (OpenRouter, mit 3 Wiederholungen und 3 Sekunden Pause, weil kostenlose Modelle kurz überlastet sein können): liefert Typ (risk, growth, routine), Stimmung, Dringlichkeit, Zusammenfassung, Zitat als Beleg, vorgeschlagene Maßnahme, Begründung und Antwortentwurf.
- **Validierung:** Die KI-Ausgabe gilt als **nicht vertrauenswürdig**. Ein Code-Knoten prüft erlaubte Werte und Längen. Ungültige Ausgaben werden protokolliert und verworfen, **nichts wird gespeichert**.
- **Speichern, nie handeln:** Gültige Signale gehen über eine tokengeschützte Edge Function in die Datenbank, als **unbestätigt**.

### 5.2 CS AI Hub Approval
`Webhook → Append row in sheet → Create a draft → Customer reply prepared? → Send a message → Respond to Webhook`

- Läuft **nur nach menschlicher Freigabe** (Gate 2). Die KI kann diesen Workflow nicht auslösen.
- **Audit:** Jede Freigabe wird mit Zeit, Account, CSM, Maßnahme, Kategorie und Begründung in ein Google Sheet geschrieben.
- **Interne Zusammenfassung** als schön formatierte HTML-Mail (Gmail-Entwurf).
- **IF-Guard „Customer reply prepared?“:** Nur wenn eine vorbereitete Kundenantwort mitkommt, wird sie gesendet. Reine KI-Freigaben (ohne Kundentext) überspringen diesen Schritt. **Beide Pfade sind in n8n-Ausführungen getestet.**
- **Antwortvertrag:** Der Workflow antwortet `{status: "sent", workflowConnected: true}`. Der Hub wertet nur diese explizite Bestätigung als Erfolg. Ein bloßes HTTP 200 genügt nicht, weil n8n auch bei einem internen Fehler 200 liefern kann.

### 5.3 CS AI Hub Analyse
`Webhook → AI Agent (OpenAI Chat Model) → Respond to Webhook`

- **Ein Vertrag für sechs KI-Modi:** Der Hub schickt System-Prompt, User-Prompt und Token-Budget, n8n gibt ein Feld zurück. Der AI Agent bleibt dadurch klein, die Logik liegt im Hub.
- Der Hub validiert die JSON-Antwort und wendet Leitplanken an, bevor der CSM etwas sieht.

## 6. Sicherheits- und Qualitätsmaßnahmen (Auswahl)

- Webhooks mit Header-Authentifizierung, Edge Function mit eigenem Token (mindestens 32 Zeichen), keine Schlüssel im Repository.
- Server-seitig geprüfte Anmeldung (Supabase Auth, nur freigegebene Admin-Adresse) für beide Gates und die Freigabe.
- Externe Aktionen sind **opt-in** (`ENABLE_EXTERNAL_ACTIONS`), damit lokale Tests nie versehentlich echte Mails oder Sheet-Zeilen erzeugen.
- Harte Regel im Hub: **keine Wachstumsaktion für Accounts mit hohem Risiko.**
- Jede KI-Ausgabe wird als „AI-generated“ gekennzeichnet; die Kundenversion eines QBR-Abschnitts bleibt vom CSM zu prüfen.
- 261 Tests, darunter neue Tests für Anmeldung, Gates, Aktivierung, Entwurf und Edge-Function-Eingang.

## 7. Was beim ersten echten Durchlauf schiefging (und was ich daraus gelernt habe)

Der erste Test mit einer echten E-Mail scheiterte mehrfach. Jeder Fehler war eine Lücke zwischen dem, was der Code tat, und dem, was tatsächlich lief:

1. **Eine Datenbankregel aus dem alten Design** lehnte den neuen Schritt „erst bestätigen, dann aktivieren“ ab. Die Speicherung scheiterte mit einer allgemeinen Fehlermeldung, bis ich die Regel selbst las.
2. **Code im Repository war nicht Code in Produktion:** Die Edge Function validierte noch die alte Nutzlast, und der lokale Server lief mit einer älteren Version.
3. **Google-Logins liefen nach 7 Tagen ab**, weil die OAuth-App im Testmodus war. Ich habe die Ursache behoben, nicht nur das Symptom.
4. **Das System darf seine eigene Post nicht lesen:** Ein fester Betreffcheck vor dem KI-Schritt verhindert, dass interne Benachrichtigungen als neue Kundensignale wieder eintreten.
5. **Kostenlose Cloud-Projekte pausieren sich selbst.** Die Datenbank schlief nach einer ruhigen Woche ein und musste aus dem Dashboard wieder gestartet werden. Das gehört auf die Checkliste vor jeder Demo.

Außerdem: Ein KI-Anbieter mit Kontingentlimit (HTTP 429) wurde durch einen anderen (OpenRouter) ersetzt, ohne den Rest zu ändern, weil die Anbieterwahl nur an einem Knoten hängt. Eine Sicherung des früheren Workflows mit OpenAI liegt bereit.

## 8. Ehrliche Grenzen (bitte so in der Bewerbung belassen)

- Es ist ein **Demo und Lernprojekt**, kein Produktivsystem. Alle Kunden, Personen und Nachrichten sind fiktiv.
- Die Kundenantwort geht in der Demo an ein **zweites Postfach**, das den Kunden simuliert. In Produktion wäre es ein Entwurf an den ursprünglichen Absender, den ein CSM sendet.
- Der Ingestion-Workflow nutzt aktuell ein **kostenloses OpenRouter-Modell**; der Analyse-Workflow nutzt OpenAI. Das Modell lässt sich an einem Knoten austauschen.
- Videos und Prototypen zeigen den **älteren Stand** (Portfolio, Matrix, KI-Features). Den neuen E-Mail-Fluss zeigen die Screenshots.
- Noch geplant: Slack-Alarm bei Schwellenwert, wöchentlicher Voice-of-Customer-Digest, ein Error-Workflow, der den Verantwortlichen benachrichtigt.

## 9. Links

> Die drei Artifact-Seiten (Case Study und beide Klickdummys) sind über ihren Link frei zugänglich. Der lokale Link funktioniert nur auf meinem Rechner.

| Was | Link |
|---|---|
| **Case Study** (Hauptseite mit Architektur, Screenshots, Videos, Lernstationen) | https://claude.ai/artifact/JwwsD8FEvDf5WxVBdpXJmg |
| **Klickdummy Hub** (Product Tour und AI Feature Tour) | https://claude.ai/artifact/UHd4SESuoxqyHK8YM7ZDtb |
| Klickdummy Hub, Direktstart der Product Tour | https://claude.ai/artifact/UHd4SESuoxqyHK8YM7ZDtb#tour |
| Klickdummy Hub, Direktstart der AI Feature Tour | https://claude.ai/artifact/UHd4SESuoxqyHK8YM7ZDtb#tour-ai |
| Klickdummy Hub, direkt zum Review-Formular (Gate 2) | https://claude.ai/artifact/UHd4SESuoxqyHK8YM7ZDtb#ai-review |
| **Klickdummy QBR** (mit Live-Adoptions-Simulation) | https://claude.ai/artifact/FkAoRy42trDBE2P6rb7ViY |
| Klickdummy QBR, Direktstart der Tour | https://claude.ai/artifact/FkAoRy42trDBE2P6rb7ViY#tour |
| **n8n-Workflows als JSON** (Ingestion und Analyse; Approval folgt) | https://github.com/ClaudiaL-21/customer-success-ai-hub/tree/sprint-15/customer-signal-intelligence/n8n |
| **Quellcode** | https://github.com/ClaudiaL-21/customer-success-ai-hub |
| **Lokale Anwendung** (nur auf meinem Rechner, Start mit `npm.cmd run dev:local`) | http://localhost:5173 |
| Technische Doku im Repo | `docs/06_n8n_integration.md`, `docs/15C_email_ingestion_payload_schema.md` |

## 10. Screenshots (liegen im Repo unter `docs/case-study/screenshots/`)

Reihenfolge entspricht dem Ablauf. Diese Bilder bitte bei der Bewerbung anhängen oder darauf verweisen.

| Datei | Zeigt |
|---|---|
| `live-inbox.png` | Inbox-Karte „Alpenbank AG“: Risk, hohe Dringlichkeit, bestätigter Account, Health-Effekt −10 (58 → 48), Button „Review action“ |
| `live-review.png` | Gate 2: KI-Vorschlag, editierbare Maßnahme und Begründung, „Confirm & Send to Workflow“ |
| `live-sent.png` | Nach der Freigabe: „Reviewed by CSM and sent to your n8n workflow“ |
| `live-internal-mail.png` | Interne „Action approved“-Mail, die n8n erzeugt |
| `live-customer-reply.png` | Vorbereitete Kundenantwort (von der KI entworfen, vom Menschen zu prüfen) |
| `wf-ingestion.png` | n8n: Email Signal Ingestion mit Notizen (Intake, KI, Speichern, Fehlerpfad) |
| `wf-approval.png` | n8n: Approval-Workflow mit Notizen (Stand vor dem IF-Guard; der Guard steht in Abschnitt 5.2) |
| `wf-analyze.png` | n8n: Analyse-Workflow mit Notizen |

Hinweis: Auf `live-customer-reply.png` ist mein Name zu sehen. Vor einer Veröffentlichung nach Wunsch zuschneiden.

## 11. Anweisungen an ChatGPT

Schreibe auf Basis dieses Dokuments eine **Bewerbung bei n8n** (Sprache und Stelle ergänze ich unten).

**Ziele der Bewerbung**
1. Zeigen, dass ich n8n nicht nur nutze, sondern **sinnvoll in eine Architektur einbette**: n8n als Ausführungsschicht, Mensch in der Schleife, KI nur als Vorschlag.
2. Auf die **Screenshots und Klickdummys** aufmerksam machen und konkret auf Links verweisen (Abschnitt 9 und 10).
3. Das **Lernen aus Fehlern** (Abschnitt 7) als Stärke darstellen.

**Tonalität:** konkret, bescheiden, auf Belege gestützt, ohne Marketingfloskeln. Kein Gedankenstrich-Stil, keine Aufzählung von Schlagwörtern.

**Pflicht:** Die Grenzen aus Abschnitt 8 nicht verschweigen (Demo, fiktive Daten, simuliertes Kundenpostfach). Ehrlich erwähnen, dass das Projekt mit KI-Coding-Assistenten unter meiner Anleitung entstand.

**Bitte liefere:**
- einen Anschreiben-Entwurf (maximal eine Seite),
- 3 bis 5 Stichpunkte für ein Bewerbungsformular („Warum n8n, was habe ich gebaut“),
- einen Vorschlag für einen kurzen Absatz, der die Links und Screenshots einführt.

**Zur Stelle:** Die Stellenanzeige, die Sprache und die Angaben zu meiner Person kennst du bereits aus diesem Gespräch. Nutze sie und passe die Bewerbung auf die Anforderungen der Anzeige an. Wähle aus diesem Dokument nur das aus, was zur Stelle passt, und frage nach, falls dir für das Anschreiben noch eine Angabe zu mir fehlt.
